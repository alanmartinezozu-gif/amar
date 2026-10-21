import { readJsonFile, writeJsonAtomic } from "./jsonfile.js";

interface CoinRecord {
  firstSeen: number;
  /** "launch" or "x:<handle>". */
  sources: string[];
}

interface StateFile {
  sinceIds: Record<string, string>;
  coins: Record<string, CoinRecord>;
}

/** What the bot has already alerted on, so restarts don't repeat alerts. Saved to a JSON file. */
export class StateStore {
  private saveTimer?: NodeJS.Timeout;
  private saving: Promise<void> = Promise.resolve();

  private constructor(
    private readonly path: string | undefined,
    private readonly data: StateFile,
    private readonly maxCoins: number,
    private readonly onSaveError: (err: unknown) => void = () => {},
  ) {}

  static async open(path: string, onSaveError?: (err: unknown) => void, maxCoins = 5000): Promise<StateStore> {
    const saved = await readJsonFile<Partial<StateFile>>(path);
    const data: StateFile = { sinceIds: saved?.sinceIds ?? {}, coins: saved?.coins ?? {} };
    return new StateStore(path, data, maxCoins, onSaveError);
  }

  /** Not saved anywhere. For tests. */
  static memory(maxCoins = 5000): StateStore {
    return new StateStore(undefined, { sinceIds: {}, coins: {} }, maxCoins);
  }

  sinceId(query: string): string | undefined {
    return this.data.sinceIds[query];
  }

  setSinceId(query: string, id: string): void {
    this.data.sinceIds[query] = id;
    this.scheduleSave();
  }

  isAlerted(mint: string): boolean {
    return mint in this.data.coins;
  }

  sources(mint: string): string[] {
    return this.data.coins[mint]?.sources ?? [];
  }

  hasSource(mint: string, source: string): boolean {
    return this.sources(mint).includes(source);
  }

  addSource(mint: string, source: string, now: number): void {
    const record = (this.data.coins[mint] ??= { firstSeen: now, sources: [] });
    if (!record.sources.includes(source)) record.sources.push(source);
    this.prune();
    this.scheduleSave();
  }

  async flush(): Promise<void> {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    await this.save();
  }

  private prune(): void {
    const mints = Object.keys(this.data.coins);
    if (mints.length <= this.maxCoins) return;
    mints.sort((a, b) => this.data.coins[a].firstSeen - this.data.coins[b].firstSeen);
    for (const mint of mints.slice(0, mints.length - this.maxCoins)) delete this.data.coins[mint];
  }

  private scheduleSave(): void {
    if (!this.path || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.save().catch(this.onSaveError);
    }, 1000);
    this.saveTimer.unref();
  }

  private save(): Promise<void> {
    const path = this.path;
    if (!path) return Promise.resolve();
    this.saving = this.saving.catch(() => {}).then(() => writeJsonAtomic(path, this.data));
    return this.saving;
  }
}
