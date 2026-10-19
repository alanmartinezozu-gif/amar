import express, { type Request, type Response } from "express";
import type { Deps } from "../deps.js";
import type { Contractor } from "../domain/types.js";
import { escapeHtml } from "../lib/html.js";
import { extractContactFields, ingestLead } from "../leads/intake.js";

/*
 * Website leads, three ways:
 *  - Embed:   <script src="https://<server>/embed/<publicKey>.js" async></script>
 *             + <div data-speed-to-lead-form></div>         (renders our form), or
 *             + <form data-speed-to-lead>...</form>          (takes over the site's existing form)
 *  - Webhook: POST JSON or form-encoded fields to /webhooks/website/<publicKey>
 *             (WordPress/Webflow/Wix form webhooks, Zapier, etc.)
 *  - Hosted:  https://<server>/f/<publicKey>                 (standalone form page)
 * After submit the visitor sees the contractor's thank-you message; the AI calls seconds later.
 */

const HONEYPOT = "_hp";
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 8;

class RateLimiter {
  private hits = new Map<string, number[]>();
  allow(key: string, now: number): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    if (recent.length >= RATE_MAX) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) this.hits.clear();
    return true;
  }
}

export function consentText(contractor: Contractor): string {
  return `By submitting, you agree that ${contractor.name} may call and text you at the number provided, including with automated technology and an AI assistant, about your request. Consent is not a condition of purchase. Msg & data rates may apply. Reply STOP to opt out.`;
}

function flatten(body: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!body || typeof body !== "object") return out;
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (v === null || v === undefined) continue;
    out[k] = Array.isArray(v) ? v.map(String).join(", ") : typeof v === "object" ? JSON.stringify(v) : String(v);
  }
  return out;
}

function wantsHtml(req: Request): boolean {
  return req.is("application/x-www-form-urlencoded") === "application/x-www-form-urlencoded" && Boolean(req.accepts(["json", "html"]) === "html");
}

function cors(res: Response): void {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  res.set("Access-Control-Max-Age", "86400");
}

export function websiteRouter(deps: Deps): express.Router {
  const router = express.Router();
  const limiter = new RateLimiter();

  router.options("/webhooks/website/:publicKey", (_req, res) => {
    cors(res);
    res.sendStatus(204);
  });

  router.post("/webhooks/website/:publicKey", (req: Request, res: Response) => {
    cors(res);
    const contractor = deps.repo.getContractorByPublicKey(String(req.params.publicKey));
    if (!contractor?.active) {
      res.status(404).json({ ok: false, error: "unknown form" });
      return;
    }
    const fields = flatten(req.body);
    const thankYou = contractor.settings.thankYouMessage;
    const respond = () => {
      const redirect = fields._redirect;
      if (wantsHtml(req)) {
        if (redirect && /^https?:\/\//i.test(redirect)) res.redirect(303, redirect);
        else res.type("html").send(thankYouPage(contractor));
        return;
      }
      res.json({ ok: true, message: thankYou });
    };

    if (fields[HONEYPOT]) {
      // A bot filled the hidden field. Look successful so it moves on.
      respond();
      return;
    }
    if (!limiter.allow(`${contractor.id}:${req.ip}`, deps.clock().getTime())) {
      res.status(429).json({ ok: false, error: "Too many submissions, please call us instead." });
      return;
    }

    const metadata: Record<string, unknown> = { ip: req.ip, userAgent: req.get("user-agent") };
    const formFields: Record<string, string> = {};
    for (const [k, v] of Object.entries(fields)) {
      if (k.startsWith("_")) {
        if (k === "_page" || k === "_referrer") metadata[k.slice(1)] = v;
        continue;
      }
      if (/^utm_/i.test(k) || k === "gclid" || k === "fbclid") metadata[k] = v;
      else formFields[k] = v;
    }
    const result = ingestLead(deps, contractor, { source: "website", ...extractContactFields(formFields), metadata });
    deps.log.info("Website lead ingested", { leadId: result.lead.id, outcome: result.outcome });
    respond();
  });

  router.get("/embed/:file", (req: Request, res: Response) => {
    const key = String(req.params.file).replace(/\.js$/, "");
    const contractor = deps.repo.getContractorByPublicKey(key);
    res.type("application/javascript");
    res.set("Cache-Control", "public, max-age=300");
    if (!contractor?.active) {
      res.status(404).send("/* unknown form */");
      return;
    }
    res.send(embedScript(contractor, `${deps.config.PUBLIC_BASE_URL}/webhooks/website/${contractor.publicKey}`));
  });

  router.get("/f/:publicKey", (req: Request, res: Response) => {
    const contractor = deps.repo.getContractorByPublicKey(String(req.params.publicKey));
    if (!contractor?.active) {
      res.status(404).send("Not found");
      return;
    }
    res.type("html").send(hostedFormPage(contractor, `${deps.config.PUBLIC_BASE_URL}/embed/${contractor.publicKey}.js`));
  });

  return router;
}

function thankYouPage(contractor: Contractor): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Thank you - ${escapeHtml(contractor.name)}</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f6f7f9;color:#111}
.card{background:#fff;padding:32px;border-radius:12px;max-width:420px;text-align:center;box-shadow:0 2px 12px rgba(0,0,0,.08)}</style></head>
<body><div class="card"><h1>${escapeHtml(contractor.name)}</h1><p>${escapeHtml(contractor.settings.thankYouMessage)}</p></div></body></html>`;
}

function hostedFormPage(contractor: Contractor, scriptUrl: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Get a free quote - ${escapeHtml(contractor.name)}</title>
<style>body{font-family:system-ui,sans-serif;margin:0;background:#f6f7f9;color:#111;padding:24px 16px}
main{max-width:480px;margin:0 auto}h1{font-size:1.5rem;margin:0 0 4px}p.sub{margin:0 0 20px;color:#555}</style></head>
<body><main><h1>${escapeHtml(contractor.name)}</h1><p class="sub">Get your free quote - we'll call you in under a minute.</p>
<div data-speed-to-lead-form></div></main><script src="${escapeHtml(scriptUrl)}" async></script></body></html>`;
}

/** The embeddable script. Values are injected with JSON.stringify so they're valid JS string literals. */
export function embedScript(contractor: Contractor, endpoint: string): string {
  const cfg = {
    endpoint,
    thankYou: contractor.settings.thankYouMessage,
    consent: consentText(contractor),
    services: contractor.settings.services,
  };
  return `/* Speed-to-lead form for ${contractor.name.replace(/\*\//g, "")} */
(function () {
  var CFG = ${JSON.stringify(cfg)};
  var CSS = ".stl-form{display:grid;gap:10px;font:inherit}.stl-form label{display:grid;gap:4px;font-size:14px;font-weight:600}" +
    ".stl-form input,.stl-form textarea{font:inherit;padding:10px 12px;border:1px solid #c8ccd2;border-radius:8px;width:100%;box-sizing:border-box}" +
    ".stl-form button{font:inherit;font-weight:700;padding:12px;border:0;border-radius:8px;background:#0b5fff;color:#fff;cursor:pointer}" +
    ".stl-form button[disabled]{opacity:.6;cursor:wait}.stl-consent{font-size:12px;color:#666;line-height:1.4}" +
    ".stl-hp{position:absolute!important;left:-9999px!important;height:0;overflow:hidden}" +
    ".stl-thanks{padding:20px;border-radius:10px;background:#eaf7ee;color:#0f5132;font-weight:600;text-align:center}";

  function addStyle() {
    if (document.getElementById("stl-style")) return;
    var s = document.createElement("style");
    s.id = "stl-style";
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function collect(form) {
    var data = {};
    new FormData(form).forEach(function (v, k) {
      if (typeof v !== "string") return;
      data[k] = data[k] ? data[k] + ", " + v : v;
    });
    data._page = location.href;
    data._referrer = document.referrer;
    var q = new URLSearchParams(location.search);
    ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid", "fbclid"].forEach(function (k) {
      if (q.get(k) && !data[k]) data[k] = q.get(k);
    });
    return data;
  }

  function thank(form) {
    var d = document.createElement("div");
    d.className = "stl-thanks";
    d.setAttribute("role", "status");
    d.textContent = CFG.thankYou;
    form.parentNode.replaceChild(d, form);
  }

  function attach(form) {
    if (form.__stl) return;
    form.__stl = true;
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var btn = form.querySelector("[type=submit]");
      if (btn) btn.disabled = true;
      fetch(CFG.endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(collect(form)) })
        .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
        .then(function () { thank(form); })
        .catch(function () {
          if (btn) btn.disabled = false;
          alert("Sorry, we couldn't send that. Please try again or give us a call.");
        });
    });
  }

  function field(label, name, type, required, auto) {
    return '<label>' + label + (required ? ' *' : '') + '<input name="' + name + '" type="' + type + '"' +
      (required ? ' required' : '') + (auto ? ' autocomplete="' + auto + '"' : '') + '></label>';
  }

  function render(el) {
    if (el.__stl) return;
    el.__stl = true;
    addStyle();
    el.innerHTML = '<form class="stl-form" novalidate>' +
      field("Name", "name", "text", true, "name") +
      field("Phone", "phone", "tel", true, "tel") +
      field("Email", "email", "email", false, "email") +
      field("Property address", "address", "text", false, "street-address") +
      field("Zip code", "zip", "text", false, "postal-code") +
      '<label>What do you need help with?<textarea name="message" rows="3"></textarea></label>' +
      '<div class="stl-hp" aria-hidden="true"><input name="${HONEYPOT}" tabindex="-1" autocomplete="off"></div>' +
      '<button type="submit">Get my free quote</button>' +
      '<p class="stl-consent"></p></form>';
    el.querySelector(".stl-consent").textContent = CFG.consent;
    var form = el.querySelector("form");
    form.addEventListener("submit", function (e) {
      if (!form.checkValidity()) { e.preventDefault(); e.stopImmediatePropagation(); form.reportValidity(); }
    }, true);
    attach(form);
  }

  function init() {
    document.querySelectorAll("form[data-speed-to-lead]").forEach(attach);
    document.querySelectorAll("[data-speed-to-lead-form]").forEach(render);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
`;
}
