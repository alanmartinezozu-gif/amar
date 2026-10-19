import { DateTime } from "luxon";
import type { CalendarConnection, Call, Contractor, FacebookPage, Job, Lead, LeadEvent } from "../domain/types.js";
import { formatHoursText } from "../domain/settings.js";
import { html, raw, type RawHtml } from "../lib/html.js";
import { formatPhone } from "../lib/phone.js";
import { sourceLabel } from "../notify/notify.js";

const CSS = `
:root{--bg:#f5f6f8;--card:#fff;--text:#16181d;--muted:#5d6470;--line:#e3e6ea;--accent:#0b5fff;--accent-ink:#fff;
--ok:#0f7b3f;--ok-bg:#e5f6ec;--warn:#8a5a00;--warn-bg:#fff4d6;--bad:#a1212b;--bad-bg:#fde8ea;--info:#1f4fa8;--info-bg:#e6efff;--idle:#4b5563;--idle-bg:#eef0f3}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#171a21;--text:#e8eaee;--muted:#9aa3b2;--line:#2a2f3a;--accent:#5b8cff;--accent-ink:#0b0d12;
--ok:#5fd394;--ok-bg:#12301f;--warn:#f2c14e;--warn-bg:#33280c;--bad:#ff8a93;--bad-bg:#3a161a;--info:#8fb2ff;--info-bg:#162443;--idle:#c0c6d0;--idle-bg:#232833}}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--text)}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
header.top{display:flex;align-items:center;gap:20px;padding:14px 24px;background:var(--card);border-bottom:1px solid var(--line);flex-wrap:wrap}
header.top .brand{font-weight:800;letter-spacing:-.01em;color:var(--text)}header.top nav{display:flex;gap:16px}
main{max-width:1180px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:1.6rem;margin:0 0 4px;letter-spacing:-.01em}h2{font-size:1.15rem;margin:0 0 12px}h3{font-size:1rem;margin:16px 0 8px}
.sub{color:var(--muted);margin:0 0 20px}.muted{color:var(--muted)}.small{font-size:13px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px;margin-bottom:16px}
.grid{display:grid;gap:16px}.grid.two{grid-template-columns:repeat(auto-fit,minmax(320px,1fr))}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:16px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px}.stat b{display:block;font-size:1.6rem;letter-spacing:-.02em}
.stat span{color:var(--muted);font-size:13px}
.table-wrap{overflow-x:auto}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);font-weight:600}tr:last-child td{border-bottom:0}
.chip{display:inline-block;padding:2px 9px;border-radius:999px;font-size:12px;font-weight:600;white-space:nowrap}
.chip.ok{color:var(--ok);background:var(--ok-bg)}.chip.warn{color:var(--warn);background:var(--warn-bg)}.chip.bad{color:var(--bad);background:var(--bad-bg)}
.chip.info{color:var(--info);background:var(--info-bg)}.chip.idle{color:var(--idle);background:var(--idle-bg)}
form.settings{display:grid;gap:14px}.fields{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));align-items:end}
label{display:grid;gap:5px;font-weight:600;font-size:14px}label .hint{font-weight:400;color:var(--muted);font-size:12.5px}
input[type=text],input[type=number],input[type=tel],input[type=url],input[type=email],select,textarea{font:inherit;color:inherit;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:9px 11px;width:100%}
textarea{min-height:88px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13.5px}
.check{display:flex;gap:8px;align-items:center;font-weight:500}
button,.btn{font:inherit;font-weight:700;border:0;border-radius:8px;padding:9px 16px;background:var(--accent);color:var(--accent-ink);cursor:pointer;display:inline-block}
button.secondary,.btn.secondary{background:var(--idle-bg);color:var(--text)}button.danger{background:var(--bad-bg);color:var(--bad)}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.row select{width:auto}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}pre{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:12px;overflow-x:auto;white-space:pre-wrap;word-break:break-all;margin:6px 0}
.flash{padding:12px 16px;border-radius:10px;margin-bottom:16px;font-weight:600}.flash.ok{background:var(--ok-bg);color:var(--ok)}.flash.bad{background:var(--bad-bg);color:var(--bad)}
.steps{margin:0;padding-left:20px}.steps li{margin:4px 0}
.transcript{display:grid;gap:8px}.bubble{padding:9px 12px;border-radius:10px;max-width:80%}.bubble.assistant{background:var(--info-bg)}.bubble.caller{background:var(--idle-bg);justify-self:end}
.bubble small{display:block;color:var(--muted);font-size:11.5px}
dl.kv{display:grid;grid-template-columns:max-content 1fr;gap:6px 16px;margin:0}dl.kv dt{color:var(--muted)}dl.kv dd{margin:0}
.timeline{list-style:none;margin:0;padding:0}.timeline li{padding:6px 0;border-bottom:1px dashed var(--line)}.timeline li:last-child{border:0}
`;

export interface PageOptions {
  csrf: string;
  flash?: { kind: "ok" | "bad"; text: string } | null;
}

export function layout(title: string, body: RawHtml, opts: PageOptions): string {
  return html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title} · Speed to Lead</title>
    <style>
      ${raw(CSS)}
    </style>
  </head>
  <body>
    <header class="top">
      <a class="brand" href="/admin">⚡ Speed to Lead</a>
      <nav><a href="/admin">Dashboard</a><a href="/admin/leads">Leads</a><a href="/admin/contractors/new">Add contractor</a></nav>
    </header>
    <main>
      ${opts.flash ? html`<div class="flash ${opts.flash.kind}" role="status">${opts.flash.text}</div>` : ""}
      ${body}
    </main>
  </body>
</html>`.html;
}

function csrfField(csrf: string): RawHtml {
  return html`<input type="hidden" name="_csrf" value="${csrf}" />`;
}

const STATUS_STYLE: Record<string, [string, string]> = {
  new: ["info", "New - calling soon"],
  scheduled: ["idle", "Call scheduled"],
  calling: ["info", "Calling"],
  in_conversation: ["info", "Talking to AI"],
  transferring: ["info", "Transferring"],
  transferred: ["ok", "Transferred"],
  booked: ["ok", "Booked"],
  retry_scheduled: ["warn", "No answer - retrying"],
  callback_scheduled: ["idle", "Callback scheduled"],
  needs_followup: ["bad", "Needs follow-up"],
  not_interested: ["idle", "Not interested"],
  do_not_call: ["idle", "Do not call"],
  wrong_number: ["idle", "Wrong number"],
  unreachable: ["bad", "Unreachable"],
  invalid_phone: ["bad", "Invalid phone"],
};

export function statusChip(status: string): RawHtml {
  const [cls, label] = STATUS_STYLE[status] ?? ["idle", status];
  return html`<span class="chip ${cls}">${label}</span>`;
}

function when(iso: string | null | undefined, tz: string): string {
  if (!iso) return "";
  return DateTime.fromISO(iso, { zone: tz }).toFormat("LLL d, h:mm a");
}

function ago(iso: string, now: Date): string {
  const secs = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function leadRows(leads: Lead[], contractors: Map<string, Contractor>, now: Date, showContractor: boolean): RawHtml {
  if (leads.length === 0) return html`<p class="muted">No leads yet. Use “Send a test lead” on a contractor to try the whole flow.</p>`;
  return html`<div class="table-wrap"><table>
    <thead><tr><th>Received</th>${showContractor ? html`<th>Contractor</th>` : ""}<th>Lead</th><th>Source</th><th>Status</th><th>Calls</th><th>Appointment</th></tr></thead>
    <tbody>${leads.map((l) => {
      const c = contractors.get(l.contractorId);
      const tz = c?.timezone ?? "UTC";
      return html`<tr>
        <td><span title="${l.createdAt}">${ago(l.createdAt, now)}</span></td>
        ${showContractor ? html`<td>${c ? html`<a href="/admin/contractors/${c.id}">${c.name}</a>` : "-"}</td>` : ""}
        <td><a href="/admin/leads/${l.id}">${l.name ?? "Unknown"}</a><br /><span class="muted small">${formatPhone(l.phone) || l.phoneRaw || ""}</span></td>
        <td>${sourceLabel(l.source)}</td>
        <td>${statusChip(l.status)}</td>
        <td>${l.callAttempts}</td>
        <td>${when(l.appointmentStart, tz)}</td>
      </tr>`;
    })}</tbody></table></div>`;
}

/* -------------------------------- dashboard -------------------------------- */

export function dashboardPage(
  data: {
    contractors: Contractor[];
    leads: Lead[];
    counts: Record<string, number>;
    medianSeconds: number | null;
    now: Date;
  },
  opts: PageOptions,
): string {
  const total = Object.values(data.counts).reduce((a, b) => a + b, 0);
  const c = (k: string) => data.counts[k] ?? 0;
  const byId = new Map(data.contractors.map((x) => [x.id, x]));
  const body = html`
    <h1>Dashboard</h1>
    <p class="sub">Last 7 days across all contractors.</p>
    <div class="stats">
      <div class="stat"><b>${total}</b><span>Leads</span></div>
      <div class="stat"><b>${data.medianSeconds === null ? "-" : `${data.medianSeconds}s`}</b><span>Median time to first call</span></div>
      <div class="stat"><b>${c("booked")}</b><span>Booked</span></div>
      <div class="stat"><b>${c("transferred")}</b><span>Live transfers</span></div>
      <div class="stat"><b>${c("needs_followup") + c("unreachable")}</b><span>Need a human</span></div>
    </div>
    <div class="card">
      <div class="row" style="justify-content:space-between"><h2>Recent leads</h2><a href="/admin/leads">All leads →</a></div>
      ${leadRows(data.leads, byId, data.now, true)}
    </div>
    <div class="card">
      <div class="row" style="justify-content:space-between"><h2>Contractors</h2><a class="btn" href="/admin/contractors/new">Add contractor</a></div>
      ${data.contractors.length === 0
        ? html`<p class="muted">No contractors yet. Add your first one to get its Facebook, Google Ads and website hookups.</p>`
        : html`<div class="table-wrap"><table><thead><tr><th>Name</th><th>Phone line</th><th>Team</th><th>Status</th></tr></thead><tbody>
          ${data.contractors.map(
            (x) => html`<tr><td><a href="/admin/contractors/${x.id}">${x.name}</a></td><td>${formatPhone(x.twilioNumber) || html`<span class="muted">default</span>`}</td>
              <td>${x.settings.transferTargets.map((t) => t.name).join(", ") || html`<span class="muted">none</span>`}</td>
              <td>${x.active ? html`<span class="chip ok">Active</span>` : html`<span class="chip idle">Paused</span>`}</td></tr>`,
          )}</tbody></table></div>`}
    </div>`;
  return layout("Dashboard", body, opts);
}

export function leadsPage(
  data: { leads: Lead[]; contractors: Contractor[]; filter: { contractor?: string; status?: string }; now: Date },
  opts: PageOptions,
): string {
  const byId = new Map(data.contractors.map((x) => [x.id, x]));
  const body = html`
    <h1>Leads</h1>
    <form class="row card" method="get" action="/admin/leads">
      <select name="contractor"><option value="">All contractors</option>${data.contractors.map(
        (c) => html`<option value="${c.id}" ${data.filter.contractor === c.id ? raw("selected") : ""}>${c.name}</option>`,
      )}</select>
      <select name="status"><option value="">Any status</option>${Object.entries(STATUS_STYLE).map(
        ([k, [, label]]) => html`<option value="${k}" ${data.filter.status === k ? raw("selected") : ""}>${label}</option>`,
      )}</select>
      <button type="submit" class="secondary">Filter</button>
    </form>
    <div class="card">${leadRows(data.leads, byId, data.now, true)}</div>`;
  return layout("Leads", body, opts);
}

/* -------------------------------- contractors ------------------------------- */

const TIMEZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
  "America/Puerto_Rico",
  "America/Toronto",
  "America/Vancouver",
];

function timezoneInput(value: string): RawHtml {
  return html`<input type="text" name="timezone" list="tz-list" value="${value}" required />
    <datalist id="tz-list">${TIMEZONES.map((t) => html`<option value="${t}"></option>`)}</datalist>`;
}

export function newContractorPage(opts: PageOptions, values: { name?: string; timezone?: string; twilioNumber?: string } = {}): string {
  const body = html`
    <h1>Add a contractor</h1>
    <p class="sub">You'll get their Facebook, Google Ads and website hookups on the next screen.</p>
    <form class="card settings" method="post" action="/admin/contractors">
      ${csrfField(opts.csrf)}
      <div class="fields">
        <label>Company name<input type="text" name="name" value="${values.name ?? ""}" required placeholder="Summit Roofing" /></label>
        <label>Time zone${timezoneInput(values.timezone ?? "America/Chicago")}</label>
        <label>Twilio phone number <span class="hint">Caller ID for AI calls. Local area codes get answered more.</span>
          <input type="tel" name="twilioNumber" value="${values.twilioNumber ?? ""}" placeholder="+15125550100" /></label>
      </div>
      <div><button type="submit">Create contractor</button></div>
    </form>`;
  return layout("Add contractor", body, opts);
}

export interface ContractorPageData {
  contractor: Contractor;
  pages: FacebookPage[];
  calendar: CalendarConnection | null;
  baseUrl: string;
  facebookEnabled: boolean;
  googleEnabled: boolean;
  defaultNumber: string | null;
  leads: Lead[];
  now: Date;
}

function copyBlock(value: string): RawHtml {
  return html`<pre>${value}</pre>`;
}

export function contractorPage(d: ContractorPageData, opts: PageOptions): string {
  const c = d.contractor;
  const s = c.settings;
  const embed = `<div data-speed-to-lead-form></div>\n<script src="${d.baseUrl}/embed/${c.publicKey}.js" async></script>`;
  const takeover = `<form data-speed-to-lead> ...your existing fields (name, phone, email, address, message)... </form>\n<script src="${d.baseUrl}/embed/${c.publicKey}.js" async></script>`;
  const line = c.twilioNumber ?? d.defaultNumber;

  const integrations = html`
    <div class="grid two">
      <section class="card">
        <h2>📘 Facebook &amp; Instagram lead ads</h2>
        ${d.pages.length
          ? html`<table><tbody>${d.pages.map(
              (p) => html`<tr><td>${p.pageName ?? p.pageId}<br /><span class="muted small">Page ${p.pageId}</span></td>
                <td style="text-align:right"><form method="post" action="/admin/contractors/${c.id}/facebook-pages/${p.pageId}/delete">${csrfField(opts.csrf)}<button class="danger" type="submit">Remove</button></form></td></tr>`,
            )}</tbody></table>`
          : html`<p class="muted">No page connected yet.</p>`}
        ${d.facebookEnabled
          ? html`<p><a class="btn" href="/admin/contractors/${c.id}/connect/facebook">Connect a Facebook page</a></p>`
          : html`<p class="muted small">Set FACEBOOK_APP_ID / FACEBOOK_APP_SECRET / FACEBOOK_VERIFY_TOKEN to enable one-click connect.</p>`}
        <ol class="steps small">
          <li>In the Instant Form's <b>Completion</b> screen set the headline/description to: <i>${s.thankYouMessage}</i></li>
          <li>Add a phone number question, and a custom disclaimer that they agree to calls &amp; texts (including an AI assistant).</li>
          <li>Test with Meta's Lead Ads Testing Tool - you should get a call within seconds.</li>
        </ol>
        <details><summary class="small">Add a page manually (page id + page access token)</summary>
          <form class="settings" method="post" action="/admin/contractors/${c.id}/facebook-pages">${csrfField(opts.csrf)}
            <label>Page ID<input type="text" name="pageId" required /></label>
            <label>Page name<input type="text" name="pageName" /></label>
            <label>Page access token<input type="text" name="accessToken" required /></label>
            <div><button type="submit" class="secondary">Add page &amp; subscribe</button></div>
          </form></details>
      </section>

      <section class="card">
        <h2>🔎 Google Ads lead forms</h2>
        <p class="small">Lead form asset → <b>Export leads</b> → <b>Webhook integration</b>:</p>
        <label class="small">Webhook URL${copyBlock(`${d.baseUrl}/webhooks/google-ads/${c.id}`)}</label>
        <label class="small">Key${copyBlock(c.googleAdsKey)}</label>
        <p class="small">Set the form's <b>Submission message</b> to: <i>${s.thankYouMessage}</i></p>
        <p class="small">Then click “Send test data” in Google Ads to try it.</p>
      </section>

      <section class="card">
        <h2>🌐 Website</h2>
        <p class="small">Paste where the form should appear:</p>${copyBlock(embed)}
        <p class="small">Or take over an existing form:</p>${copyBlock(takeover)}
        <p class="small">Form builders / Zapier can POST fields to:</p>${copyBlock(`${d.baseUrl}/webhooks/website/${c.publicKey}`)}
        <p class="small">Hosted form page (great for testing or link-in-bio): <a href="${d.baseUrl}/f/${c.publicKey}" target="_blank" rel="noopener">${d.baseUrl}/f/${c.publicKey}</a></p>
      </section>

      <section class="card">
        <h2>📅 Calendar</h2>
        ${d.calendar
          ? html`<p>Connected to Google Calendar <b>${d.calendar.accountEmail ?? ""}</b>. The AI books into calendar <code>${s.booking.calendarId}</code>.</p>
              <form method="post" action="/admin/contractors/${c.id}/calendar/delete">${csrfField(opts.csrf)}<button class="danger" type="submit">Disconnect</button></form>`
          : html`<p class="muted">Not connected - the AI offers times within booking hours and the team gets a text to confirm.</p>
              ${d.googleEnabled
                ? html`<a class="btn" href="/admin/contractors/${c.id}/connect/google">Connect Google Calendar</a>`
                : html`<p class="muted small">Set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET to enable.</p>`}`}
      </section>

      <section class="card">
        <h2>📞 Phone line</h2>
        <p>${line ? html`AI calls come from <b>${formatPhone(line)}</b>${c.twilioNumber ? "" : " (default number)"}.` : html`<span class="chip bad">No number</span> Set a Twilio number below or TWILIO_DEFAULT_NUMBER.`}</p>
        ${c.twilioNumber
          ? html`<form method="post" action="/admin/contractors/${c.id}/twilio-configure">${csrfField(opts.csrf)}
              <p class="small muted">Points this number's incoming calls and texts at the AI (callbacks get answered, STOP replies are honored).</p>
              <button class="secondary" type="submit">Configure Twilio number</button></form>`
          : ""}
      </section>

      <section class="card">
        <h2>🧪 Send a test lead</h2>
        <p class="small muted">Runs the real flow: thank-you text, AI call in ${s.callDelaySeconds}s, transfer, booking.</p>
        <form class="settings" method="post" action="/admin/contractors/${c.id}/test-lead">${csrfField(opts.csrf)}
          <div class="fields"><label>Name<input type="text" name="name" value="Test Lead" required /></label>
          <label>Your phone<input type="tel" name="phone" required placeholder="+15125550123" /></label></div>
          <label>What they need<input type="text" name="message" value="Roof leak over the kitchen, need someone to look at it this week" /></label>
          <div><button type="submit">Send test lead</button></div>
        </form>
      </section>
    </div>`;

  const v = (x: unknown) => (x === undefined || x === null ? "" : String(x));
  const checked = (b: boolean) => (b ? raw("checked") : "");
  const settingsForm = html`
    <form class="card settings" method="post" action="/admin/contractors/${c.id}/settings">
      ${csrfField(opts.csrf)}
      <h2>Settings</h2>
      <h3>Company</h3>
      <div class="fields">
        <label>Company name<input type="text" name="name" value="${c.name}" required /></label>
        <label>Time zone${timezoneInput(c.timezone)}</label>
        <label>Twilio phone number<input type="tel" name="twilioNumber" value="${v(c.twilioNumber)}" placeholder="+15125550100" /></label>
        <label class="check"><input type="checkbox" name="active" value="1" ${checked(c.active)} /> Active (uncheck to pause all calls)</label>
      </div>
      <div class="fields">
        <label>Services <span class="hint">What they do, e.g. "roofing and gutter"</span><input type="text" name="services" value="${s.services}" /></label>
        <label>Service area<input type="text" name="serviceArea" value="${s.serviceArea}" placeholder="Austin and surrounding areas" /></label>
        <label>Thank-you message <span class="hint">Shown after the form is submitted</span><input type="text" name="thankYouMessage" value="${s.thankYouMessage}" /></label>
      </div>

      <h3>AI assistant</h3>
      <div class="fields">
        <label>Assistant name<input type="text" name="assistantName" value="${s.assistantName}" /></label>
        <label>Call delay (seconds) <span class="hint">After the form is submitted</span><input type="number" min="0" max="3600" name="callDelaySeconds" value="${s.callDelaySeconds}" /></label>
        <label>Calling hours <span class="hint">TCPA: 8am-9pm the lead's local time</span><input type="text" name="callingHours" value="${formatHoursText(s.callingHours)}" /></label>
      </div>
      <label>Company notes for the AI <span class="hint">Pricing policy, financing, warranties, what NOT to say, FAQs.</span>
        <textarea name="customInstructions" rows="5">${s.customInstructions}</textarea></label>
      <label>Questions to ask <span class="hint">One per line: key | question | required or optional</span>
        <textarea name="questions" rows="7">${s.questions.map((q) => `${q.key} | ${q.question} | ${q.required ? "required" : "optional"}`).join("\n")}</textarea></label>

      <h3>Live transfer</h3>
      <label>Team members to transfer to, in order <span class="hint">One per line: Name | Role | Phone</span>
        <textarea name="transferTargets" rows="3" placeholder="Mike Johnson | Owner | +15125550100">${s.transferTargets.map((t) => `${t.name} | ${t.role} | ${t.phone}`).join("\n")}</textarea></label>
      <div class="fields">
        <label>Transfer hours <span class="hint">Outside these, the AI books instead</span><input type="text" name="transferHours" value="${formatHoursText(s.transferHours)}" /></label>
        <label>Ring each person (seconds)<input type="number" min="5" max="60" name="transferRingSeconds" value="${s.transferRingSeconds}" /></label>
        <label>Team alert phones <span class="hint">Comma separated. Empty = everyone above.</span><input type="text" name="alertPhones" value="${s.alertPhones.join(", ")}" /></label>
      </div>

      <h3>Booking</h3>
      <div class="fields">
        <label>Booking hours<input type="text" name="bookingHours" value="${formatHoursText(s.booking.hours)}" /></label>
        <label>Appointment name<input type="text" name="appointmentTitle" value="${s.booking.appointmentTitle}" /></label>
        <label>Length (minutes)<input type="number" min="15" max="480" name="durationMinutes" value="${s.booking.durationMinutes}" /></label>
        <label>Buffer between (minutes)<input type="number" min="0" max="240" name="bufferMinutes" value="${s.booking.bufferMinutes}" /></label>
        <label>Minimum notice (hours)<input type="number" min="0" max="168" step="0.5" name="minNoticeHours" value="${s.booking.minNoticeHours}" /></label>
        <label>Book up to (days ahead)<input type="number" min="1" max="60" name="daysAhead" value="${s.booking.daysAhead}" /></label>
        <label>Start times every (minutes)<input type="number" min="15" max="240" name="slotIntervalMinutes" value="${s.booking.slotIntervalMinutes}" /></label>
        <label>Google Calendar id<input type="text" name="calendarId" value="${s.booking.calendarId}" /></label>
      </div>

      <h3>Follow-up</h3>
      <div class="fields">
        <label>Re-dial after (minutes) <span class="hint">Comma separated, one per retry</span><input type="text" name="retryDelaysMinutes" value="${s.retryDelaysMinutes.join(", ")}" /></label>
        <label>Leave a voicemail<select name="voicemail">
          ${(["first", "always", "never"] as const).map((o) => html`<option value="${o}" ${s.voicemail === o ? raw("selected") : ""}>${{ first: "On the first missed call", always: "Every missed call", never: "Never" }[o]}</option>`)}
        </select></label>
        <label>Merge repeat submissions within (minutes)<input type="number" min="0" name="dedupeMinutes" value="${s.dedupeMinutes}" /></label>
      </div>
      <div class="fields">
        <label class="check"><input type="checkbox" name="sms_instantReply" value="1" ${checked(s.sms.instantReply)} /> Text the lead “we're calling you now”</label>
        <label class="check"><input type="checkbox" name="sms_missedCall" value="1" ${checked(s.sms.missedCall)} /> Text the lead after a missed call</label>
        <label class="check"><input type="checkbox" name="sms_bookingConfirmation" value="1" ${checked(s.sms.bookingConfirmation)} /> Text the lead their appointment</label>
        <label class="check"><input type="checkbox" name="sms_teamAlerts" value="1" ${checked(s.sms.teamAlerts)} /> Text the team alerts</label>
      </div>

      <h3>Voice &amp; integrations</h3>
      <div class="fields">
        <label>Language<input type="text" name="voice_language" value="${s.voice.language}" /></label>
        <label>TTS provider <span class="hint">ElevenLabs (default), Google or Amazon</span><input type="text" name="voice_ttsProvider" value="${v(s.voice.ttsProvider)}" /></label>
        <label>Voice <span class="hint">Provider voice id</span><input type="text" name="voice_voice" value="${v(s.voice.voice)}" /></label>
        <label>Transcription provider<input type="text" name="voice_transcriptionProvider" value="${v(s.voice.transcriptionProvider)}" placeholder="Deepgram" /></label>
        <label>Speech model<input type="text" name="voice_speechModel" value="${v(s.voice.speechModel)}" placeholder="nova-3-general" /></label>
        <label>Voicemail / whisper voice<input type="text" name="voice_sayVoice" value="${s.voice.sayVoice}" /></label>
        <label>Webhook URL <span class="hint">Lead &amp; call events as JSON (Zapier, CRM)</span><input type="url" name="webhookUrl" value="${s.webhookUrl}" /></label>
      </div>
      <div><button type="submit">Save settings</button></div>
    </form>`;

  const body = html`
    <h1>${c.name}</h1>
    <p class="sub">${c.active ? "Active" : "Paused"} · ${c.timezone} · <a href="/admin/leads?contractor=${c.id}">View all leads</a></p>
    ${integrations}
    <div class="card"><h2>Recent leads</h2>${leadRows(d.leads, new Map([[c.id, c]]), d.now, false)}</div>
    ${settingsForm}`;
  return layout(c.name, body, opts);
}

/* ---------------------------------- leads ---------------------------------- */

export function leadPage(
  d: { lead: Lead; contractor: Contractor; calls: Call[]; events: LeadEvent[]; pendingJobs: Job[]; now: Date },
  opts: PageOptions,
): string {
  const { lead, contractor } = d;
  const tz = contractor.timezone;
  const confirmed = lead.metadata.appointmentConfirmed;
  const kv = (entries: Array<[string, unknown]>) =>
    html`<dl class="kv">${entries.filter(([, v]) => v !== null && v !== undefined && v !== "").map(([k, v]) => html`<dt>${k}</dt><dd>${String(v)}</dd>`)}</dl>`;

  const body = html`
    <p class="small"><a href="/admin/contractors/${contractor.id}">← ${contractor.name}</a></p>
    <h1>${lead.name ?? "Unknown caller"} ${statusChip(lead.status)}</h1>
    <p class="sub">${sourceLabel(lead.source)} lead · received ${when(lead.createdAt, tz)} · ${lead.callAttempts} call attempt(s)</p>
    <div class="grid two">
      <section class="card">
        <h2>Contact</h2>
        ${kv([
          ["Phone", formatPhone(lead.phone) || lead.phoneRaw],
          ["Email", lead.email],
          ["Address", lead.address],
          ["Zip", lead.zip],
          ["Appointment", lead.appointmentStart ? `${when(lead.appointmentStart, tz)}${confirmed === false ? " (requested - confirm with customer)" : ""}` : null],
        ])}
        ${lead.summary ? html`<h3>Summary</h3><p>${lead.summary}</p>` : ""}
        <div class="row" style="margin-top:12px">
          <form method="post" action="/admin/leads/${lead.id}/call-now">${csrfField(opts.csrf)}<button type="submit">Have the AI call now</button></form>
          <form method="post" action="/admin/leads/${lead.id}/status" class="row">${csrfField(opts.csrf)}
            <select name="status">${Object.entries(STATUS_STYLE).map(([k, [, label]]) => html`<option value="${k}" ${lead.status === k ? raw("selected") : ""}>${label}</option>`)}</select>
            <button type="submit" class="secondary">Set status</button></form>
        </div>
      </section>
      <section class="card">
        <h2>Job details</h2>
        ${Object.keys(lead.details).length ? kv(Object.entries(lead.details).map(([k, v]) => [k.replace(/_/g, " "), v])) : html`<p class="muted">Nothing collected on a call yet.</p>`}
        <h3>From the form</h3>
        ${Object.keys(lead.formAnswers).length ? kv(Object.entries(lead.formAnswers)) : html`<p class="muted">Only contact info.</p>`}
      </section>
    </div>
    ${d.pendingJobs.length
      ? html`<div class="card"><h2>Coming up</h2><ul>${d.pendingJobs.map((j) => html`<li>${j.type.replace(/_/g, " ")} at ${when(j.runAt, tz)}</li>`)}</ul></div>`
      : ""}
    ${d.calls.map(
      (call) => html`<section class="card">
        <h2>${call.direction === "inbound" ? "Inbound call" : `Call attempt ${call.attempt}`} · ${when(call.createdAt, tz)}</h2>
        <p class="small muted">Twilio status: ${call.status}${call.answeredBy ? ` · answered by ${call.answeredBy}` : ""} · outcome: <b>${call.outcome ?? "in progress"}</b>${call.durationSeconds !== null ? ` · ${call.durationSeconds}s` : ""}</p>
        ${call.transcript.length
          ? html`<div class="transcript">${call.transcript.map(
              (t) => html`<div class="bubble ${t.role}"><small>${t.role === "caller" ? "Lead" : t.role === "assistant" ? contractor.settings.assistantName : "System"} · ${DateTime.fromISO(t.at, { zone: tz }).toFormat("h:mm:ss a")}</small>${t.text}</div>`,
            )}</div>`
          : html`<p class="muted">No conversation.</p>`}
      </section>`,
    )}
    <section class="card"><h2>Timeline</h2><ul class="timeline">${d.events.map(
      (e) => html`<li><span class="muted small">${when(e.createdAt, tz)}</span> · ${e.message ?? e.type}</li>`,
    )}</ul></section>`;
  return layout(lead.name ?? "Lead", body, opts);
}

export function facebookPickPage(
  d: { contractor: Contractor; pages: Array<{ id: string; name: string }>; blob: string },
  opts: PageOptions,
): string {
  const body = html`
    <h1>Pick the Facebook page for ${d.contractor.name}</h1>
    <form class="card settings" method="post" action="/admin/oauth/facebook/select">
      ${csrfField(opts.csrf)}
      <input type="hidden" name="contractorId" value="${d.contractor.id}" />
      <input type="hidden" name="blob" value="${d.blob}" />
      ${d.pages.length === 0
        ? html`<p>No pages found on that Facebook account. Make sure you're an admin of the contractor's page (or it's shared with your Business Manager).</p>`
        : d.pages.map((p) => html`<label class="check"><input type="checkbox" name="pageIds" value="${p.id}" /> ${p.name} <span class="muted small">(${p.id})</span></label>`)}
      <div><button type="submit">Connect selected pages</button></div>
    </form>`;
  return layout("Connect Facebook", body, opts);
}

export function messagePage(title: string, text: string, opts: PageOptions): string {
  return layout(title, html`<div class="card"><h1>${title}</h1><p>${text}</p><p><a href="/admin">Back to dashboard</a></p></div>`, opts);
}
