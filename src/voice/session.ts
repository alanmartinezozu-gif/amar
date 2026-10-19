import type Anthropic from "@anthropic-ai/sdk";
import type { Deps } from "../deps.js";
import type { Call, Contractor, Lead, TranscriptEntry } from "../domain/types.js";
import type { Logger } from "../lib/logger.js";
import { isAbortError, type BetaMessageParam, type BetaTextBlockParam, type BetaTool } from "./llm.js";
import { applyEndCall, transferAvailability } from "./outcomes.js";
import { buildCallContext, buildSystemPrompt, buildTools, inboundGreeting, outboundOpener } from "./prompt.js";
import { executeTool, type Terminal } from "./tools.js";

type ContentBlock = Anthropic.Beta.BetaContentBlockParam;
type ToolResult = Anthropic.Beta.BetaToolResultBlockParam;
type ToolUse = Anthropic.Beta.BetaToolUseBlock;

/** Messages we send to Twilio ConversationRelay. */
export interface RelayOutput {
  send(message: Record<string, unknown>): void;
}

export interface SessionOptions {
  /** Waits for the AI's last words to finish playing before handing the call off. Instant in tests. */
  speechWait?: (ms: number) => Promise<void>;
  /** On outbound calls, speak first if the person who answered stays silent this long. */
  silenceTimeoutMs?: number;
}

/** Tools slow enough that silence would feel awkward - say a filler line while they run. */
const SLOW_TOOLS = new Set(["check_availability", "book_appointment"]);
const MAX_TOOL_ROUNDS = 6;

export function estimateSpeechMs(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return words === 0 ? 0 : 600 + words * 360;
}

/** Strip things text-to-speech would read out loud ("asterisk"). */
function speakable(text: string): string {
  return text.replace(/[*#`_~|<>]/g, "");
}

const SORRY_LINE =
  "Sorry, I'm having a little trouble on my end. I'll have someone from the team give you a call right back. Thanks for your patience!";

/**
 * One live AI conversation over a ConversationRelay WebSocket.
 *
 * Twilio turns the caller's speech into `prompt` messages; we stream Claude's reply back as `text`
 * tokens, which Twilio speaks. The conversation history is append-only and saved after every
 * change, so when a transfer fails and Twilio reconnects the AI, it picks up exactly where it left off.
 */
export class CallSession {
  private messages: BetaMessageParam[];
  private transcript: TranscriptEntry[];
  /** Tool results (and notes) that go at the front of the next user message. */
  private pending: ContentBlock[] = [];
  private notes: string[] = [];
  private inbox: string[] = [];
  private processing = false;
  private abort: AbortController | null = null;
  private spoken = "";
  private heardBeforeInterrupt: string | null = null;
  private awaitingFirstWords = false;
  private silenceTimer: NodeJS.Timeout | null = null;
  private speechEndsAt = 0;
  private ending = false;
  private disposed = false;
  private followUpReason: string | null = null;
  private readonly system: BetaTextBlockParam[];
  private readonly tools: BetaTool[];
  private readonly log: Logger;
  private readonly speechWait: (ms: number) => Promise<void>;

  private constructor(
    private readonly deps: Deps,
    private readonly out: RelayOutput,
    private readonly contractor: Contractor,
    private readonly callId: string,
    private readonly opts: SessionOptions,
  ) {
    const call = deps.repo.getCall(callId)!;
    this.messages = call.conversation;
    this.transcript = call.transcript;
    this.pending = [...call.pendingToolResults];
    this.system = buildSystemPrompt(contractor);
    this.tools = buildTools(contractor);
    this.log = deps.log.child({ callId });
    this.speechWait = opts.speechWait ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Called on the relay `setup` message. Returns null if the call is unknown (or the CallSid doesn't match). */
  static open(deps: Deps, out: RelayOutput, callId: string, callSid: string | undefined, opts: SessionOptions = {}): CallSession | null {
    const call = deps.repo.getCall(callId);
    if (!call) return null;
    if (call.twilioCallSid && callSid && call.twilioCallSid !== callSid) {
      deps.log.warn("Relay setup CallSid mismatch", { callId, expected: call.twilioCallSid, got: callSid });
      return null;
    }
    const contractor = deps.repo.getContractor(call.contractorId);
    if (!contractor) return null;
    deps.repo.updateCall(call.id, {
      status: "in-progress",
      twilioCallSid: call.twilioCallSid ?? callSid ?? null,
      answeredAt: call.answeredAt ?? deps.clock().toISOString(),
    });
    const session = new CallSession(deps, out, contractor, callId, opts);
    session.begin();
    return session;
  }

  private call(): Call {
    return this.deps.repo.getCall(this.callId)!;
  }

  private lead(): Lead {
    return this.deps.repo.getLead(this.call().leadId)!;
  }

  private begin(): void {
    const call = this.call();
    const lead = this.lead();
    if (lead.status !== "booked" && lead.status !== "transferred") this.deps.repo.setLeadStatus(lead.id, "in_conversation");
    if (call.phase === "transferring") this.deps.repo.updateCall(call.id, { phase: "booking" });
    if (this.messages.length > 0) return; // resuming (after a failed transfer, or a dropped socket)

    if (call.direction === "inbound") {
      const greeting = inboundGreeting(this.contractor, lead);
      this.messages.push(
        { role: "user", content: `${this.contextFor(call, lead)}\n\nThe call connected.` },
        { role: "assistant", content: greeting },
      );
      this.addTranscript("assistant", greeting); // spoken by Twilio as the welcome greeting
      this.persist();
      return;
    }
    this.awaitingFirstWords = true;
    this.silenceTimer = setTimeout(() => this.openOutbound(null), this.opts.silenceTimeoutMs ?? 2500);
  }

  private contextFor(call: Call, lead: Lead): string {
    return buildCallContext({
      contractor: this.contractor,
      lead,
      direction: call.direction,
      now: this.deps.clock(),
      transfer: transferAvailability(this.contractor, call, this.deps.clock()),
      bookingMode: this.deps.calendar.mode(this.contractor),
      previousAttempts: Math.max(0, call.attempt - 1),
      reason: call.reason ?? undefined,
    });
  }

  /** The opener is a template, so the lead hears us instantly instead of waiting on the model. */
  private openOutbound(firstWords: string | null): void {
    if (!this.awaitingFirstWords || this.disposed) return;
    this.awaitingFirstWords = false;
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    const call = this.call();
    const lead = this.lead();
    const opener = outboundOpener(this.contractor, lead, call.reason ?? undefined);
    const connected = firstWords
      ? `The call connected and they answered: "${firstWords}"`
      : "The call connected, but they haven't said anything yet.";
    this.messages.push(
      { role: "user", content: `${this.contextFor(call, lead)}\n\n${connected}` },
      { role: "assistant", content: opener },
    );
    this.sayAll(opener);
    this.persist();
  }

  /* ------------------------------ relay input ------------------------------ */

  onPrompt(text: string): void {
    const said = text.trim();
    if (!said || this.disposed) return;
    this.addTranscript("caller", said);
    if (this.ending) {
      this.persist();
      return;
    }
    if (this.awaitingFirstWords) {
      this.openOutbound(said);
      return;
    }
    this.inbox.push(said);
    // They kept talking while we were still composing a reply: start over with everything they said.
    this.abort?.abort();
    void this.process();
  }

  onInterrupt(heardSoFar: string): void {
    const heard = heardSoFar.trim();
    if (this.abort) {
      this.heardBeforeInterrupt = heard;
      this.abort.abort();
    } else if (heard) {
      this.notes.push(`(The caller interrupted you. They only heard: "${heard}")`);
    }
    const last = [...this.transcript].reverse().find((t) => t.role === "assistant");
    if (last && heard && heard.length < last.text.length) last.text = `${heard}...`;
    this.speechEndsAt = Date.now();
  }

  onDtmf(digit: string): void {
    this.onPrompt(`(pressed ${digit} on the keypad)`);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.abort?.abort();
    this.persist();
  }

  /* ------------------------------ conversation ----------------------------- */

  private async process(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.inbox.length > 0 && !this.ending && !this.disposed) {
        const content: ContentBlock[] = [...this.pending, ...this.takeNotes(), { type: "text", text: this.inbox.splice(0).join(" ") }];
        if (this.pending.length) this.deps.repo.updateCall(this.callId, { pendingToolResults: [] });
        this.pending = [];
        this.messages.push({ role: "user", content });
        this.persist();
        await this.respond();
      }
    } catch (err) {
      this.log.error("Conversation loop crashed", { err });
      await this.failGracefully();
    } finally {
      this.processing = false;
    }
  }

  private takeNotes(): ContentBlock[] {
    const notes = this.notes.splice(0);
    return notes.length ? [{ type: "text", text: notes.join("\n") }] : [];
  }

  /** Run the model until it finishes its turn, hands off, or gets interrupted. */
  private async respond(): Promise<void> {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      this.spoken = "";
      this.heardBeforeInterrupt = null;
      const controller = new AbortController();
      this.abort = controller;
      let message: Anthropic.Beta.BetaMessage;
      try {
        message = await this.deps.llm.streamTurn({
          system: this.system,
          tools: this.tools,
          messages: this.messages,
          signal: controller.signal,
          onText: (delta) => {
            if (!controller.signal.aborted) this.speak(delta);
          },
        });
      } catch (err) {
        if (isAbortError(err) || controller.signal.aborted) {
          this.recordInterruptedReply();
          return;
        }
        this.log.error("Model request failed", { err });
        await this.failGracefully();
        return;
      } finally {
        this.abort = null;
      }
      if (controller.signal.aborted) {
        this.recordInterruptedReply();
        return;
      }

      this.finishSpeaking();
      if (message.stop_reason === "refusal") {
        this.log.warn("Model declined to continue", { stopDetails: message.stop_details });
        await this.failGracefully();
        return;
      }
      this.messages.push({ role: "assistant", content: message.content });
      if (this.spoken.trim()) this.addTranscript("assistant", this.spoken.trim());

      const toolUses = message.content.filter((b): b is ToolUse => b.type === "tool_use");
      if (toolUses.length === 0) {
        this.persist();
        return;
      }

      if (!this.spoken.trim() && toolUses.some((t) => SLOW_TOOLS.has(t.name))) {
        this.sayAll(toolUses.some((t) => t.name === "book_appointment") ? "Perfect, one sec while I lock that in." : "Let me take a look at the schedule.");
      }

      const results: ToolResult[] = [];
      let terminal: { terminal: Terminal; toolUseId: string } | null = null;
      for (const use of toolUses) {
        if (message.stop_reason === "max_tokens") {
          results.push({ type: "tool_result", tool_use_id: use.id, content: "Your request was cut off. Please try again.", is_error: true });
          continue;
        }
        if (terminal) {
          results.push({ type: "tool_result", tool_use_id: use.id, content: "Skipped: the call was already being handed off.", is_error: true });
          continue;
        }
        const outcome = await executeTool(
          { deps: this.deps, contractor: this.contractor, callId: this.callId, flagFollowUp: (r) => (this.followUpReason = r) },
          use.name,
          use.input,
        );
        this.log.info("Tool call", { tool: use.name, isError: outcome.isError ?? false, terminal: outcome.terminal?.kind });
        if (outcome.terminal) terminal = { terminal: outcome.terminal, toolUseId: use.id };
        else results.push({ type: "tool_result", tool_use_id: use.id, content: outcome.content, ...(outcome.isError ? { is_error: true } : {}) });
      }

      if (terminal) {
        await this.handOff(terminal.terminal, terminal.toolUseId, results);
        return;
      }
      // Anything the caller said while the tools ran rides along with the results.
      const followUp: ContentBlock[] = [...this.takeNotes()];
      if (this.inbox.length) followUp.push({ type: "text", text: this.inbox.splice(0).join(" ") });
      this.messages.push({ role: "user", content: [...results, ...followUp] });
      this.persist();
      if (this.disposed) return;
    }
    this.log.warn("Too many tool rounds in one turn");
  }

  /** Keep the history honest: record only what the caller actually heard before cutting in. */
  private recordInterruptedReply(): void {
    // Twilio already cut the audio on a barge-in; otherwise close the half-sent sentence so the
    // next reply doesn't get glued onto it.
    if (this.spoken && this.heardBeforeInterrupt === null) this.send({ type: "text", token: "", last: true });
    const heard = (this.heardBeforeInterrupt ?? this.spoken).trim();
    if (heard) {
      this.messages.push({ role: "assistant", content: [{ type: "text", text: heard }] });
      this.addTranscript("assistant", `${heard}...`);
    }
    this.persist();
  }

  /** Transfer to a person, or hang up, after the AI's last words have been spoken. */
  private async handOff(terminal: Terminal, toolUseId: string, otherResults: ToolResult[]): Promise<void> {
    this.ending = true;
    const line = terminal.kind === "transfer" ? terminal.say : terminal.closing;
    if (!this.spoken.trim() && line.trim()) this.sayAll(line);

    if (terminal.kind === "transfer") {
      // The transfer's result is its outcome; it's added when the AI resumes (if nobody answered).
      this.deps.repo.updateCall(this.callId, { phase: "transferring", pendingToolResults: otherResults });
      this.persist();
      await this.waitForSpeech();
      this.send({ type: "end", handoffData: JSON.stringify({ action: "transfer" }) });
      return;
    }

    this.messages.push({ role: "user", content: [...otherResults, { type: "tool_result", tool_use_id: toolUseId, content: "Call ended." }] });
    this.persist();
    applyEndCall(this.deps, this.contractor, this.call(), { outcome: terminal.outcome, notes: terminal.notes, callbackTime: terminal.callbackTime });
    this.applyFollowUpFlag();
    await this.waitForSpeech();
    this.send({ type: "end", handoffData: JSON.stringify({ action: terminal.outcome === "voicemail" ? "voicemail" : "hangup" }) });
  }

  private applyFollowUpFlag(): void {
    if (!this.followUpReason) return;
    const lead = this.lead();
    if (lead.status !== "booked" && lead.status !== "transferred" && lead.status !== "do_not_call") {
      this.deps.repo.setLeadStatus(lead.id, "needs_followup");
    }
    this.deps.repo.addEvent({ contractorId: this.contractor.id, leadId: lead.id, callId: this.callId, type: "needs_followup", message: this.followUpReason });
  }

  private async failGracefully(): Promise<void> {
    if (this.ending) return;
    this.ending = true;
    this.sayAll(SORRY_LINE);
    this.deps.repo.updateCall(this.callId, { outcome: "error" });
    this.followUpReason ??= "the AI assistant hit an error mid-call";
    this.applyFollowUpFlag();
    this.persist();
    await this.waitForSpeech();
    this.send({ type: "end", handoffData: JSON.stringify({ action: "hangup" }) });
  }

  /* --------------------------------- output -------------------------------- */

  private send(message: Record<string, unknown>): void {
    if (this.disposed) return;
    try {
      this.out.send(message);
    } catch (err) {
      this.log.warn("Relay send failed", { err });
    }
  }

  private speak(delta: string): void {
    const token = speakable(delta);
    if (!token) return;
    this.spoken += token;
    this.send({ type: "text", token, last: false });
  }

  /** Marks the end of a spoken reply so Twilio flushes it to text-to-speech. */
  private finishSpeaking(): void {
    if (!this.spoken) return;
    this.send({ type: "text", token: "", last: true });
    this.speechEndsAt = Math.max(Date.now(), this.speechEndsAt) + estimateSpeechMs(this.spoken);
  }

  private sayAll(text: string): void {
    const token = speakable(text);
    this.send({ type: "text", token, last: true });
    this.speechEndsAt = Math.max(Date.now(), this.speechEndsAt) + estimateSpeechMs(token);
    this.addTranscript("assistant", token);
  }

  private async waitForSpeech(): Promise<void> {
    const ms = this.speechEndsAt - Date.now();
    if (ms > 0) await this.speechWait(ms + 300);
  }

  private addTranscript(role: TranscriptEntry["role"], text: string): void {
    this.transcript.push({ role, text, at: this.deps.clock().toISOString() });
  }

  private persist(): void {
    this.deps.repo.updateCall(this.callId, { conversation: this.messages, transcript: this.transcript });
  }
}
