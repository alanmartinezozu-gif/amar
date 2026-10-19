import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { relayUrl } from "../config.js";
import type { Deps } from "../deps.js";
import { CallSession, type SessionOptions } from "./session.js";

interface RelayMessage {
  type: string;
  callSid?: string;
  customParameters?: Record<string, string>;
  voicePrompt?: string;
  last?: boolean;
  utteranceUntilInterrupt?: string;
  digit?: string;
  description?: string;
}

/**
 * WebSocket endpoint Twilio ConversationRelay connects to (wss://<server>/twilio/relay).
 * Each connection is one stretch of AI conversation on one call.
 */
export function createRelayServer(deps: Deps, sessionOptions: SessionOptions = {}) {
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws: WebSocket) => {
    let session: CallSession | null = null;
    const log = deps.log.child({ component: "relay" });

    ws.on("message", (data) => {
      let msg: RelayMessage;
      try {
        msg = JSON.parse(data.toString()) as RelayMessage;
      } catch {
        log.warn("Ignoring non-JSON relay message");
        return;
      }
      switch (msg.type) {
        case "setup": {
          const callId = msg.customParameters?.callId;
          session = callId
            ? CallSession.open(deps, { send: (m) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m)) }, callId, msg.callSid, sessionOptions)
            : null;
          if (!session) {
            log.warn("Relay setup for unknown call - closing", { callId, callSid: msg.callSid });
            ws.close(1008, "unknown call");
          }
          break;
        }
        case "prompt":
          if (msg.last !== false) session?.onPrompt(msg.voicePrompt ?? "");
          break;
        case "interrupt":
          session?.onInterrupt(msg.utteranceUntilInterrupt ?? "");
          break;
        case "dtmf":
          if (msg.digit) session?.onDtmf(msg.digit);
          break;
        case "error":
          log.error("ConversationRelay reported an error", { description: msg.description });
          break;
        default:
          break;
      }
    });

    ws.on("close", () => session?.dispose());
    ws.on("error", (err) => log.warn("Relay socket error", { err }));
  });

  /** Hook for the HTTP server's `upgrade` event. Returns false if the path isn't ours. */
  function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const path = (req.url ?? "").split("?")[0];
    if (path !== "/twilio/relay") return false;
    if (deps.config.TWILIO_VALIDATE_SIGNATURES) {
      const signature = req.headers["x-twilio-signature"];
      // Twilio signs the WebSocket URL. The setup message's CallSid is also checked against our records.
      const url = relayUrl(deps.config) + (req.url?.includes("?") ? req.url.slice(req.url.indexOf("?")) : "");
      if (typeof signature !== "string" || !deps.telephony.validateSignature(signature, url, {})) {
        deps.log.warn("Rejected relay connection with a bad Twilio signature");
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return true;
      }
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    return true;
  }

  return { wss, handleUpgrade };
}
