import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import type Anthropic from "@anthropic-ai/sdk";
import { assertAppendOnly, createContractor, createTestEnv, RelayClient, startServer, type ScriptedReply, type TestEnv } from "./helpers.js";

type Msg = Anthropic.Beta.BetaMessageParam;

function lastToolResult(messages: Msg[]): Record<string, unknown> {
  const last = messages[messages.length - 1];
  const block = (last.content as Anthropic.Beta.BetaContentBlockParam[]).find((b) => b.type === "tool_result") as
    | Anthropic.Beta.BetaToolResultBlockParam
    | undefined;
  return JSON.parse(String(block?.content ?? "{}"));
}

const envs: TestEnv[] = [];

/** Replies are consumed in order, one per model request. */
function queue(t: TestEnv, replies: Array<ScriptedReply | ((messages: Msg[]) => ScriptedReply)>) {
  if (!envs.includes(t)) envs.push(t);
  t.llm.script = (messages) => {
    const next = replies.shift();
    if (!next) throw new Error("model called more times than scripted");
    return typeof next === "function" ? next(messages) : next;
  };
}

const servers: Array<{ close: () => Promise<void> }> = [];
const sockets: RelayClient[] = [];
afterEach(async () => {
  await Promise.all(sockets.splice(0).map((s) => s.close()));
  await Promise.all(servers.splice(0).map((s) => s.close()));
  // A failed expectation inside a scripted reply surfaces as a "model error" in the call; report it directly.
  const errors = envs.splice(0).flatMap((t) => t.llm.errors);
  if (errors.length) throw errors[0];
});

async function connect(port: number, callId: string, sid: string): Promise<RelayClient> {
  const relay = new RelayClient(port);
  sockets.push(relay);
  await relay.open();
  relay.setup(callId, sid);
  return relay;
}

async function placeCallFromForm(t: TestEnv, contractorKey: string, app: Parameters<typeof request>[0]) {
  await request(app).post(`/webhooks/website/${contractorKey}`).send({ name: "Jane Doe", phone: "512-867-5309", message: "Roof leak over the kitchen" });
  t.clock.advance(10_000);
  await t.deps.jobs.drain();
  const placed = t.telephony.calls.at(-1)!;
  const callId = new URL(placed.answerUrl).searchParams.get("callId")!;
  const call = t.repo.getCall(callId)!;
  return { callId, sid: call.twilioCallSid!, leadId: call.leadId };
}

describe("speed-to-lead call flow", () => {
  it("form → AI call in 10s → qualifies → transfer gets no answer → AI books on the calendar", async () => {
    const t = createTestEnv();
    const c = createContractor(t);
    t.repo.upsertCalendarConnection({ contractorId: c.id, provider: "google", accountEmail: "mike@summit.test", refreshToken: "x", accessToken: null, accessTokenExpiresAt: null });
    const srv = await startServer(t);
    servers.push(srv);
    const http = request(srv.app);

    const { callId, sid, leadId } = await placeCallFromForm(t, c.publicKey, srv.app);
    expect(t.telephony.calls[0]).toMatchObject({ to: "+15128675309", from: "+15125550100" });

    // Twilio fetches TwiML when Jane picks up.
    const answer = await http.post(`/twilio/voice/answer?callId=${callId}`).type("form").send({ CallSid: sid, CallStatus: "in-progress" });
    expect(answer.text).toContain('<ConversationRelay url="wss://stl.test/twilio/relay"');
    expect(answer.text).toContain(`<Parameter name="callId" value="${callId}"/>`);
    expect(answer.text).toContain(`action="https://stl.test/twilio/voice/handoff?callId=${callId}"`);

    queue(t, [
      { text: "Oh no, sorry to hear about the leak. ", tools: [{ name: "save_job_details", input: { service_needed: "roof repair", problem_details: "leak over the kitchen" } }] },
      (messages) => {
        expect(lastToolResult(messages)).toMatchObject({ saved: true, still_needed: ["property_address", "timeline"] });
        return { text: "What's the address of the property?" };
      },
      {
        tools: [
          { name: "save_job_details", input: { property_address: "123 Main St, Austin, TX 78701", timeline: "this week" } },
          { name: "transfer_to_team", input: { summary: "Jane Doe, roof leak over the kitchen at 123 Main St, wants it fixed this week.", say_to_caller: "Perfect, let me get Mike on the line for you. One sec!" } },
        ],
      },
    ]);

    const relay = await connect(srv.port, callId, sid);
    relay.say("Hello?");
    await relay.waitForSpoken("Hi, this is Ava, Summit Roofing's virtual assistant. Am I speaking with Jane?");
    expect(t.llm.requests).toHaveLength(0); // the opener is instant - no model round-trip

    relay.say("Yes this is Jane, my roof is leaking over the kitchen.");
    await relay.waitForSpoken("What's the address of the property?");
    relay.say("It's 123 Main Street in Austin, 78701. I need it fixed this week.");
    const end = await relay.waitFor((m) => m.type === "end");
    expect(JSON.parse(String(end.handoffData))).toEqual({ action: "transfer" });
    expect(relay.spokenSince(0)).toContain("Perfect, let me get Mike on the line for you.");
    await relay.close();

    // ConversationRelay ends -> Connect action -> we ring the owner with a whisper.
    const dial = await http.post(`/twilio/voice/handoff?callId=${callId}`).type("form").send({ CallSid: sid, HandoffData: end.handoffData });
    expect(dial.text).toMatch(/<Dial action="https:\/\/stl\.test\/twilio\/voice\/dial-result\?callId=[^"]+&amp;idx=0" method="POST" timeout="18" callerId="\+15125550100">/);
    expect(dial.text).toContain(">+15125550111</Number>");
    expect(t.repo.getLead(leadId)!.status).toBe("transferring");

    const whisper = await http.post(`/twilio/voice/whisper?callId=${callId}&idx=0`).type("form").send({ CallSid: "CA-owner-leg" });
    expect(whisper.text).toContain("New website lead for Summit Roofing: Jane Doe. Jane Doe, roof leak over the kitchen at 123 Main St");
    expect(whisper.text).toContain("<Gather");

    // Mike doesn't press 1 (voicemail or busy) -> the AI picks Jane back up to book.
    const back = await http.post(`/twilio/voice/dial-result?callId=${callId}&idx=0`).type("form").send({ CallSid: sid, CallStatus: "in-progress", DialCallStatus: "no-answer" });
    expect(back.text).toContain("<ConversationRelay");
    expect(back.text).toContain('welcomeGreeting="Thanks for holding! Looks like Mike is tied up on a job right now');

    let slotId = "";
    queue(t, [
      (messages) => {
        const last = messages[messages.length - 1].content as Anthropic.Beta.BetaContentBlockParam[];
        const results = last.filter((b) => b.type === "tool_result") as Anthropic.Beta.BetaToolResultBlockParam[];
        expect(results).toHaveLength(2); // the held-back save_job_details result + the transfer outcome
        expect(String(results[1].content)).toContain("Nobody on the team picked up");
        expect(last.at(-1)).toEqual({ type: "text", text: "Thursday morning works." });
        return { tools: [{ name: "check_availability", input: { preferred_date: "2026-10-22", time_of_day: "morning" } }] };
      },
      (messages) => {
        const result = lastToolResult(messages) as { mode: string; slots: Array<{ slot_id: string; when: string }> };
        expect(result.mode).toBe("calendar");
        expect(result.slots.map((s) => s.when)).toEqual([
          "Thursday, October 22 at 8:00 AM",
          "Thursday, October 22 at 11:00 AM",
          "Friday, October 23 at 8:00 AM",
          "Friday, October 23 at 11:00 AM",
        ]);
        slotId = result.slots[0].slot_id;
        return { text: "I have Thursday at eight or eleven in the morning. Which works better?" };
      },
      () => ({ tools: [{ name: "book_appointment", input: { slot_id: slotId, address: "123 Main St, Austin, TX 78701", notes: "Leak over kitchen" } }] }),
      (messages) => {
        expect(lastToolResult(messages)).toMatchObject({ booked: true, when: "Thursday, October 22 at 8:00 AM", confirmed_on_calendar: true });
        return { text: "You're all set for Thursday at eight AM at 123 Main Street. You'll get a text confirmation. Anything else?" };
      },
      { tools: [{ name: "end_call", input: { outcome: "completed", closing_line: "Thanks Jane, have a great day!" } }] },
    ]);

    const relay2 = await connect(srv.port, callId, sid);
    relay2.say("Thursday morning works.");
    await relay2.waitForSpoken("Which works better?");
    expect(relay2.spokenSince(0)).toContain("Let me take a look at the schedule."); // filler while the calendar loads
    relay2.say("Eight works.");
    await relay2.waitForSpoken("Anything else?");
    relay2.say("No, that's it. Thanks!");
    const end2 = await relay2.waitFor((m) => m.type === "end");
    expect(JSON.parse(String(end2.handoffData))).toEqual({ action: "hangup" });
    expect(relay2.spokenSince(0)).toContain("Thanks Jane, have a great day!");
    await relay2.close();

    expect((await http.post(`/twilio/voice/handoff?callId=${callId}`).type("form").send({ CallSid: sid, HandoffData: end2.handoffData })).text).toContain("<Hangup/>");
    await http.post(`/twilio/voice/status?callId=${callId}`).type("form").send({ CallSid: sid, CallStatus: "completed", CallDuration: "184" });
    await t.deps.jobs.drain();

    const lead = t.repo.getLead(leadId)!;
    expect(lead.status).toBe("booked");
    expect(lead.appointmentStart).toBe("2026-10-22T13:00:00.000Z"); // 8:00am Chicago
    expect(lead.details).toMatchObject({ service_needed: "roof repair", property_address: "123 Main St, Austin, TX 78701", timeline: "this week" });
    expect(lead.summary).toMatch(/Test summary/);

    expect(t.calendarBackend.events).toHaveLength(1);
    expect(t.calendarBackend.events[0]).toMatchObject({ summary: "Free estimate: Jane Doe", location: "123 Main St, Austin, TX 78701" });

    const call = t.repo.getCall(callId)!;
    expect(call).toMatchObject({ outcome: "booked", phase: "ended", durationSeconds: 184 });
    const roles = call.transcript.map((x) => x.role);
    expect(roles[0]).toBe("caller");
    expect(call.transcript.some((x) => x.text.startsWith("Thanks for holding!"))).toBe(true);

    const toJane = t.telephony.sms.filter((s) => s.to === "+15128675309").map((s) => s.body);
    expect(toJane[0]).toMatch(/calling you right now/);
    expect(toJane[1]).toMatch(/^You're all set, Jane! Summit Roofing will see you Thu Oct 22, 8:00 AM at 123 Main St/);
    const toMike = t.telephony.sms.filter((s) => s.to === "+15125550111").map((s) => s.body);
    expect(toMike.some((b) => b.startsWith("BOOKED: Thu Oct 22, 8:00 AM"))).toBe(true);

    expect(t.repo.pendingJobsForLead(leadId).filter((j) => j.type === "call_lead")).toHaveLength(0);
    // The whole conversation, across both relay sessions, only ever appended to history.
    assertAppendOnly(t.llm.requests);
    expect(t.llm.requests.every((r) => JSON.stringify(r.system) === JSON.stringify(t.llm.requests[0].system))).toBe(true);
  });

  it("owner presses 1: the lead is bridged and marked transferred", async () => {
    const t = createTestEnv();
    const c = createContractor(t, { transferTargets: [{ name: "Mike", role: "Owner", phone: "+15125550111" }, { name: "Sara", role: "Manager", phone: "+15125550122" }] });
    const srv = await startServer(t);
    servers.push(srv);
    const http = request(srv.app);
    const { callId, sid, leadId } = await placeCallFromForm(t, c.publicKey, srv.app);

    queue(t, [{ tools: [{ name: "transfer_to_team", input: { summary: "Jane, roof leak.", say_to_caller: "Connecting you now!" } }] }]);
    const relay = await connect(srv.port, callId, sid);
    relay.say("Hello?");
    await relay.waitForSpoken("Am I speaking with Jane?");
    relay.say("Yes, I need someone out today, it's pouring in.");
    await relay.waitFor((m) => m.type === "end");

    await http.post(`/twilio/voice/handoff?callId=${callId}`).type("form").send({ CallSid: sid, HandoffData: '{"action":"transfer"}' });
    // Mike doesn't answer -> Sara is next.
    const next = await http.post(`/twilio/voice/dial-result?callId=${callId}&idx=0`).type("form").send({ CallSid: sid, CallStatus: "in-progress", DialCallStatus: "no-answer" });
    expect(next.text).toContain(">+15125550122</Number>");
    expect(next.text).toContain("idx=1");
    // Hanging up during the whisper doesn't count as accepting.
    expect((await http.post(`/twilio/voice/whisper-accept?callId=${callId}&idx=1`).type("form").send({ Digits: "" })).text).toContain("<Hangup/>");
    expect((await http.post(`/twilio/voice/whisper-accept?callId=${callId}&idx=1`).type("form").send({ Digits: "1" })).text).toBe('<?xml version="1.0" encoding="UTF-8"?><Response/>');
    const done = await http.post(`/twilio/voice/dial-result?callId=${callId}&idx=1`).type("form").send({ CallSid: sid, CallStatus: "in-progress", DialCallStatus: "completed" });
    expect(done.text).toContain("<Hangup/>");

    await http.post(`/twilio/voice/status?callId=${callId}`).type("form").send({ CallSid: sid, CallStatus: "completed", CallDuration: "300" });
    await t.deps.jobs.drain();
    expect(t.repo.getLead(leadId)!.status).toBe("transferred");
    expect(t.repo.getCall(callId)!.outcome).toBe("transferred");
    expect(t.telephony.sms.some((s) => s.to === "+15125550111" && s.body.startsWith("Call summary"))).toBe(true);
  });

  it("outside office hours the AI books instead of transferring", async () => {
    const t = createTestEnv({}, "2026-10-25T17:00:00.000Z"); // Sunday noon: calling hours yes, transfer hours no
    const c = createContractor(t);
    const srv = await startServer(t);
    servers.push(srv);
    const { callId, sid } = await placeCallFromForm(t, c.publicKey, srv.app);

    queue(t, [
      (messages) => {
        const context = String(messages[0].content);
        expect(context).toContain("Live transfer: NOT available on this call (it's outside office hours)");
        expect(context).toContain("Appointments: no calendar connected");
        return { tools: [{ name: "transfer_to_team", input: { summary: "x", say_to_caller: "One sec" } }] };
      },
      (messages) => {
        expect(lastToolResult(messages)).toMatchObject({ transferred: false });
        return { text: "The office is closed today, but I can get you on the schedule. What day works?" };
      },
    ]);
    const relay = await connect(srv.port, callId, sid);
    relay.say("Hello?");
    await relay.waitForSpoken("Jane?");
    relay.say("Yeah, can I talk to someone?");
    await relay.waitForSpoken("What day works?");
    expect(relay.received.some((m) => m.type === "end")).toBe(false);
  });

  it("caller interrupts: history keeps only what they heard and stays append-only", async () => {
    const t = createTestEnv();
    const c = createContractor(t);
    const srv = await startServer(t);
    servers.push(srv);
    const { callId, sid } = await placeCallFromForm(t, c.publicKey, srv.app);

    queue(t, [
      { text: "This reply is slow and will be cut off.", delayMs: 400 },
      (messages) => {
        // The aborted turn was never recorded; both utterances reach the model.
        const users = messages.filter((m) => m.role === "user");
        expect(JSON.stringify(users.slice(-2))).toContain("Actually wait");
        return { text: "Sure, take your time. What's going on with the roof?" };
      },
      (messages) => {
        expect(JSON.stringify(messages.at(-1)!.content)).toContain('They only heard: \\"Sure, take your time.\\"');
        return { text: "Got it." };
      },
    ]);
    const relay = await connect(srv.port, callId, sid);
    relay.say("Hello?");
    await relay.waitForSpoken("Jane?");
    relay.say("Yes.");
    await new Promise((r) => setTimeout(r, 50));
    relay.say("Actually wait, one second.");
    await relay.waitForSpoken("What's going on with the roof?");
    relay.send({ type: "interrupt", utteranceUntilInterrupt: "Sure, take your time.", durationUntilInterruptMs: "900" });
    relay.say("It's leaking.");
    await relay.waitForSpoken("Got it.");
    assertAppendOnly(t.llm.requests);
  });
});

describe("when the lead doesn't pick up", () => {
  it("voicemail on the first miss, missed-call text, then re-dials on schedule until out of attempts", async () => {
    const t = createTestEnv();
    const c = createContractor(t, { retryDelaysMinutes: [2, 20] });
    const srv = await startServer(t);
    servers.push(srv);
    const http = request(srv.app);
    const { callId, sid, leadId } = await placeCallFromForm(t, c.publicKey, srv.app);

    // Answering machine picks up.
    await http.post(`/twilio/voice/amd?callId=${callId}`).type("form").send({ CallSid: sid, AnsweredBy: "machine_end_beep" });
    expect(t.telephony.updates).toHaveLength(1);
    expect(t.telephony.updates[0].twiml).toContain("Hi Jane, this is Ava with Summit Roofing.");
    expect(t.telephony.updates[0].twiml).toContain("5 1 2, 5 5 5, 0 1 0 0");
    await http.post(`/twilio/voice/status?callId=${callId}`).type("form").send({ CallSid: sid, CallStatus: "completed", CallDuration: "31" });
    await t.deps.jobs.drain();
    expect(t.repo.getCall(callId)!.outcome).toBe("voicemail");
    expect(t.repo.getLead(leadId)!.status).toBe("retry_scheduled");
    expect(t.telephony.sms.filter((s) => s.to === "+15128675309").at(-1)!.body).toMatch(/We just tried calling/);

    // Retry 1 after 2 minutes: no answer at all.
    t.clock.advance(2 * 60_000);
    await t.deps.jobs.drain();
    expect(t.telephony.calls).toHaveLength(2);
    const call2 = t.repo.getCallBySid(`CA${"2".padStart(32, "0")}`)!;
    expect(call2.attempt).toBe(2);
    await http.post(`/twilio/voice/status?callId=${call2.id}`).type("form").send({ CallSid: call2.twilioCallSid, CallStatus: "no-answer" });
    expect(t.repo.getLead(leadId)!.status).toBe("retry_scheduled");

    // Retry 2 after 20 more minutes: voicemail again, but only the first miss leaves one.
    t.clock.advance(20 * 60_000);
    await t.deps.jobs.drain();
    const call3 = t.repo.getCallBySid(`CA${"3".padStart(32, "0")}`)!;
    await http.post(`/twilio/voice/amd?callId=${call3.id}`).type("form").send({ CallSid: call3.twilioCallSid, AnsweredBy: "machine_end_silence" });
    expect(t.telephony.hangups).toContain(call3.twilioCallSid);
    await http.post(`/twilio/voice/status?callId=${call3.id}`).type("form").send({ CallSid: call3.twilioCallSid, CallStatus: "completed" });
    await t.deps.jobs.drain();
    expect(t.repo.getLead(leadId)!.status).toBe("unreachable");
    expect(t.telephony.sms.some((s) => s.to === "+15125550111" && /Couldn't reach Jane Doe .* after 3 call attempts/.test(s.body))).toBe(true);
  });

  it("asked to call back later: schedules the callback at their time", async () => {
    const t = createTestEnv();
    const c = createContractor(t);
    const srv = await startServer(t);
    servers.push(srv);
    const { callId, sid, leadId } = await placeCallFromForm(t, c.publicKey, srv.app);
    queue(t, [{ tools: [{ name: "end_call", input: { outcome: "call_back_later", closing_line: "No problem, talk at 5!", callback_time: "2026-10-20T17:00" } }] }]);
    const relay = await connect(srv.port, callId, sid);
    relay.say("Hello?");
    await relay.waitForSpoken("Jane?");
    relay.say("I'm driving, call me at 5.");
    await relay.waitFor((m) => m.type === "end");
    const lead = t.repo.getLead(leadId)!;
    expect(lead.status).toBe("callback_scheduled");
    const job = t.repo.pendingJobsForLead(leadId).find((j) => j.type === "call_lead")!;
    expect(job.runAt).toBe("2026-10-20T22:00:00.000Z"); // 5pm Chicago
    expect(job.payload.reason).toBe("callback");
  });

  it("do-not-call requests stick", async () => {
    const t = createTestEnv();
    const c = createContractor(t);
    const srv = await startServer(t);
    servers.push(srv);
    const http = request(srv.app);
    const { callId, sid, leadId } = await placeCallFromForm(t, c.publicKey, srv.app);
    queue(t, [{ tools: [{ name: "end_call", input: { outcome: "do_not_call", closing_line: "Understood, we won't call again. Sorry to bother you." } }] }]);
    const relay = await connect(srv.port, callId, sid);
    relay.say("Hello?");
    await relay.waitForSpoken("Jane?");
    relay.say("Take me off your list.");
    await relay.waitFor((m) => m.type === "end");
    await http.post(`/twilio/voice/status?callId=${callId}`).type("form").send({ CallSid: sid, CallStatus: "completed", CallDuration: "20" });
    await t.deps.jobs.drain();
    expect(t.repo.getLead(leadId)!.status).toBe("do_not_call");
    t.clock.advance(3 * 3_600_000);
    await t.deps.jobs.drain();
    expect(t.telephony.calls).toHaveLength(1);
  });

  it("STOP texts opt the lead out", async () => {
    const t = createTestEnv();
    const c = createContractor(t);
    const srv = await startServer(t);
    servers.push(srv);
    await request(srv.app).post(`/webhooks/website/${c.publicKey}`).send({ name: "Jane Doe", phone: "512-867-5309" });
    const res = await request(srv.app).post("/twilio/sms/inbound").type("form").send({ From: "+15128675309", To: "+15125550100", Body: "STOP" });
    expect(res.text).toContain("<Response/>");
    const lead = t.repo.listLeads({ contractorId: c.id })[0];
    expect(lead.status).toBe("do_not_call");
    t.clock.advance(15_000);
    await t.deps.jobs.drain();
    expect(t.telephony.calls).toHaveLength(0);
  });

  it("a lead calling back is answered by the AI with their details", async () => {
    const t = createTestEnv();
    const c = createContractor(t);
    const srv = await startServer(t);
    servers.push(srv);
    await request(srv.app).post(`/webhooks/website/${c.publicKey}`).send({ name: "Jane Doe", phone: "512-867-5309" });
    const res = await request(srv.app).post("/twilio/voice/inbound").type("form").send({ From: "+15128675309", To: "+15125550100", CallSid: "CAinbound" });
    expect(res.text).toContain('welcomeGreeting="Thanks for calling Summit Roofing! This is Ava, the virtual assistant. Is this Jane?"');
    const lead = t.repo.listLeads({ contractorId: c.id })[0];
    // Their pending outbound call is canceled - they're already on the line.
    expect(t.repo.pendingJobsForLead(lead.id).filter((j) => j.type === "call_lead")).toHaveLength(0);
    const call = t.repo.getCallBySid("CAinbound")!;
    queue(t, [
      (messages) => {
        expect(String(messages[0].content)).toContain("This call: inbound");
        expect(messages[1]).toEqual({ role: "assistant", content: "Thanks for calling Summit Roofing! This is Ava, the virtual assistant. Is this Jane?" });
        return { text: "Great, thanks for calling back! What can we help with?" };
      },
    ]);
    const relay = await connect(srv.port, call.id, "CAinbound");
    relay.say("Yes, you guys called me earlier.");
    await relay.waitForSpoken("What can we help with?");
  });
});
