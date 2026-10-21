import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { addr } from "./helpers.js";

describe("loadConfig", () => {
  it("runs on defaults with just the launch feed", () => {
    const c = loadConfig({});
    expect(c.LAUNCH_ALERTS).toBe(true);
    expect(c.FOLLOWUP_MINUTES).toEqual([5, 15, 60]);
    expect(c.X_POLL_SECONDS).toBe(60);
    expect(c.DEXSCREENER_API_URL).toBe("https://api.dexscreener.com");
  });

  it("normalizes X handles and keeps spaces inside keywords", () => {
    const c = loadConfig({ X_BEARER_TOKEN: "t", X_ACCOUNTS: "@KimChi1x, someone_else,kimchi1x", X_KEYWORDS: "pump fun, CA:" });
    expect(c.X_ACCOUNTS).toEqual(["kimchi1x", "someone_else"]);
    expect(c.X_KEYWORDS).toEqual(["pump fun", "CA:"]);
  });

  it("turns follow-ups off with an empty list and sorts them otherwise", () => {
    expect(loadConfig({ FOLLOWUP_MINUTES: "" }).FOLLOWUP_MINUTES).toEqual([]);
    expect(loadConfig({ FOLLOWUP_MINUTES: "60, 5,5" }).FOLLOWUP_MINUTES).toEqual([5, 60]);
    expect(() => loadConfig({ FOLLOWUP_MINUTES: "soon" })).toThrow(/FOLLOWUP_MINUTES/);
  });

  it("explains every problem at once", () => {
    let message = "";
    try {
      loadConfig({
        TELEGRAM_BOT_TOKEN: "123:abc",
        ALERT_WEBHOOK_URL: "http://localhost:9000/alerts",
        ALERT_WEBHOOK_SECRET: "short",
        LAUNCH_CREATORS: `${addr(1)},not-a-wallet`,
        X_BEARER_TOKEN: "t",
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/TELEGRAM_CHAT_ID: required/);
    expect(message).toMatch(/ALERT_WEBHOOK_SECRET: must be at least 16/);
    expect(message).toMatch(/"not-a-wallet" isn't a Solana wallet/);
    expect(message).toMatch(/X_ACCOUNTS: list at least one account/);
  });

  it("keeps the X keyword cap on unless it's set to 0", () => {
    expect(loadConfig({}).X_KEYWORD_POSTS_PER_DAY).toBe(1000);
    expect(loadConfig({ X_KEYWORD_POSTS_PER_DAY: "" }).X_KEYWORD_POSTS_PER_DAY).toBe(1000);
    expect(loadConfig({ X_KEYWORD_POSTS_PER_DAY: "0" }).X_KEYWORD_POSTS_PER_DAY).toBe(0);
    expect(loadConfig({ X_KEYWORD_POSTS_PER_DAY: "250" }).X_KEYWORD_POSTS_PER_DAY).toBe(250);
    expect(() => loadConfig({ X_KEYWORD_POSTS_PER_DAY: "5" })).toThrow(/X_KEYWORD_POSTS_PER_DAY: use 0 for no cap, or at least 10/);
  });

  it("refuses to start with nothing to watch", () => {
    expect(() => loadConfig({ LAUNCH_ALERTS: "false" })).toThrow(/nothing to watch/);
  });
});
