import crypto from "node:crypto";

export function randomId(prefix: string, bytes = 12): string {
  return `${prefix}_${crypto.randomBytes(bytes).toString("base64url")}`;
}

export function randomSecret(bytes = 24): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function safeEqual(a: string | undefined | null, b: string | undefined | null): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function hmacSha256Hex(key: string, data: string | Buffer): string {
  return crypto.createHmac("sha256", key).update(data).digest("hex");
}

function deriveKey(secret: string, purpose: string): Buffer {
  return crypto.createHash("sha256").update(`${purpose}:${secret}`).digest();
}

/** AES-256-GCM encryption for secrets stored in the database (OAuth tokens). */
export function encrypt(plaintext: string, secret: string): string {
  const key = deriveKey(secret, "encryption");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${enc.toString("base64url")}`;
}

export function decrypt(payload: string, secret: string): string {
  const [version, ivB64, tagB64, dataB64] = payload.split(".");
  if (version !== "v1" || !ivB64 || !tagB64 || dataB64 === undefined) {
    throw new Error("Unrecognized encrypted payload");
  }
  const key = deriveKey(secret, "encryption");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64url")), decipher.final()]).toString("utf8");
}

/** Signed, expiring token (used for OAuth `state`). */
export function signToken(data: Record<string, unknown>, secret: string, ttlSeconds: number, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ ...data, exp: Math.floor(now / 1000) + ttlSeconds })).toString("base64url");
  const sig = crypto.createHmac("sha256", deriveKey(secret, "state")).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyToken<T extends Record<string, unknown>>(token: string, secret: string, now = Date.now()): T | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = crypto.createHmac("sha256", deriveKey(secret, "state")).update(body).digest("base64url");
  if (!safeEqual(sig, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T & { exp: number };
    if (typeof data.exp !== "number" || data.exp * 1000 < now) return null;
    return data;
  } catch {
    return null;
  }
}
