import { describe, expect, it } from "vitest";
import request from "supertest";
import twilio from "twilio";
import { createApp } from "../src/app.js";
import { TwilioTelephony } from "../src/voice/telephony.js";
import { createContractor, createTestEnv } from "./helpers.js";

const AUTH = "Basic " + Buffer.from("admin:password123").toString("base64");

async function session(app: Parameters<typeof request>[0]) {
  const res = await request(app).get("/admin").set("Authorization", AUTH);
  const cookie = String(res.headers["set-cookie"]).split(";")[0];
  return { cookie, csrf: cookie.split("=")[1] };
}

describe("admin dashboard", () => {
  it("requires the admin password", async () => {
    const t = createTestEnv();
    const { app } = createApp(t.deps);
    expect((await request(app).get("/admin")).status).toBe(401);
    const wrong = "Basic " + Buffer.from("admin:nope").toString("base64");
    expect((await request(app).get("/admin").set("Authorization", wrong)).status).toBe(401);
    expect((await request(app).get("/admin").set("Authorization", AUTH)).status).toBe(200);
  });

  it("rejects form posts without the CSRF token", async () => {
    const t = createTestEnv();
    const { app } = createApp(t.deps);
    const { cookie } = await session(app);
    const res = await request(app).post("/admin/contractors").set("Authorization", AUTH).set("Cookie", cookie).type("form").send({ name: "X" });
    expect(res.status).toBe(403);
    expect(t.repo.listContractors()).toHaveLength(0);
  });

  it("creates a contractor, saves settings, and sends a test lead", async () => {
    const t = createTestEnv();
    const { app } = createApp(t.deps);
    const { cookie, csrf } = await session(app);
    const post = (path: string, body: Record<string, string>) =>
      request(app).post(path).set("Authorization", AUTH).set("Cookie", cookie).type("form").send({ _csrf: csrf, ...body });

    const created = await post("/admin/contractors", { name: "Peak Plumbing", timezone: "America/Denver", twilioNumber: "(720) 555-0100" });
    expect(created.status).toBe(303);
    const c = t.repo.listContractors()[0];
    expect(c).toMatchObject({ name: "Peak Plumbing", timezone: "America/Denver", twilioNumber: "+17205550100" });

    const page = await request(app).get(`/admin/contractors/${c.id}`).set("Authorization", AUTH).set("Cookie", cookie);
    expect(page.status).toBe(200);
    expect(page.text).toContain(`https://stl.test/webhooks/google-ads/${c.id}`);
    expect(page.text).toContain(`https://stl.test/embed/${c.publicKey}.js`);

    const saved = await post(`/admin/contractors/${c.id}/settings`, {
      name: "Peak Plumbing",
      timezone: "America/Denver",
      twilioNumber: "+17205550100",
      active: "1",
      services: "plumbing and water heaters",
      assistantName: "Max",
      callDelaySeconds: "15",
      callingHours: "mon-sat 08:00-20:00",
      transferHours: "mon-fri 07:00-17:00",
      bookingHours: "mon-fri 08:00-16:00",
      transferTargets: "Dana Ruiz | Owner | 720-555-0111\nLee | Office Manager | 720-555-0122",
      questions: "issue | What's the plumbing problem? | required\nwater_heater_age | How old is the water heater? | optional",
      retryDelaysMinutes: "3, 30",
      durationMinutes: "45",
      voicemail: "never",
      sms_instantReply: "1",
      sms_teamAlerts: "1",
      alertPhones: "",
      webhookUrl: "",
    });
    expect(saved.status).toBe(303);
    expect(saved.headers.location).toMatch(/ok=Settings/);
    const s = t.repo.getContractor(c.id)!.settings;
    expect(s.transferTargets).toEqual([
      { name: "Dana Ruiz", role: "Owner", phone: "+17205550111" },
      { name: "Lee", role: "Office Manager", phone: "+17205550122" },
    ]);
    expect(s.questions.map((q) => [q.key, q.required])).toEqual([
      ["issue", true],
      ["water_heater_age", false],
    ]);
    expect(s.callingHours.sun).toEqual([]);
    expect(s.transferHours.mon).toEqual([["07:00", "17:00"]]);
    expect(s).toMatchObject({ assistantName: "Max", callDelaySeconds: 15, retryDelaysMinutes: [3, 30], voicemail: "never" });
    expect(s.booking.durationMinutes).toBe(45);
    expect(s.sms).toEqual({ instantReply: true, missedCall: false, bookingConfirmation: false, teamAlerts: true });

    const bad = await post(`/admin/contractors/${c.id}/settings`, { name: "Peak Plumbing", timezone: "America/Denver", callingHours: "funday 9-5" });
    expect(bad.headers.location).toMatch(/error=/);

    const test = await post(`/admin/contractors/${c.id}/test-lead`, { name: "Tess", phone: "+17205550199", message: "Burst pipe" });
    expect(test.status).toBe(303);
    const lead = t.repo.listLeads({ contractorId: c.id })[0];
    expect(lead).toMatchObject({ source: "test", name: "Tess", phone: "+17205550199" });
    const leadPage = await request(app).get(`/admin/leads/${lead.id}`).set("Authorization", AUTH).set("Cookie", cookie);
    expect(leadPage.status).toBe(200);
    expect(leadPage.text).toContain("Burst pipe");

    const configured = await post(`/admin/contractors/${c.id}/twilio-configure`, {});
    expect(configured.headers.location).toMatch(/ok=/);
    expect(t.telephony.configured[0]).toEqual({
      phoneNumber: "+17205550100",
      voiceUrl: "https://stl.test/twilio/voice/inbound",
      statusCallbackUrl: "https://stl.test/twilio/voice/status",
      smsUrl: "https://stl.test/twilio/sms/inbound",
    });
  });

  it("escapes lead data in pages", async () => {
    const t = createTestEnv();
    const c = createContractor(t);
    const lead = t.repo.createLead({ contractorId: c.id, source: "website", status: "new", name: "<script>alert(1)</script>" });
    const { app } = createApp(t.deps);
    const page = await request(app).get(`/admin/leads/${lead.id}`).set("Authorization", AUTH);
    expect(page.text).not.toContain("<script>alert(1)</script>");
    expect(page.text).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});

describe("Twilio webhook signatures", () => {
  it("only accepts requests Twilio signed", async () => {
    const t = createTestEnv({ TWILIO_VALIDATE_SIGNATURES: "true", TWILIO_ACCOUNT_SID: "AC123", TWILIO_AUTH_TOKEN: "auth-token-123" });
    t.deps.telephony = new TwilioTelephony(t.config);
    const { app } = createApp(t.deps);
    const params = { CallSid: "CA1", CallStatus: "ringing" };
    const url = "https://stl.test/twilio/voice/status?callId=nope";
    expect((await request(app).post("/twilio/voice/status?callId=nope").type("form").send(params)).status).toBe(403);
    const signature = twilio.getExpectedTwilioSignature("auth-token-123", url, params);
    const ok = await request(app).post("/twilio/voice/status?callId=nope").set("X-Twilio-Signature", signature).type("form").send(params);
    expect(ok.status).toBe(204);
  });
});
