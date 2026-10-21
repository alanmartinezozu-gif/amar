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

export interface SearchOptions {
  sinceId?: string;
  startTime?: string;
  /** Stop after about this many posts (X returns at least 10 per request). Each post read costs money. */
  maxPosts?: number;
}

export interface XApi {
  searchRecent(query: string, opts: SearchOptions): Promise<XSearchResult>;
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

  async searchRecent(query: string, opts: SearchOptions): Promise<XSearchResult> {
    const posts: XPost[] = [];
    const maxPosts = opts.maxPosts ?? Infinity;
    let newestId: string | undefined;
    let nextToken: string | undefined;
    for (let page = 0; page < MAX_PAGES && posts.length < maxPosts; page++) {
      const params = new URLSearchParams({
        query,
        // X accepts 10-100 per request.
        max_results: String(Math.min(100, Math.max(10, maxPosts - posts.length))),
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
  /**
   * Keyword searches can match thousands of posts a day, and X bills per post read. They read at
   * most one page (100 posts) per check, and at most this many per UTC day, spread evenly over the
   * day so a busy search keeps working around the clock. 0 = no daily cap.
   * Searches of your tracked accounts are never capped: they're low volume and the most valuable.
   */
  keywordPostsPerDay: number;
  /** Called once per UTC day when keyword searches use the whole day's allowance. */
  onKeywordLimit?: (limit: number) => void;
}

const KEYWORD_POSTS_PER_CHECK = 100;
/** X returns at least this many posts per request, so smaller allowances wait to build up. */
export const MIN_POSTS_PER_REQUEST = 10;
const DAY_MS = 86_400_000;
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Polls X for posts containing Solana contract addresses and hands each one to the alert hub. */
export class XWatcher {
  readonly queries: XQuery[];
  private readonly tracked: Set<string>;
  private pausedUntil = 0;
  private polling = false;
  private limitNotifiedOn = "";
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly api: XApi,
    private readonly handler: PostHandler,
    private readonly state: StateStore,
    private readonly opts: XWatcherOptions,
    private readonly log: Logger,
    private readonly clock: () => number = Date.now,
  ) {
    this.queries = buildQueries(opts.accounts, opts.keywords, opts.maxQueryLength);
    this.tracked = new Set(opts.accounts.map((a) => a.toLowerCase()));
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
    const today = utcDay(now);
    const { keywordPostsPerDay: cap, maxPostAgeMs } = this.opts;
    let maxPosts: number | undefined;
    if (q.kind === "keywords") {
      maxPosts = KEYWORD_POSTS_PER_CHECK;
      if (cap > 0) {
        const used = this.state.keywordReads(today);
        if (used >= cap) {
          if (this.limitNotifiedOn !== today) {
            this.limitNotifiedOn = today;
            this.log.warn("X keyword searches used today's whole allowance", { cap });
            this.opts.onKeywordLimit?.(cap);
          }
          return;
        }
        // Pace the allowance: by noon UTC, at most half the day's posts may have been read.
        const elapsed = (now - Date.parse(`${today}T00:00:00.000Z`)) / DAY_MS;
        const left = Math.min(cap, Math.ceil(cap * elapsed)) - used;
        if (left < MIN_POSTS_PER_REQUEST) return;
        maxPosts = Math.min(maxPosts, left);
      }
    }

    const sinceId = this.state.sinceId(q.query);
    let result: XSearchResult;
    try {
      // First run for a query: only look back as far as we'd alert on, so we don't pay to read a week of posts.
      const window = sinceId ? { sinceId } : { startTime: new Date(now - maxPostAgeMs).toISOString() };
      result = await this.api.searchRecent(q.query, { ...window, maxPosts });
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
    if (q.kind === "keywords") this.state.addKeywordReads(today, result.posts.length);

    for (const post of [...result.posts].reverse()) {
      if (post.createdAt && now - Date.parse(post.createdAt) > maxPostAgeMs) continue;
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
