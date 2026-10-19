import type { Repo } from "../db/repo.js";
import type { Job } from "../domain/types.js";
import type { Logger } from "../lib/logger.js";

export type JobHandler = (payload: Record<string, unknown>, job: Job) => Promise<void>;

/** Raise from a handler to stop retrying (bad input, missing records). */
export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentJobError";
  }
}

const MAX_ATTEMPTS = 5;

/**
 * Durable job queue stored in SQLite. Survives restarts, retries with backoff.
 * This is what fires the AI call 10 seconds after a form submit, and every re-dial after that.
 */
export class JobQueue {
  private handlers = new Map<string, JobHandler>();
  private timer: NodeJS.Timeout | null = null;
  private running = new Set<Promise<void>>();

  constructor(
    private readonly repo: Repo,
    private readonly log: Logger,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  register(type: string, handler: JobHandler): void {
    this.handlers.set(type, handler);
  }

  enqueue(type: string, payload: Record<string, unknown>, runAt: Date = this.clock(), dedupeKey?: string): number | null {
    return this.repo.enqueueJob(type, payload, runAt, dedupeKey);
  }

  start(pollMs: number): void {
    const reset = this.repo.resetRunningJobs();
    if (reset) this.log.warn("Re-queued jobs interrupted by a restart", { count: reset });
    this.timer = setInterval(() => void this.tick(), pollMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.allSettled([...this.running]);
  }

  /**
   * Claim and start every job that is due now; resolves when those jobs finish.
   * The poller doesn't await it, so a slow job never delays the next lead's call.
   */
  async tick(): Promise<number> {
    const jobs = this.repo.claimDueJobs(20);
    await Promise.all(jobs.map((job) => this.track(this.run(job))));
    return jobs.length;
  }

  /** Run due jobs repeatedly until none are left (jobs may enqueue immediate follow-ups). */
  async drain(maxRounds = 20): Promise<void> {
    for (let i = 0; i < maxRounds; i++) {
      if ((await this.tick()) === 0) return;
    }
  }

  private track(p: Promise<void>): Promise<void> {
    this.running.add(p);
    return p.finally(() => this.running.delete(p));
  }

  private async run(job: Job): Promise<void> {
    const handler = this.handlers.get(job.type);
    const log = this.log.child({ job: job.id, type: job.type });
    if (!handler) {
      log.error("No handler registered for job type");
      this.repo.failJob(job.id, "no handler", null);
      return;
    }
    try {
      await handler(job.payload, job);
      this.repo.completeJob(job.id);
    } catch (err) {
      const permanent = err instanceof PermanentJobError || job.attempts >= MAX_ATTEMPTS;
      const backoffMs = Math.min(15 * 60_000, 2 ** job.attempts * 5_000);
      log.error("Job failed", { err, attempt: job.attempts, willRetry: !permanent });
      this.repo.failJob(job.id, err instanceof Error ? err.message : String(err), permanent ? null : new Date(this.clock().getTime() + backoffMs));
    }
  }
}
