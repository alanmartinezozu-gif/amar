import express, { type Request, type Response } from "express";
import type { Deps } from "../deps.js";
import { safeEqual } from "../lib/crypto.js";
import { ingestLead, normalizeKey, type IncomingLead } from "../leads/intake.js";

/*
 * Google Ads lead form assets. In Google Ads: Lead form > Export leads > Webhook integration:
 *   Webhook URL: https://<server>/webhooks/google-ads/<contractorId>
 *   Key:         the contractor's Google Ads key (shown in the admin UI)
 * The form's "Submission message" is where the thank-you text goes.
 */

interface GoogleColumn {
  column_id?: string;
  column_name?: string;
  string_value?: string;
}

export interface GoogleLeadPayload {
  lead_id?: string;
  user_column_data?: GoogleColumn[];
  api_version?: string;
  form_id?: number | string;
  campaign_id?: number | string;
  adgroup_id?: number | string;
  creative_id?: number | string;
  asset_id?: number | string;
  gcl_id?: string;
  google_key?: string;
  is_test?: boolean;
  lead_submit_time?: string;
}

export function mapGoogleLead(body: GoogleLeadPayload): IncomingLead {
  const lead: IncomingLead = { source: "google", externalId: body.lead_id ?? null, answers: {} };
  const street: string[] = [];
  let city: string | null = null;
  let region: string | null = null;
  for (const col of body.user_column_data ?? []) {
    const id = (col.column_id ?? "").toUpperCase();
    const value = (col.string_value ?? "").trim();
    if (!value) continue;
    switch (id) {
      case "FULL_NAME":
        lead.name = value;
        break;
      case "FIRST_NAME":
        lead.firstName = value;
        break;
      case "LAST_NAME":
        lead.lastName = value;
        break;
      case "PHONE_NUMBER":
        lead.phone = value;
        break;
      case "EMAIL":
      case "WORK_EMAIL":
        lead.email ??= value;
        break;
      case "STREET_ADDRESS":
        street.push(value);
        break;
      case "CITY":
        city = value;
        break;
      case "REGION":
        region = value;
        break;
      case "POSTAL_CODE":
        lead.zip = value;
        break;
      default:
        // Custom questions arrive with the question text as column_name.
        lead.answers![col.column_name || normalizeKey(id)] = value;
    }
  }
  const address = [street.join(" "), city, [region, lead.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  if (address) lead.address = address;
  lead.metadata = {
    formId: body.form_id,
    campaignId: body.campaign_id,
    adgroupId: body.adgroup_id,
    creativeId: body.creative_id,
    assetId: body.asset_id,
    gclid: body.gcl_id,
    isTest: Boolean(body.is_test),
    submittedAt: body.lead_submit_time,
  };
  return lead;
}

export function googleAdsRouter(deps: Deps): express.Router {
  const router = express.Router();

  router.post("/webhooks/google-ads/:contractorId", (req: Request, res: Response) => {
    const contractor = deps.repo.getContractor(String(req.params.contractorId));
    const body = (req.body ?? {}) as GoogleLeadPayload;
    if (!contractor || !safeEqual(body.google_key, contractor.googleAdsKey)) {
      deps.log.warn("Rejected Google Ads webhook (unknown contractor or wrong key)", { contractorId: req.params.contractorId });
      res.status(403).json({ error: "invalid key" });
      return;
    }
    if (!contractor.active) {
      res.status(200).json({ ok: true, ignored: "contractor inactive" });
      return;
    }
    const result = ingestLead(deps, contractor, mapGoogleLead(body));
    deps.log.info("Google Ads lead ingested", { leadId: result.lead.id, outcome: result.outcome, test: body.is_test });
    res.status(200).json({ ok: true });
  });

  return router;
}
