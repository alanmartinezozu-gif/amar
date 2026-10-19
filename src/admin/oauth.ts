import express, { type Request, type Response } from "express";
import type { Deps } from "../deps.js";
import { completeGoogleOAuth } from "../calendar/google.js";
import { decrypt, encrypt, verifyToken } from "../lib/crypto.js";
import { connectFacebookPage, listPagesForCode, type ConnectablePage } from "../sources/facebook.js";
import { issueCsrfToken } from "./auth.js";
import { facebookPickPage, messagePage } from "./views.js";

interface OAuthState extends Record<string, unknown> {
  c: string;
  p: "facebook" | "google";
}

interface PageBlob {
  contractorId: string;
  pages: ConnectablePage[];
  exp: number;
}

function fail(req: Request, res: Response, text: string): void {
  res.status(400).send(messagePage("Couldn't connect", text, { csrf: issueCsrfToken(req, res) }));
}

/** OAuth redirect targets. Not behind Basic auth (a cross-site redirect); the signed `state` authorizes them. */
export function oauthRouter(deps: Deps): express.Router {
  const router = express.Router();

  router.get("/oauth/facebook/callback", async (req, res) => {
    const state = verifyToken<OAuthState>(String(req.query.state ?? ""), deps.config.APP_SECRET);
    const contractor = state?.p === "facebook" ? deps.repo.getContractor(state.c) : null;
    if (!contractor) return fail(req, res, "This connect link expired. Start again from the contractor page.");
    if (req.query.error || !req.query.code) return fail(req, res, `Facebook said: ${String(req.query.error_description ?? req.query.error ?? "no code")}`);
    try {
      const pages = await listPagesForCode(deps, String(req.query.code));
      const blob: PageBlob = { contractorId: contractor.id, pages, exp: deps.clock().getTime() + 15 * 60_000 };
      res.send(
        facebookPickPage(
          { contractor, pages: pages.map((p) => ({ id: p.id, name: p.name })), blob: encrypt(JSON.stringify(blob), deps.config.APP_SECRET) },
          { csrf: issueCsrfToken(req, res) },
        ),
      );
    } catch (err) {
      deps.log.error("Facebook OAuth failed", { err });
      fail(req, res, `Facebook error: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  router.get("/oauth/google/callback", async (req, res) => {
    const state = verifyToken<OAuthState>(String(req.query.state ?? ""), deps.config.APP_SECRET);
    const contractor = state?.p === "google" ? deps.repo.getContractor(state.c) : null;
    if (!contractor) return fail(req, res, "This connect link expired. Start again from the contractor page.");
    if (req.query.error || !req.query.code) return fail(req, res, `Google said: ${String(req.query.error ?? "no code")}`);
    try {
      const email = await completeGoogleOAuth(deps.config, deps.repo, contractor.id, String(req.query.code));
      deps.repo.addEvent({ contractorId: contractor.id, type: "calendar_connected", message: `Google Calendar connected (${email ?? "unknown account"})` });
      res.redirect(303, `/admin/contractors/${contractor.id}?ok=${encodeURIComponent(`Google Calendar connected${email ? ` (${email})` : ""}.`)}`);
    } catch (err) {
      deps.log.error("Google OAuth failed", { err });
      fail(req, res, `Google error: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  return router;
}

/** POST /admin/oauth/facebook/select - subscribe the pages the admin ticked. */
export async function finishFacebookSelection(deps: Deps, req: Request, res: Response): Promise<void> {
  const body = req.body as Record<string, string | string[] | undefined>;
  let blob: PageBlob;
  try {
    blob = JSON.parse(decrypt(String(body.blob ?? ""), deps.config.APP_SECRET)) as PageBlob;
  } catch {
    return fail(req, res, "That form was tampered with or is too old. Start again.");
  }
  if (blob.exp < deps.clock().getTime() || blob.contractorId !== body.contractorId) {
    return fail(req, res, "That form expired. Start again from the contractor page.");
  }
  const selected = new Set(([] as string[]).concat(body.pageIds ?? []));
  const chosen = blob.pages.filter((p) => selected.has(p.id));
  const errors: string[] = [];
  for (const page of chosen) {
    try {
      await connectFacebookPage(deps, blob.contractorId, page);
    } catch (err) {
      errors.push(`${page.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const q = errors.length
    ? `error=${encodeURIComponent(`Some pages failed - ${errors.join("; ")}`)}`
    : `ok=${encodeURIComponent(`Connected ${chosen.length} page(s). New leads will be called automatically.`)}`;
  res.redirect(303, `/admin/contractors/${blob.contractorId}?${q}`);
}
