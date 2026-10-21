import { describe, expect, it } from "vitest";
import { silentLogger } from "../src/logger.js";
import { StateStore } from "../src/state.js";
import { HttpXApi, XRateLimitError, XWatcher, buildQueries, type PostMention, type XApi, type XSearchResult } from "../src/x.js";
import { addr, fakeFetch, json } from "./helpers.js";

describe("buildQueries", () => {
  it("packs accounts into OR-queries under the length limit and skips retweets", () => {
    const queries = buildQueries(["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc"], [], 60);
    expect(queries).toEqual([
      { query: "(from:aaaaaaaaaa OR from:bbbbbbbbbb) -is:retweet", kind: "accounts" },
      { query: "from:cccccccccc -is:retweet", kind: "accounts" },
    ]);
    for (const q of queries) expect(q.query.length).toBeLessThanOrEqual(60);
  });

  it("quotes multi-word keywords", () => {
    expect(buildQueries([], ["pump fun", "CA"], 512)).toEqual([{ query: '("pump fun" OR CA) -is:retweet', kind: "keywords" }]);
  });
});

describe("HttpXApi", () => {
  it("searches with since_id, follows pages and maps authors, long posts and links", async () => {
    const mint = addr(1);
    const { fetch, requests } = fakeFetch((url) => {
      if (!url.includes("next_token")) {
        return json({
          data: [
            {
              id: "3",
              text: "short…",
              author_id: "u1",
              created_at: "2026-10-21T00:00:00.000Z",
              note_tweet: { text: "long post with the full text", entities: { urls: [{ expanded_url: `https://pump.fun/coin/${mint}` }] } },
            },
          ],
          includes: { users: [{ id: "u1", username: "Kimchi1x" }] },
          meta: { newest_id: "3", next_token: "page2" },
        });
      }
      return json({ data: [{ id: "2", text: "older", author_id: "u2", entities: { urls: [{ url: "https://t.co/x" }] } }], meta: {} });
    });

    const api = new HttpXApi("bearer-token", "https://api.x.test/2", fetch);
    const result = await api.searchRecent("from:kimchi1x", { sinceId: "1", startTime: "ignored" });

    expect(requests).toHaveLength(2);
    const first = new URL(requests[0].url);
    expect(first.pathname).toBe("/2/tweets/search/recent");
    expect(first.searchParams.get("since_id")).toBe("1");
    expect(first.searchParams.get("start_time")).toBeNull();
    expect(new URL(requests[1].url).searchParams.get("next_token")).toBe("page2");
    expect((requests[0].init?.headers as Record<string, string>).authorization).toBe("Bearer bearer-token");

    expect(result.newestId).toBe("3");
    expect(result.posts).toEqual([
      {
        id: "3",
        text: "long post with the full text",
        authorId: "u1",
        authorUsername: "Kimchi1x",
        createdAt: "2026-10-21T00:00:00.000Z",
        urls: [`https://pump.fun/coin/${mint}`],
      },
      { id: "2", text: "older", authorId: "u2", authorUsername: undefined, createdAt: undefined, urls: ["https://t.co/x"] },
    ]);
  });

  it("turns a 429 into a rate-limit error with X's reset time", async () => {
    const { fetch } = fakeFetch(() => json({ title: "Too Many Requests" }, 429, { "x-rate-limit-reset": "1800000000" }));
    const api = new HttpXApi("t", "https://api.x.test/2", fetch);
    const err = await api.searchRecent("q", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(XRateLimitError);
    expect((err as XRateLimitError).resetAt).toBe(1_800_000_000_000);
  });
});

class FakeXApi implements XApi {
  calls: Array<{ query: string; opts: { sinceId?: string; startTime?: string } }> = [];
  responses: Array<XSearchResult | Error> = [];

  async searchRecent(query: string, opts: { sinceId?: string; startTime?: string }): Promise<XSearchResult> {
    this.calls.push({ query, opts });
    const next = this.responses.shift() ?? { posts: [] };
    if (next instanceof Error) throw next;
    return next;
  }
}

describe("XWatcher", () => {
  const NOW = Date.parse("2026-10-21T12:00:00.000Z");
  const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

  function setup() {
    const api = new FakeXApi();
    const seen: PostMention[] = [];
    const state = StateStore.memory();
    const watcher = new XWatcher(
      api,
      { handlePost: async (m) => void seen.push(m) },
      state,
      { accounts: ["kimchi1x"], keywords: [], maxQueryLength: 512, maxPostAgeMs: 30 * 60_000 },
      silentLogger,
      () => NOW,
    );
    return { api, seen, state, watcher };
  }

  it("only looks back as far as it would alert on, then continues from the newest post", async () => {
    const { api, state, watcher } = setup();
    api.responses.push({ posts: [], newestId: "100" });
    await watcher.pollOnce();
    expect(api.calls[0].opts).toEqual({ startTime: minutesAgo(30) });
    expect(state.sinceId("from:kimchi1x -is:retweet")).toBe("100");

    await watcher.pollOnce();
    expect(api.calls[1].opts).toEqual({ sinceId: "100" });
  });

  it("hands over each address oldest post first, skipping stale posts", async () => {
    const { api, seen, watcher } = setup();
    const [m1, m2, m3] = [addr(1), addr(2), addr(3)];
    api.responses.push({
      newestId: "3",
      posts: [
        { id: "3", text: `CA ${m3}`, authorId: "u2", authorUsername: "rando", createdAt: minutesAgo(1), urls: [] },
        { id: "2", text: "new coin", authorId: "u1", authorUsername: "Kimchi1x", createdAt: minutesAgo(5), urls: [`https://pump.fun/coin/${m2}`] },
        { id: "1", text: `old ${m1}`, authorId: "u1", authorUsername: "kimchi1x", createdAt: minutesAgo(45), urls: [] },
      ],
    });
    await watcher.pollOnce();
    expect(seen.map((s) => [s.mint, s.tracked])).toEqual([
      [m2, true],
      [m3, false],
    ]);
  });

  it("pauses until X's reset time after a rate limit", async () => {
    const { api, watcher } = setup();
    api.responses.push(new XRateLimitError(NOW + 60_000));
    await watcher.pollOnce();
    await watcher.pollOnce();
    expect(api.calls).toHaveLength(1);
  });

  it("keeps going after a failed search", async () => {
    const { api, watcher } = setup();
    api.responses.push(new Error("HTTP 503"));
    await watcher.pollOnce();
    await watcher.pollOnce();
    expect(api.calls).toHaveLength(2);
  });
});
