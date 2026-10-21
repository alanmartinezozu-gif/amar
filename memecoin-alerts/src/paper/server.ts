import http from "node:http";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verifyAlertSignature, type CoinAlert } from "../events.js";
import type { Logger } from "../logger.js";

const MAX_BODY_BYTES = 1_000_000;
const MAX_REMEMBERED_IDS = 10_000;

/** Receives the alert bot's signed webhook. Unsigned, tampered or replayed requests get a 401. */
export function createAlertServer(secret: string, onAlert: (alert: CoinAlert) => void, log: Logger): http.Server {
  const seen = new Set<string>();
  return http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/alerts") {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        res.writeHead(413).end();
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const header = (name: string) => req.headers[name] as string | undefined;
      if (!verifyAlertSignature(secret, header(TIMESTAMP_HEADER), body, header(SIGNATURE_HEADER))) {
        log.warn("Rejected an alert with a missing or bad signature");
        res.writeHead(401).end();
        return;
      }
      let alert: CoinAlert;
      try {
        alert = JSON.parse(body) as CoinAlert;
      } catch {
        res.writeHead(400).end();
        return;
      }
      res.writeHead(204).end();
      if (seen.has(alert.id)) return;
      seen.add(alert.id);
      if (seen.size > MAX_REMEMBERED_IDS) seen.delete(seen.values().next().value!);
      onAlert(alert);
    });
  });
}
