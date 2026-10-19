import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import type Anthropic from "@anthropic-ai/sdk";
import { createApp, registerJobs } from "../src/app.js";
import { CalendarService, type CalendarBackend } from "../src/calendar/service.js";
import type { Interval } from "../src/calendar/slots.js";
import { loadConfig, type Config } from "../src/config.js";
import { openDatabase } from "../src/db/database.js";
import { Repo } from "../src/db/repo.js";
import type { Deps } from "../src/deps.js";
import { JobQueue } from "../src/jobs/queue.js";
import { silentLogger } from "../src/lib/logger.js";
import type { GraphFetch } from "../src/sources/facebook.js";
import type { LlmClient, TurnRequest } from "../src/voice/llm.js";
import type { ConfigureNumberOptions, PlaceCallOptions, Telephony } from "../src/voice/telephony.js";

export const TEST_ENV = {
  PUBLIC_BASE_URL: "https://stl.test",
  APP_SECRET: "test-secret-0123456789",
  ADMIN_PASSWORD: "password123",
  TWILIO_VALIDATE_SIGNATURES: "false",
  TWILIO_DEFAULT_NUMBER: "+15125550000",
  FACEBOOK_APP_ID: "fb-app",
  FACEBOOK_APP_SECRET: "fb-secret",
  FACEBOOK_VERIFY_TOKEN: "fb-verify",
};

export class FakeTelephony implements Telephony {
  calls: PlaceCallOptions[] = [];
  sms: Array<{ to: string; from: string; body: string }> = [];
  updates: Array<{ sid: string; twiml: string }> = [];
  hangups: string[] = [];
  configured: ConfigureNumberOptions[] = [];
  failNextCall: Error | null = null;
  private n = 0;

  async placeCall(opts: PlaceCallOptions) {
    if (this.failNextCall) {
      const err = this.failNextCall;
      this.failNextCall = null;
      throw err;
    }
    this.calls.push(opts);
    return { sid: `CA${String(++this.n).padStart(32, "0")}` };
  }
  async updateCallTwiml(sid: string, twiml: string) {
    this.updates.push({ sid, twiml });
  }
  async hangup(sid: string) {
    this.hangups.push(sid);
  }
  async sendSms(opts: { to: string; from: string; body: string }) {
    this.sms.push(opts);
    return { sid: `SM${this.sms.length}` };
  }
  validateSignature() {
    return true;
  }
  async configureNumber(opts: ConfigureNumberOptions) {
    this.configured.push(opts);
  }
}

export interface ScriptedReply {
  text?: string;
  tools?: Array<{ name: string; input: Record<string, unknown> }>;
  stop?: Anthropic.Beta.BetaMessage["stop_reason"];
  /** Wait this long before streaming (lets tests interrupt mid-generation). */
  delayMs?: number;
}

/** Fake model: each turn calls `script(messages)` to decide what Claude "says". */
export class ScriptedLlm implements LlmClient {
  requests: Array<Omit<TurnRequest, "signal" | "onText">> = [];
  /** Exceptions thrown by `script` (e.g. failed expectations), kept so tests can report them. */
  errors: unknown[] = [];
  private toolCounter = 0;

  constructor(public script: (messages: Anthropic.Beta.BetaMessageParam[], turn: number) => ScriptedReply) {}

  async streamTurn(req: TurnRequest): Promise<Anthropic.Beta.BetaMessage> {
    // Deep-copy: the session keeps appending to the same array.
    this.requests.push({ system: req.system, tools: req.tools, messages: structuredClone(req.messages) });
    let reply: ScriptedReply;
    try {
      reply = this.script(req.messages, this.requests.length);
    } catch (err) {
      this.errors.push(err);
      throw err;
    }
    if (reply.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, reply.delayMs);
        req.signal.addEventListener("abort", () => {
          clearTimeout(t);
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    }
    if (req.signal.aborted) {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }
    const content: Anthropic.Beta.BetaContentBlock[] = [];
    // Real responses on this model start with a (redacted-by-default) thinking block that must round-trip.
    content.push({ type: "thinking", thinking: "", signature: `sig-${this.requests.length}` } as Anthropic.Beta.BetaContentBlock);
    if (reply.text) {
      for (const word of reply.text.split(/(?<= )/)) req.onText(word);
      content.push({ type: "text", text: reply.text, citations: null } as Anthropic.Beta.BetaContentBlock);
    }
    for (const t of reply.tools ?? []) {
      content.push({ type: "tool_use", id: `toolu_${++this.toolCounter}`, name: t.name, input: t.input } as Anthropic.Beta.BetaContentBlock);
    }
    return {
      id: `msg_${this.requests.length}`,
      type: "message",
      role: "assistant",
      model: "test-model",
      content,
      stop_reason: reply.stop ?? (reply.tools?.length ? "tool_use" : "end_turn"),
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    } as unknown as Anthropic.Beta.BetaMessage;
  }

  async complete(): Promise<string> {
    return "Test summary: homeowner with a roof leak wants an estimate.";
  }
}

export class FakeCalendarBackend implements CalendarBackend {
  busyIntervals: Interval[] = [];
  events: Array<{ contractorId: string; calendarId: string; summary: string; start: Date; end: Date; location?: string }> = [];
  async busy() {
    return this.busyIntervals;
  }
  async createEvent(contractorId: string, calendarId: string, e: { summary: string; start: Date; end: Date; location?: string }) {
    this.events.push({ contractorId, calendarId, ...e });
    return { id: `evt_${this.events.length}` };
  }
}

export class TestClock {
  constructor(public current: Date) {}
  now = () => new Date(this.current);
  advance(ms: number) {
    this.current = new Date(this.current.getTime() + ms);
  }
  set(iso: string) {
    this.current = new Date(iso);
  }
}

export interface TestEnv {
  deps: Deps;
  repo: Repo;
  telephony: FakeTelephony;
  llm: ScriptedLlm;
  calendarBackend: FakeCalendarBackend;
  clock: TestClock;
  config: Config;
  graph: { calls: Array<{ path: string; params: Record<string, string>; method: string }>; responses: Map<string, unknown> };
}

/** Tuesday 2026-10-20 10:00 in Chicago - inside default calling, transfer and booking hours. */
export const TUESDAY_10AM_CHICAGO = "2026-10-20T15:00:00.000Z";

export function createTestEnv(env: Record<string, string> = {}, startAt = TUESDAY_10AM_CHICAGO): TestEnv {
  const config = loadConfig({ ...TEST_ENV, ...env });
  const clock = new TestClock(new Date(startAt));
  const repo = new Repo(openDatabase(":memory:"), clock.now);
  const telephony = new FakeTelephony();
  const llm = new ScriptedLlm(() => ({ text: "Okay." }));
  const calendarBackend = new FakeCalendarBackend();
  const graph: TestEnv["graph"] = { calls: [], responses: new Map() };
  const graphFetch: GraphFetch = async <T>(path: string, params: Record<string, string>, method = "GET") => {
    graph.calls.push({ path, params, method });
    if (!graph.responses.has(path)) throw new Error(`no fake graph response for ${path}`);
    return graph.responses.get(path) as T;
  };
  const deps: Deps = {
    config,
    repo,
    telephony,
    llm,
    calendar: new CalendarService(repo, calendarBackend, clock.now),
    jobs: new JobQueue(repo, silentLogger, clock.now),
    log: silentLogger,
    clock: clock.now,
    graphFetch,
  };
  registerJobs(deps);
  return { deps, repo, telephony, llm, calendarBackend, clock, config, graph };
}

export function createContractor(t: TestEnv, settings: Record<string, unknown> = {}) {
  return t.repo.createContractor({
    name: "Summit Roofing",
    timezone: "America/Chicago",
    twilioNumber: "+15125550100",
    settings: {
      services: "roofing and gutters",
      serviceArea: "Austin, TX",
      transferTargets: [{ name: "Mike", role: "Owner", phone: "+15125550111" }],
      ...settings,
    },
  });
}

/** A live HTTP + WebSocket server for flow tests. */
export async function startServer(t: TestEnv) {
  const { app, server } = createApp(t.deps, { speechWait: async () => {}, silenceTimeoutMs: 5_000 });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    app,
    server,
    port,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** Plays Twilio's side of a ConversationRelay WebSocket. */
export class RelayClient {
  received: Array<Record<string, unknown>> = [];
  private ws: WebSocket;
  private waiters: Array<{ pred: (m: Record<string, unknown>) => boolean; resolve: (m: Record<string, unknown>) => void }> = [];
  closed = false;

  constructor(port: number) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/twilio/relay`);
    this.ws.on("message", (data) => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>;
      this.received.push(msg);
      this.waiters = this.waiters.filter((w) => {
        if (!w.pred(msg)) return true;
        w.resolve(msg);
        return false;
      });
    });
    this.ws.on("close", () => (this.closed = true));
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("error", reject);
    });
  }

  send(msg: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(msg));
  }

  setup(callId: string, callSid: string): void {
    this.send({ type: "setup", sessionId: "VX1", callSid, from: "+15125550100", to: "+15128675309", direction: "outbound-api", customParameters: { callId } });
  }

  say(text: string): void {
    this.send({ type: "prompt", voicePrompt: text, lang: "en-US", last: true });
  }

  /** Text spoken since index `from` (tokens joined). */
  spokenSince(from: number): string {
    return this.received
      .slice(from)
      .filter((m) => m.type === "text")
      .map((m) => String(m.token))
      .join("");
  }

  waitFor(pred: (m: Record<string, unknown>) => boolean, timeoutMs = 3000): Promise<Record<string, unknown>> {
    const existing = this.received.find(pred);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for relay message; got ${JSON.stringify(this.received)}`)), timeoutMs);
      this.waiters.push({
        pred,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  }

  /** Wait until everything spoken on this socket contains `fragment`. */
  waitForSpoken(fragment: string, timeoutMs = 3000): Promise<void> {
    return this.waitFor(() => this.spokenSince(0).includes(fragment), timeoutMs).then(() => undefined);
  }

  /** Wait for the end of the next spoken reply after index `from`. */
  waitForReplyEnd(from: number, timeoutMs = 3000): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no reply; got ${JSON.stringify(this.received.slice(from))}`)), timeoutMs);
      const check = () => {
        const idx = this.received.findIndex((m, i) => i >= from && m.type === "text" && m.last === true);
        if (idx >= 0) {
          clearTimeout(timer);
          resolve(this.spokenSince(from));
          return true;
        }
        return false;
      };
      if (check()) return;
      this.waiters.push({ pred: () => check(), resolve: () => {} });
    });
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise((r) => {
      this.ws.once("close", () => r());
      this.ws.close();
    });
  }
}

/** Every request's history must be valid for the API: tool_use answered by tool_result, nothing edited. */
export function assertAppendOnly(requests: Array<{ messages: Anthropic.Beta.BetaMessageParam[] }>): void {
  for (let i = 1; i < requests.length; i++) {
    const prev = JSON.stringify(requests[i - 1].messages);
    const cur = JSON.stringify(requests[i].messages.slice(0, requests[i - 1].messages.length));
    if (prev !== cur) throw new Error(`request ${i + 1} edited earlier history`);
  }
  for (const r of requests) {
    const m = r.messages;
    for (let i = 0; i < m.length; i++) {
      const msg = m[i];
      if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
      const uses = msg.content.filter((b) => b.type === "tool_use").map((b) => (b as { id: string }).id);
      if (uses.length === 0) continue;
      const next = m[i + 1];
      if (!next) continue; // the request we're about to answer can't end with an unanswered tool_use, checked below
      const results = Array.isArray(next.content) ? next.content.filter((b) => b.type === "tool_result").map((b) => (b as { tool_use_id: string }).tool_use_id) : [];
      for (const id of uses) if (!results.includes(id)) throw new Error(`tool_use ${id} not answered by the next message`);
    }
    if (m[m.length - 1]?.role !== "user") throw new Error("a request must end with a user message");
  }
}
