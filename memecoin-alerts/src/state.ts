import { readJsonFile, writeJsonAtomic } from "./jsonfile.js";

interface CoinRecord {
  firstSeen: number;
  /** "launch" or "x:<handle>". */
  sources: string[];
  name?: string;
  symbol?: string;
}

export interface CoinNames {
  name?: string;
  symbol?: string;
}

interface StateFile {
  sinceIds: Record<string, string>;
  coins: Record<string, CoinRecord>;
  /** Posts read by X keyword searches on one UTC day, for the daily cap. */
  keywordReads?: { date: string; count: number };
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
    const data: StateFile = { sinceIds: saved?.sinceIds ?? {}, coins: saved?.coins ?? {}, keywordReads: saved?.keywordReads };
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

  /** Posts keyword searches have read on `date` (YYYY-MM-DD, UTC). */
  keywordReads(date: string): number {
    return this.data.keywordReads?.date === date ? this.data.keywordReads.count : 0;
  }

  addKeywordReads(date: string, count: number): void {
    this.data.keywordReads = { date, count: this.keywordReads(date) + count };
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

  /** Name and ticker from the first alert that knew them. */
  names(mint: string): CoinNames {
    const record = this.data.coins[mint];
    return { name: record?.name, symbol: record?.symbol };
  }

  addSource(mint: string, source: string, now: number, names: CoinNames = {}): void {
    const record = (this.data.coins[mint] ??= { firstSeen: now, sources: [] });
    if (!record.sources.includes(source)) record.sources.push(source);
    record.name ??= names.name;
    record.symbol ??= names.symbol;
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
