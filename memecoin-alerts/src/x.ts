import { z } from "zod";
import type { Logger } from "./logger.js";
import { extractMints } from "./solana.js";
import type { StateStore } from "./state.js";

export interface XPost {
  id: string;
  text: string;
  authorId: string;
  authorUsername?: string;
  createdAt?: string;
  /** Expanded links (X shortens everything to t.co in the text). */
  urls: string[];
}

export interface XSearchResult {
  /** Newest first, as X returns them. */
  posts: XPost[];
  newestId?: string;
}

export interface XApi {
  searchRecent(query: string, opts: { sinceId?: string; startTime?: string }): Promise<XSearchResult>;
}

export class XRateLimitError extends Error {
  constructor(readonly resetAt: number) {
    super("X rate limit reached");
  }
}

const UrlEntity = z.object({ url: z.string().optional(), expanded_url: z.string().optional() });
const Entities = z.object({ urls: z.array(UrlEntity).optional() }).optional();
const Tweet = z.object({
  id: z.string(),
  text: z.string(),
  author_id: z.string().optional(),
  created_at: z.string().optional(),
  entities: Entities,
  // Long posts: `text` is cut at 280 characters, the full text is here.
  note_tweet: z.object({ text: z.string(), entities: Entities }).optional(),
});
const SearchResponse = z.object({
  data: z.array(Tweet).optional(),
  includes: z.object({ users: z.array(z.object({ id: z.string(), username: z.string() })).optional() }).optional(),
  meta: z.object({ newest_id: z.string().optional(), next_token: z.string().optional() }).optional(),
});

const MAX_PAGES = 3;

/** X API v2 recent search with an app bearer token. */
export class HttpXApi implements XApi {
  constructor(
    private readonly bearerToken: string,
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async searchRecent(query: string, opts: { sinceId?: string; startTime?: string }): Promise<XSearchResult> {
    const posts: XPost[] = [];
    let newestId: string | undefined;
    let nextToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const params = new URLSearchParams({
        query,
        max_results: "100",
        "tweet.fields": "created_at,author_id,entities,note_tweet",
        expansions: "author_id",
        "user.fields": "username",
      });
      if (opts.sinceId) params.set("since_id", opts.sinceId);
      else if (opts.startTime) params.set("start_time", opts.startTime);
      if (nextToken) params.set("next_token", nextToken);

      const res = await this.fetchImpl(`${this.baseUrl}/tweets/search/recent?${params}`, {
        headers: { authorization: `Bearer ${this.bearerToken}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 429) {
        const reset = Number(res.headers.get("x-rate-limit-reset"));
        throw new XRateLimitError(Number.isFinite(reset) && reset > 0 ? reset * 1000 : Date.now() + 15 * 60_000);
      }
      if (!res.ok) throw new Error(`X search failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);

      const body = SearchResponse.parse(await res.json());
      const usernames = new Map((body.includes?.users ?? []).map((u) => [u.id, u.username]));
      for (const t of body.data ?? []) {
        const urls = [...(t.entities?.urls ?? []), ...(t.note_tweet?.entities?.urls ?? [])];
        posts.push({
          id: t.id,
          text: t.note_tweet?.text ?? t.text,
          authorId: t.author_id ?? "unknown",
          authorUsername: t.author_id ? usernames.get(t.author_id) : undefined,
          createdAt: t.created_at,
          urls: urls.map((u) => u.expanded_url ?? u.url ?? "").filter(Boolean),
        });
      }
      newestId ??= body.meta?.newest_id;
      nextToken = body.meta?.next_token;
      if (!nextToken) break;
    }
    return { posts, newestId };
  }
}

export interface XQuery {
  query: string;
  kind: "accounts" | "keywords";
}

const NO_RETWEETS = " -is:retweet";

/** Packs terms into as few OR-queries as fit under X's length limit. */
function packQueries(terms: string[], maxLength: number): string[] {
  const render = (group: string[]) => (group.length === 1 ? group[0] : `(${group.join(" OR ")})`) + NO_RETWEETS;
  const queries: string[] = [];
  let group: string[] = [];
  for (const term of terms) {
    if (group.length > 0 && render([...group, term]).length > maxLength) {
      queries.push(render(group));
      group = [];
    }
    group.push(term);
  }
  if (group.length > 0) queries.push(render(group));
  return queries;
}

export function buildQueries(accounts: string[], keywords: string[], maxLength: number): XQuery[] {
  const keywordTerms = keywords.map((k) => (/\s/.test(k) ? `"${k.replace(/"/g, "")}"` : k));
  return [
    ...packQueries(accounts.map((a) => `from:${a}`), maxLength).map((query) => ({ query, kind: "accounts" as const })),
    ...packQueries(keywordTerms, maxLength).map((query) => ({ query, kind: "keywords" as const })),
  ];
}

export interface PostMention {
  mint: string;
  post: XPost;
  /** Author is in X_ACCOUNTS. */
  tracked: boolean;
}

export interface PostHandler {
  handlePost(mention: PostMention): Promise<void>;
}

export interface XWatcherOptions {
  accounts: string[];
  keywords: string[];
  maxQueryLength: number;
  maxPostAgeMs: number;
}

/** Polls X for posts containing Solana contract addresses and hands each one to the alert hub. */
export class XWatcher {
  readonly queries: XQuery[];
  private readonly tracked: Set<string>;
  private readonly maxPostAgeMs: number;
  private pausedUntil = 0;
  private polling = false;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly api: XApi,
    private readonly handler: PostHandler,
    private readonly state: StateStore,
    opts: XWatcherOptions,
    private readonly log: Logger,
    private readonly clock: () => number = Date.now,
  ) {
    this.queries = buildQueries(opts.accounts, opts.keywords, opts.maxQueryLength);
    this.tracked = new Set(opts.accounts.map((a) => a.toLowerCase()));
    this.maxPostAgeMs = opts.maxPostAgeMs;
  }

  start(intervalMs: number): void {
    void this.pollOnce();
    this.timer = setInterval(() => void this.pollOnce(), intervalMs);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  async pollOnce(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const q of this.queries) {
        if (this.clock() < this.pausedUntil) return;
        await this.runQuery(q);
      }
    } finally {
      this.polling = false;
    }
  }

  private async runQuery(q: XQuery): Promise<void> {
    const now = this.clock();
    const sinceId = this.state.sinceId(q.query);
    let result: XSearchResult;
    try {
      // First run for a query: only look back as far as we'd alert on, so we don't pay to read a week of posts.
      result = await this.api.searchRecent(q.query, sinceId ? { sinceId } : { startTime: new Date(now - this.maxPostAgeMs).toISOString() });
    } catch (err) {
      if (err instanceof XRateLimitError) {
        this.pausedUntil = err.resetAt;
        this.log.warn("X rate limit reached, pausing", { until: new Date(err.resetAt).toISOString() });
      } else {
        this.log.error("X search failed", { err, query: q.query });
      }
      return;
    }
    if (result.newestId) this.state.setSinceId(q.query, result.newestId);

    for (const post of [...result.posts].reverse()) {
      if (post.createdAt && now - Date.parse(post.createdAt) > this.maxPostAgeMs) continue;
      const tracked = post.authorUsername !== undefined && this.tracked.has(post.authorUsername.toLowerCase());
      for (const mint of extractMints([post.text, ...post.urls])) {
        try {
          await this.handler.handlePost({ mint, post, tracked });
        } catch (err) {
          this.log.error("Failed to handle post", { err, postId: post.id, mint });
        }
      }
    }
  }
}
