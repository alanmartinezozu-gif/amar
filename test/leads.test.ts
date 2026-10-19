import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { hmacSha256Hex, encrypt } from "../src/lib/crypto.js";
import { ingestLead, extractContactFields } from "../src/leads/intake.js";
import { mapFacebookLead, verifyFacebookSignature } from "../src/sources/facebook.js";
import { mapGoogleLead } from "../src/sources/googleAds.js";
import { createContractor, createTestEnv } from "./helpers.js";

describe("lead intake", () => {
  it("stores the lead, texts them, and queues the AI call 10 seconds out", async () => {
    const t = createTestEnv();
    const c = createContractor(t);
    const { lead, outcome, callAt } = ingestLead(t.deps, c, { source: "website", name: "jane doe", phone: "512-867-5309", answers: { message: "Leak" } });
    expect(outcome).toBe("created");
    expect(lead.phone).toBe("+15128675309");
    expect(lead.status).toBe("new");
    expect(callAt!.getTime() - t.clock.now().getTime()).toBe(10_000);

    const jobs = t.repo.pendingJobsForLead(lead.id);
    expect(jobs.map((j) => j.type)).toContain("call_lead");

    await t.deps.jobs.drain(); // sms jobs are due now; the call isn't due yet
    expect(t.telephony.calls).toHaveLength(0);
    expect(t.telephony.sms.find((s) => s.to === "+15128675309")?.body).toMatch(/^Hi Jane! Thanks for reaching out to Summit Roofing\. Ava .* calling you right now/);
    expect(t.telephony.sms.find((s) => s.to === "+15125550111")?.body).toMatch(/New website lead: jane doe/);

    t.clock.advance(10_000);
    await t.deps.jobs.drain();
    expect(t.telephony.calls).toHaveLength(1);
    expect(t.telephony.calls[0]).toMatchObject({ to: "+15128675309", from: "+15125550100" });
    expect(t.repo.getLead(lead.id)!.status).toBe("calling");
  });

  it("waits for calling hours when the form comes in at night", () => {
    const t = createTestEnv({}, "2026-10-21T04:30:00.000Z"); // 11:30pm Chicago
    const c = createContractor(t);
    const { lead, callAt } = ingestLead(t.deps, c, { source: "facebook", name: "Sam", phone: "5128675309" });
    expect(lead.status).toBe("scheduled");
    expect(callAt!.toISOString()).toBe("2026-10-21T13:00:00.000Z"); // 8:00am Chicago
  });

  it("merges a second submission from the same phone instead of calling twice", () => {
    const t = createTestEnv();
    const c = createContractor(t);
    const first = ingestLead(t.deps, c, { source: "facebook", externalId: "fb1", name: "Sam", phone: "5128675309" });
    const second = ingestLead(t.deps, c, { source: "website", name: "Sam", phone: "(512) 867-5309", email: "sam@example.com", answers: { roof: "metal" } });
    expect(second.outcome).toBe("duplicate");
    expect(second.lead.id).toBe(first.lead.id);
    expect(second.lead.email).toBe("sam@example.com");
    expect(second.lead.formAnswers.roof).toBe("metal");
    expect(t.repo.pendingJobsForLead(first.lead.id).filter((j) => j.type === "call_lead")).toHaveLength(1);
  });

  it("is idempotent for webhook retries with the same external id", () => {
    const t = createTestEnv({});
    const c = createContractor(t, { dedupeMinutes: 0 });
    const a = ingestLead(t.deps, c, { source: "google", externalId: "g-1", phone: "5128675309" });
    const b = ingestLead(t.deps, c, { source: "google", externalId: "g-1", phone: "5128675309" });
    expect(b.outcome).toBe("existing");
    expect(b.lead.id).toBe(a.lead.id);
  });

  it("flags leads without a dialable phone for the team", async () => {
    const t = createTestEnv();
    const c = createContractor(t);
    const { lead } = ingestLead(t.deps, c, { source: "website", name: "No Phone", phone: "123" });
    expect(lead.status).toBe("invalid_phone");
    await t.deps.jobs.drain();
    expect(t.telephony.sms.some((s) => s.to === "+15125550111" && /no valid phone/.test(s.body))).toBe(true);
    expect(t.telephony.calls).toHaveLength(0);
  });
});

describe("field mapping", () => {
  it("pulls contact fields out of arbitrary form keys", () => {
    const f = extractContactFields({ "Full Name": "Ann Lee", "Phone Number": "5125550123", "E-mail": "a@b.co", Street: "1 Main St", City: "Austin", State: "TX", "Zip Code": "78701", "Roof type": "Shingle" });
    expect(f).toMatchObject({ name: "Ann Lee", phone: "5125550123", email: "a@b.co", address: "1 Main St, Austin, TX 78701", zip: "78701" });
    expect(f.answers).toEqual({ "Roof type": "Shingle" });
  });

  it("maps a Facebook lead", () => {
    const lead = mapFacebookLead({
      id: "123",
      field_data: [
        { name: "full_name", values: ["Ann Lee"] },
        { name: "phone_number", values: ["+15125550123"] },
        { name: "zip_code", values: ["78701"] },
        { name: "what_kind_of_project?", values: ["Full replacement"] },
      ],
      campaign_name: "Roofing Fall",
      platform: "ig",
    });
    expect(lead).toMatchObject({ source: "facebook", externalId: "123", name: "Ann Lee", phone: "+15125550123", zip: "78701" });
    expect(lead.answers).toEqual({ "what_kind_of_project?": "Full replacement" });
    expect(lead.metadata).toMatchObject({ campaignName: "Roofing Fall", platform: "ig" });
  });

  it("maps a Google Ads lead", () => {
    const lead = mapGoogleLead({
      lead_id: "L1",
      google_key: "k",
      is_test: true,
      user_column_data: [
        { column_id: "FULL_NAME", string_value: "Bo Diaz" },
        { column_id: "PHONE_NUMBER", string_value: "+15125550199" },
        { column_id: "STREET_ADDRESS", string_value: "9 Oak Ln" },
        { column_id: "CITY", string_value: "Round Rock" },
        { column_id: "POSTAL_CODE", string_value: "78664" },
        { column_id: "What_service?", column_name: "What service do you need?", string_value: "Gutters" },
      ],
    });
    expect(lead).toMatchObject({ source: "google", externalId: "L1", name: "Bo Diaz", phone: "+15125550199", address: "9 Oak Ln, Round Rock, 78664" });
    expect(lead.answers).toEqual({ "What service do you need?": "Gutters" });
    expect(lead.metadata?.isTest).toBe(true);
  });
});

describe("webhooks", () => {
  it("website form: CORS, JSON thank-you, honeypot, unknown key", async () => {
    const t = createTestEnv();
    const c = createContractor(t);
    const { app } = createApp(t.deps);

    const pre = await request(app).options(`/webhooks/website/${c.publicKey}`);
    expect(pre.status).toBe(204);
    expect(pre.headers["access-control-allow-origin"]).toBe("*");

    const res = await request(app).post(`/webhooks/website/${c.publicKey}`).send({ name: "Jo", phone: "5128675309", utm_source: "nextdoor", _page: "https://x.test/roofing" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, message: c.settings.thankYouMessage });
    const lead = t.repo.listLeads({ contractorId: c.id })[0];
    expect(lead.metadata).toMatchObject({ utm_source: "nextdoor", page: "https://x.test/roofing" });
    expect(lead.formAnswers).toEqual({});

    const bot = await request(app).post(`/webhooks/website/${c.publicKey}`).send({ name: "Bot", phone: "5125550123", _hp: "gotcha" });
    expect(bot.status).toBe(200);
    expect(t.repo.listLeads({ contractorId: c.id })).toHaveLength(1);

    expect((await request(app).post("/webhooks/website/pk_nope").send({ phone: "5125550123" })).status).toBe(404);
  });

  it("website form without JavaScript gets a thank-you page or redirect", async () => {
    const t = createTestEnv();
    const c = createContractor(t);
    const { app } = createApp(t.deps);
    const page = await request(app).post(`/webhooks/website/${c.publicKey}`).set("Accept", "text/html").type("form").send({ name: "Jo", phone: "5128675309" });
    expect(page.status).toBe(200);
    expect(page.text).toContain(c.settings.thankYouMessage);
    const redirect = await request(app)
      .post(`/webhooks/website/${c.publicKey}`)
      .set("Accept", "text/html")
      .type("form")
      .send({ name: "Al", phone: "5125550123", _redirect: "https://summit.test/thanks" });
    expect(redirect.status).toBe(303);
    expect(redirect.headers.location).toBe("https://summit.test/thanks");
  });

  it("serves the embed script and hosted form", async () => {
    const t = createTestEnv();
    const c = createContractor(t);
    const { app } = createApp(t.deps);
    const js = await request(app).get(`/embed/${c.publicKey}.js`);
    expect(js.status).toBe(200);
    expect(js.headers["content-type"]).toMatch(/javascript/);
    expect(js.text).toContain(`https://stl.test/webhooks/website/${c.publicKey}`);
    expect(js.text).toContain(JSON.stringify(c.settings.thankYouMessage).slice(1, -1));
    const page = await request(app).get(`/f/${c.publicKey}`);
    expect(page.text).toContain("data-speed-to-lead-form");
  });

  it("Google Ads: checks the key and ingests", async () => {
    const t = createTestEnv();
    const c = createContractor(t);
    const { app } = createApp(t.deps);
    const body = { lead_id: "G-9", user_column_data: [{ column_id: "PHONE_NUMBER", string_value: "+15128675309" }] };
    expect((await request(app).post(`/webhooks/google-ads/${c.id}`).send({ ...body, google_key: "wrong" })).status).toBe(403);
    const ok = await request(app).post(`/webhooks/google-ads/${c.id}`).send({ ...body, google_key: c.googleAdsKey });
    expect(ok.status).toBe(200);
    expect(t.repo.findLeadByExternalId(c.id, "google", "G-9")?.phone).toBe("+15128675309");
  });

  it("Facebook: verification handshake, signature check, then fetches the lead", async () => {
    const t = createTestEnv();
    const c = createContractor(t);
    t.repo.upsertFacebookPage({ pageId: "555", contractorId: c.id, pageName: "Summit", accessToken: encrypt("page-token", t.config.APP_SECRET) });
    const { app } = createApp(t.deps);

    const verify = await request(app).get("/webhooks/facebook").query({ "hub.mode": "subscribe", "hub.verify_token": "fb-verify", "hub.challenge": "42" });
    expect(verify.text).toBe("42");
    expect((await request(app).get("/webhooks/facebook").query({ "hub.mode": "subscribe", "hub.verify_token": "nope" })).status).toBe(403);

    const payload = JSON.stringify({ object: "page", entry: [{ id: "555", changes: [{ field: "leadgen", value: { leadgen_id: "777", page_id: "555", form_id: "1" } }] }] });
    const bad = await request(app).post("/webhooks/facebook").set("Content-Type", "application/json").set("X-Hub-Signature-256", "sha256=bad").send(payload);
    expect(bad.status).toBe(401);

    t.graph.responses.set("/777", {
      id: "777",
      field_data: [
        { name: "full_name", values: ["Fran K"] },
        { name: "phone_number", values: ["+15128675309"] },
      ],
    });
    const sig = `sha256=${hmacSha256Hex("fb-secret", payload)}`;
    const good = await request(app).post("/webhooks/facebook").set("Content-Type", "application/json").set("X-Hub-Signature-256", sig).send(payload);
    expect(good.status).toBe(200);
    // Same delivery twice (Meta retries) must not double-queue.
    await request(app).post("/webhooks/facebook").set("Content-Type", "application/json").set("X-Hub-Signature-256", sig).send(payload);
    await t.deps.jobs.drain();

    expect(t.graph.calls[0].params.access_token).toBe("page-token");
    const leads = t.repo.listLeads({ contractorId: c.id });
    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({ name: "Fran K", source: "facebook", externalId: "777" });
  });

  it("verifies Meta signatures", () => {
    const body = Buffer.from('{"a":1}');
    expect(verifyFacebookSignature("s", body, `sha256=${hmacSha256Hex("s", body)}`)).toBe(true);
    expect(verifyFacebookSignature("s", body, `sha256=${hmacSha256Hex("t", body)}`)).toBe(false);
    expect(verifyFacebookSignature("s", body, undefined)).toBe(false);
  });
});
