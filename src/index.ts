import "dotenv/config";
import { createApp, registerJobs } from "./app.js";
import { GoogleCalendarClient } from "./calendar/google.js";
import { CalendarService } from "./calendar/service.js";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db/database.js";
import { Repo } from "./db/repo.js";
import type { Deps } from "./deps.js";
import { JobQueue } from "./jobs/queue.js";
import { createLogger } from "./lib/logger.js";
import { createGraphFetch } from "./sources/facebook.js";
import { AnthropicLlm } from "./voice/llm.js";
import { TwilioTelephony } from "./voice/telephony.js";

const config = loadConfig();
const log = createLogger(config.LOG_LEVEL);
const clock = () => new Date();
const db = openDatabase(config.DATABASE_PATH);
const repo = new Repo(db, clock);
const jobs = new JobQueue(repo, log.child({ component: "jobs" }), clock);

const deps: Deps = {
  config,
  repo,
  telephony: new TwilioTelephony(config),
  llm: new AnthropicLlm(config),
  calendar: new CalendarService(repo, new GoogleCalendarClient(config, repo), clock),
  jobs,
  log,
  clock,
  graphFetch: createGraphFetch(config),
};

registerJobs(deps);
const { server } = createApp(deps);
server.listen(config.PORT, () => {
  log.info("Speed-to-lead server listening", { port: config.PORT, publicUrl: config.PUBLIC_BASE_URL, model: config.ANTHROPIC_MODEL });
  if (!config.TWILIO_ACCOUNT_SID) log.warn("Twilio is not configured - calls and texts will fail until TWILIO_* is set");
  if (!config.TWILIO_VALIDATE_SIGNATURES) log.warn("Twilio signature validation is OFF - only do this for local testing");
});
jobs.start(config.WORKER_POLL_MS);

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info("Shutting down", { signal });
  server.close();
  await jobs.stop();
  db.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
