import express, { type Request, type Response } from "express";
import type { Config } from "../config.js";
import type { Deps } from "../deps.js";
import { decrypt, encrypt, hmacSha256Hex, safeEqual } from "../lib/crypto.js";
import { fetchJson, HttpError } from "../lib/http.js";
import { extractContactFields, ingestLead, type IncomingLead } from "../leads/intake.js";
import { PermanentJobError } from "../jobs/queue.js";

/*
 * Facebook / Instagram Lead Ads.
 *
 * 1. The contractor connects their Page (OAuth, admin UI) -> we store a page token and subscribe
 *    our app to the Page's `leadgen` webhook field.
 * 2. Someone submits the Instant Form. The form's own "Completion" screen shows the thank-you text.
 * 3. Meta POSTs a leadgen change here -> we queue a job -> the job fetches the answers from the
 *    Graph API and hands the lead to intake, which schedules the AI call.
 */

export type GraphFetch = <T>(path: string, params: Record<string, string>, method?: "GET" | "POST" | "DELETE") => Promise<T>;

export function createGraphFetch(config: Config): GraphFetch {
  return async <T>(path: string, params: Record<string, string>, method: "GET" | "POST" | "DELETE" = "GET") => {
    const query = { ...params };
    // appsecret_proof proves calls come from our server, so a leaked token alone is less useful.
    if (query.access_token && config.FACEBOOK_APP_SECRET) {
      query.appsecret_proof = hmacSha256Hex(config.FACEBOOK_APP_SECRET, query.access_token);
    }
    const url = `https://graph.facebook.com/${config.FACEBOOK_GRAPH_VERSION}${path}?${new URLSearchParams(query)}`;
    return fetchJson<T>(url, { method });
  };
}

interface LeadgenChange {
  leadgen_id: string;
  page_id: string;
  form_id?: string;
  ad_id?: string;
  adgroup_id?: string;
  created_time?: number;
}

interface WebhookBody {
  object?: string;
  entry?: Array<{ id?: string; changes?: Array<{ field?: string; value?: LeadgenChange }> }>;
}

export interface GraphLead {
  id: string;
  created_time?: string;
  field_data?: Array<{ name: string; values?: string[] }>;
  ad_id?: string;
  ad_name?: string;
  adset_name?: string;
  campaign_name?: string;
  form_id?: string;
  platform?: string;
  is_organic?: boolean;
}

export function verifyFacebookSignature(appSecret: string, rawBody: Buffer, header: string | undefined): boolean {
  if (!header?.startsWith("sha256=")) return false;
  return safeEqual(header.slice("sha256=".length), hmacSha256Hex(appSecret, rawBody));
}

export function mapFacebookLead(lead: GraphLead): IncomingLead {
  const fields: Record<string, string> = {};
  for (const f of lead.field_data ?? []) fields[f.name] = (f.values ?? []).join(", ");
  return {
    source: "facebook",
    externalId: lead.id,
    ...extractContactFields(fields),
    metadata: {
      formId: lead.form_id,
      adId: lead.ad_id,
      adName: lead.ad_name,
      adsetName: lead.adset_name,
      campaignName: lead.campaign_name,
      platform: lead.platform,
      isOrganic: lead.is_organic,
      submittedAt: lead.created_time,
    },
  };
}

export function facebookWebhookRouter(deps: Deps): express.Router {
  const router = express.Router();

  // Meta's subscription handshake.
  router.get("/webhooks/facebook", (req: Request, res: Response) => {
    const q = req.query as Record<string, string | undefined>;
    if (q["hub.mode"] === "subscribe" && deps.config.FACEBOOK_VERIFY_TOKEN && safeEqual(q["hub.verify_token"], deps.config.FACEBOOK_VERIFY_TOKEN)) {
      res.status(200).send(q["hub.challenge"] ?? "");
      return;
    }
    res.sendStatus(403);
  });

  router.post("/webhooks/facebook", (req: Request, res: Response) => {
    const secret = deps.config.FACEBOOK_APP_SECRET;
    if (!secret || !req.rawBody || !verifyFacebookSignature(secret, req.rawBody, req.get("x-hub-signature-256"))) {
      deps.log.warn("Rejected Facebook webhook with a bad signature");
      res.sendStatus(401);
      return;
    }
    const body = req.body as WebhookBody;
    let queued = 0;
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field !== "leadgen" || !change.value?.leadgen_id) continue;
        const v = change.value;
        deps.jobs.enqueue(
          "facebook_lead",
          { leadgenId: v.leadgen_id, pageId: v.page_id ?? entry.id, formId: v.form_id, adId: v.ad_id },
          deps.clock(),
          `facebook_lead:${v.leadgen_id}`,
        );
        queued++;
      }
    }
    deps.log.info("Facebook webhook received", { queued });
    // Acknowledge fast; Meta retries deliveries that time out.
    res.sendStatus(200);
  });

  return router;
}

export function registerFacebookJobs(deps: Deps): void {
  deps.jobs.register("facebook_lead", async (p) => {
    const pageId = String(p.pageId);
    const page = deps.repo.getFacebookPage(pageId);
    if (!page) throw new PermanentJobError(`Facebook page ${pageId} is not connected to any contractor`);
    const contractor = deps.repo.getContractor(page.contractorId);
    if (!contractor?.active) throw new PermanentJobError("Contractor missing or inactive");
    let lead: GraphLead;
    try {
      lead = await deps.graphFetch<GraphLead>(`/${encodeURIComponent(String(p.leadgenId))}`, {
        fields: "created_time,field_data,ad_id,ad_name,adset_name,campaign_name,form_id,platform,is_organic",
        access_token: decrypt(page.accessToken, deps.config.APP_SECRET),
      });
    } catch (err) {
      // 4xx = bad id / revoked token / missing permission: retrying won't help.
      if (err instanceof HttpError && err.status >= 400 && err.status < 500) {
        deps.repo.addEvent({ contractorId: contractor.id, type: "facebook_fetch_failed", message: err.message });
        throw new PermanentJobError(err.message);
      }
      throw err;
    }
    const result = ingestLead(deps, contractor, mapFacebookLead(lead));
    deps.log.info("Facebook lead ingested", { leadId: result.lead.id, outcome: result.outcome });
  });
}

/* ----------------------------- page connection ----------------------------- */

const SCOPES = ["pages_show_list", "pages_read_engagement", "pages_manage_metadata", "leads_retrieval", "pages_manage_ads", "business_management"];

export function facebookRedirectUri(config: Config): string {
  return `${config.PUBLIC_BASE_URL}/oauth/facebook/callback`;
}

export function facebookAuthUrl(config: Config, state: string): string {
  if (!config.FACEBOOK_APP_ID) throw new Error("Set FACEBOOK_APP_ID and FACEBOOK_APP_SECRET to connect Facebook pages");
  const params = new URLSearchParams({
    client_id: config.FACEBOOK_APP_ID,
    redirect_uri: facebookRedirectUri(config),
    state,
    scope: SCOPES.join(","),
    response_type: "code",
  });
  return `https://www.facebook.com/${config.FACEBOOK_GRAPH_VERSION}/dialog/oauth?${params}`;
}

export interface ConnectablePage {
  id: string;
  name: string;
  access_token: string;
}

/** OAuth code -> long-lived user token -> the Pages the user manages (with non-expiring page tokens). */
export async function listPagesForCode(deps: Deps, code: string): Promise<ConnectablePage[]> {
  const { config } = deps;
  const short = await deps.graphFetch<{ access_token: string }>("/oauth/access_token", {
    client_id: config.FACEBOOK_APP_ID ?? "",
    client_secret: config.FACEBOOK_APP_SECRET ?? "",
    redirect_uri: facebookRedirectUri(config),
    code,
  });
  const long = await deps.graphFetch<{ access_token: string }>("/oauth/access_token", {
    grant_type: "fb_exchange_token",
    client_id: config.FACEBOOK_APP_ID ?? "",
    client_secret: config.FACEBOOK_APP_SECRET ?? "",
    fb_exchange_token: short.access_token,
  });
  const pages: ConnectablePage[] = [];
  let after: string | undefined;
  for (let i = 0; i < 10; i++) {
    const res = await deps.graphFetch<{ data: ConnectablePage[]; paging?: { cursors?: { after?: string }; next?: string } }>(
      "/me/accounts",
      { fields: "id,name,access_token", limit: "100", access_token: long.access_token, ...(after ? { after } : {}) },
    );
    pages.push(...res.data);
    after = res.paging?.next ? res.paging.cursors?.after : undefined;
    if (!after) break;
  }
  return pages;
}

/** Subscribe our app to the page's leadgen webhook and remember which contractor it belongs to. */
export async function connectFacebookPage(deps: Deps, contractorId: string, page: ConnectablePage): Promise<void> {
  await deps.graphFetch(`/${page.id}/subscribed_apps`, { subscribed_fields: "leadgen", access_token: page.access_token }, "POST");
  deps.repo.upsertFacebookPage({
    pageId: page.id,
    contractorId,
    pageName: page.name,
    accessToken: encrypt(page.access_token, deps.config.APP_SECRET),
  });
  deps.repo.addEvent({ contractorId, type: "facebook_page_connected", message: `Connected Facebook page ${page.name} (${page.id})` });
}
