import type { Config } from "./config.js";
import type { Repo } from "./db/repo.js";
import type { CalendarService } from "./calendar/service.js";
import type { Logger } from "./lib/logger.js";
import type { Telephony } from "./voice/telephony.js";
import type { LlmClient } from "./voice/llm.js";
import type { JobQueue } from "./jobs/queue.js";
import type { GraphFetch } from "./sources/facebook.js";

/** Everything a request handler or job needs. Built once in index.ts; tests build it with fakes. */
export interface Deps {
  config: Config;
  repo: Repo;
  telephony: Telephony;
  llm: LlmClient;
  calendar: CalendarService;
  jobs: JobQueue;
  log: Logger;
  clock: () => Date;
  /** Facebook Graph API fetch (swappable in tests). */
  graphFetch: GraphFetch;
}
