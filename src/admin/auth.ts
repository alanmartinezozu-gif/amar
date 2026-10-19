import type { NextFunction, Request, Response } from "express";
import type { Config } from "../config.js";
import { randomSecret, safeEqual } from "../lib/crypto.js";

/** HTTP Basic auth for the admin dashboard. */
export function basicAuth(config: Config) {
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.get("authorization") ?? "";
    if (header.startsWith("Basic ")) {
      const [user, ...rest] = Buffer.from(header.slice(6), "base64").toString("utf8").split(":");
      const pass = rest.join(":");
      // Compare both even if the first fails, so timing doesn't reveal which was wrong.
      const okUser = safeEqual(user, config.ADMIN_USERNAME);
      const okPass = safeEqual(pass, config.ADMIN_PASSWORD);
      if (okUser && okPass) return next();
    }
    res.set("WWW-Authenticate", 'Basic realm="Speed to Lead admin", charset="UTF-8"');
    res.status(401).send("Authentication required");
  };
}

const CSRF_COOKIE = "stl_csrf";

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

function setCsrfCookie(req: Request, res: Response, token: string): void {
  res.append("Set-Cookie", `${CSRF_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict${req.secure ? "; Secure" : ""}`);
}

/**
 * For pages reached from a cross-site redirect (OAuth callbacks): the SameSite cookie isn't sent on
 * that navigation, so issue a fresh token the page's form can use.
 */
export function issueCsrfToken(req: Request, res: Response): string {
  const token = randomSecret(18);
  setCsrfCookie(req, res, token);
  return token;
}

/**
 * Double-submit CSRF protection. Browsers re-send Basic auth credentials on cross-site form posts,
 * so every admin POST must echo the token from our SameSite cookie.
 */
export function csrf() {
  return (req: Request, res: Response, next: NextFunction) => {
    let token = readCookie(req, CSRF_COOKIE);
    if (!token) {
      token = randomSecret(18);
      setCsrfCookie(req, res, token);
    }
    res.locals.csrf = token;
    if (req.method === "POST") {
      const sent = (req.body as Record<string, unknown> | undefined)?._csrf;
      if (typeof sent !== "string" || !safeEqual(sent, readCookie(req, CSRF_COOKIE))) {
        res.status(403).send("Form expired - go back, refresh the page and try again.");
        return;
      }
    }
    next();
  };
}
