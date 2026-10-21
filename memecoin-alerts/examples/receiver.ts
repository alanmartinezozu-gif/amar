// Starting point for your own bot: receives the alert bot's webhook, checks the signature, and
// hands you each alert as data. It only prints them; what you do with an alert is up to you.
//
//   ALERT_WEBHOOK_SECRET=... npm run example:receiver
//   (and in the alert bot's .env: ALERT_WEBHOOK_URL=http://localhost:8787/alerts)
import "dotenv/config";
import http from "node:http";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verifyAlertSignature, type CoinAlert } from "../src/events.js";

const secret = process.env.ALERT_WEBHOOK_SECRET;
if (!secret) throw new Error("Set ALERT_WEBHOOK_SECRET to the same value the alert bot uses");
const port = Number(process.env.RECEIVER_PORT ?? 8787);
const seen = new Set<string>();

function handle(alert: CoinAlert): void {
  if (seen.has(alert.id)) return; // deliveries can repeat
  seen.add(alert.id);
  const flags = alert.safety?.flags.join(", ") || "none";
  console.log(`${alert.type} ${alert.symbol ?? "?"} ${alert.mint} from ${alert.source} | red flags: ${flags}`);
}

http
  .createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/alerts") return void res.writeHead(404).end();
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const ok = verifyAlertSignature(secret, req.headers[TIMESTAMP_HEADER] as string, body, req.headers[SIGNATURE_HEADER] as string);
      if (!ok) return void res.writeHead(401).end();
      res.writeHead(204).end();
      handle(JSON.parse(body) as CoinAlert);
    });
  })
  .listen(port, () => console.log(`Listening for alerts on http://localhost:${port}/alerts`));
