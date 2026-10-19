import Anthropic from "@anthropic-ai/sdk";
import type { Config } from "../config.js";

export type BetaMessage = Anthropic.Beta.BetaMessage;
export type BetaMessageParam = Anthropic.Beta.BetaMessageParam;
export type BetaTool = Anthropic.Beta.BetaTool;
export type BetaTextBlockParam = Anthropic.Beta.BetaTextBlockParam;

export interface TurnRequest {
  system: BetaTextBlockParam[];
  tools: BetaTool[];
  messages: BetaMessageParam[];
  signal: AbortSignal;
  /** Called with each text delta as it streams, so speech can start before the reply is finished. */
  onText: (delta: string) => void;
}

export interface LlmClient {
  /** Stream one assistant turn. Rejects with an abort error if `signal` fires. */
  streamTurn(req: TurnRequest): Promise<BetaMessage>;
  /** One-shot text completion (post-call summaries). */
  complete(system: string, prompt: string): Promise<string>;
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Anthropic.APIUserAbortError || (err instanceof Error && err.name === "AbortError");
}

export class AnthropicLlm implements LlmClient {
  private readonly client: Anthropic;

  constructor(private readonly config: Config) {
    // Credentials resolve from ANTHROPIC_API_KEY (or an `ant auth login` profile).
    // Voice turns are latency sensitive: fail fast instead of waiting minutes on a stuck request.
    this.client = new Anthropic({ maxRetries: 2, timeout: 30_000 });
  }

  /** Server-side refusal fallback (Claude API only; Haiku has none). */
  private fallbackParams(): { betas?: Anthropic.Beta.AnthropicBeta[]; fallbacks?: "default" } {
    if (this.config.ANTHROPIC_FALLBACKS === "off" || this.config.ANTHROPIC_MODEL.includes("haiku")) return {};
    return { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" };
  }

  async streamTurn(req: TurnRequest): Promise<BetaMessage> {
    const stream = this.client.beta.messages.stream(
      {
        model: this.config.ANTHROPIC_MODEL,
        // Thinking counts toward max_tokens; spoken replies themselves are short.
        max_tokens: 8000,
        output_config: { effort: this.config.ANTHROPIC_EFFORT },
        // Caches the growing conversation prefix so each turn only pays for what's new.
        cache_control: { type: "ephemeral" },
        system: req.system,
        tools: req.tools,
        messages: req.messages,
        ...this.fallbackParams(),
      },
      { signal: req.signal },
    );
    stream.on("text", (delta) => req.onText(delta));
    return stream.finalMessage();
  }

  async complete(system: string, prompt: string): Promise<string> {
    const message = await this.client.beta.messages.create(
      {
        model: this.config.ANTHROPIC_MODEL,
        max_tokens: 4000,
        output_config: { effort: "low" },
        system,
        messages: [{ role: "user", content: prompt }],
        ...this.fallbackParams(),
      },
      { timeout: 60_000 },
    );
    if (message.stop_reason === "refusal") return "";
    return message.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
  }
}
