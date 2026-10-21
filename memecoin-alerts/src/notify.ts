import type { Logger } from "./logger.js";

export interface Notifier {
  send(text: string): Promise<void>;
}

type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
}

/** Sends to one Telegram chat, one message at a time, staying under Telegram's per-chat rate limit. */
export class TelegramNotifier implements Notifier {
  private queue: Promise<void> = Promise.resolve();
  private lastSentAt = 0;

  constructor(
    private readonly token: string,
    private readonly chatId: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly sleep: Sleep = realSleep,
    private readonly minIntervalMs = 1100,
  ) {}

  send(text: string): Promise<void> {
    const job = this.queue.then(() => this.deliver(text));
    this.queue = job.catch(() => {});
    return job;
  }

  private async deliver(text: string, attempt = 0): Promise<void> {
    const wait = this.lastSentAt + this.minIntervalMs - Date.now();
    if (wait > 0) await this.sleep(wait);
    // The URL contains the bot token, so it never goes into an error message.
    const res = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: this.chatId, text: truncate(text, 4000), link_preview_options: { is_disabled: true } }),
      signal: AbortSignal.timeout(10_000),
    });
    this.lastSentAt = Date.now();
    if (res.status === 429 && attempt < 3) {
      const body = (await res.json().catch(() => ({}))) as { parameters?: { retry_after?: number } };
      await this.sleep((body.parameters?.retry_after ?? 5) * 1000);
      return this.deliver(text, attempt + 1);
    }
    if (!res.ok) throw new Error(`Telegram sendMessage failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
}

export class DiscordNotifier implements Notifier {
  constructor(
    private readonly webhookUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly sleep: Sleep = realSleep,
  ) {}

  async send(text: string, attempt = 0): Promise<void> {
    const res = await this.fetchImpl(this.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: truncate(text, 1900) }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 429 && attempt < 3) {
      const body = (await res.json().catch(() => ({}))) as { retry_after?: number };
      await this.sleep((body.retry_after ?? 2) * 1000);
      return this.send(text, attempt + 1);
    }
    if (!res.ok) throw new Error(`Discord webhook failed: HTTP ${res.status}`);
  }
}

export class ConsoleNotifier implements Notifier {
  constructor(private readonly log: Logger) {}

  async send(text: string): Promise<void> {
    this.log.info("alert", { text });
  }
}

/** Fans out to every channel. One channel failing never blocks the others. */
export class MultiNotifier implements Notifier {
  constructor(
    private readonly notifiers: Notifier[],
    private readonly log: Logger,
  ) {}

  async send(text: string): Promise<void> {
    const results = await Promise.allSettled(this.notifiers.map((n) => n.send(text)));
    for (const r of results) {
      if (r.status === "rejected") this.log.warn("Notification failed", { err: r.reason });
    }
  }
}
