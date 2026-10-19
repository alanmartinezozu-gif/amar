import http from "node:http";
import express, { type NextFunction, type Request, type Response } from "express";
import type { Deps } from "./deps.js";
import { adminRouter } from "./admin/routes.js";
import { oauthRouter } from "./admin/oauth.js";
import { registerNotificationJobs } from "./notify/notify.js";
import { facebookWebhookRouter, registerFacebookJobs } from "./sources/facebook.js";
import { googleAdsRouter } from "./sources/googleAds.js";
import { websiteRouter } from "./sources/website.js";
import { registerDialerJobs } from "./voice/dialer.js";
import { registerPostCallJobs } from "./voice/postCall.js";
import { createRelayServer } from "./voice/relay.js";
import { twilioRouter } from "./voice/routes.js";
import type { SessionOptions } from "./voice/session.js";

export function registerJobs(deps: Deps): void {
  registerDialerJobs(deps);
  registerPostCallJobs(deps);
  registerNotificationJobs(deps);
  registerFacebookJobs(deps);
}

export function createApp(deps: Deps, sessionOptions: SessionOptions = {}) {
  const app = express();
  // Behind one reverse proxy (Railway, Render, Fly, nginx): use its X-Forwarded-* headers.
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  const keepRaw = (req: Request, _res: Response, buf: Buffer) => {
    req.rawBody = buf;
  };
  app.use(express.json({ limit: "1mb", verify: keepRaw }));
  app.use(express.urlencoded({ extended: false, limit: "1mb", verify: keepRaw }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });
  app.get("/", (_req, res) => res.redirect("/admin"));

  app.use(facebookWebhookRouter(deps));
  app.use(googleAdsRouter(deps));
  app.use(websiteRouter(deps));
  app.use(twilioRouter(deps));
  app.use(oauthRouter(deps));
  app.use(adminRouter(deps));

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    deps.log.error("Request failed", { err, path: req.path });
    if (res.headersSent) return;
    if (req.path.startsWith("/twilio/voice")) {
      // Keep the caller from hearing Twilio's generic "application error" message.
      res.type("text/xml").send("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response><Hangup/></Response>");
      return;
    }
    res.status(500).json({ error: "internal error" });
  });

  const server = http.createServer(app);
  const relay = createRelayServer(deps, sessionOptions);
  server.on("upgrade", (req, socket, head) => {
    if (!relay.handleUpgrade(req, socket, head)) socket.destroy();
  });

  return { app, server, relay };
}
