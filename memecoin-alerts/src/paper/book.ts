import type { CoinAlert } from "../events.js";
import { readJsonFile, writeJsonAtomic } from "../jsonfile.js";

/** One open paper trade. */
export interface Position {
  mint: string;
  symbol?: string;
  name?: string;
  source: CoinAlert["source"];
  /** "curve": priced off the pump.fun bonding curve. "dex": priced off DexScreener (after graduation, or X coins). */
  pricing: "curve" | "dex";
  bondingCurve?: string;
  openedAt: number;
  boughtTokens: number;
  /** Tokens still held. */
  tokens: number;
  /** SOL put into the buy, fees included. */
  costSol: number;
  /** SOL received from sells so far. */
  proceedsSol: number;
  /** Network fees (priority fee, tip) paid so far. */
  txCostSol: number;
  entryMcapSol?: number;
  /** How far the price had already moved from creation when we got in. */
  entryVsCreationPct?: number;
  /** Highest value of the tokens still held, for the trailing stop. */
  peakValueSol: number;
  tookProfit: boolean;
}

export interface ClosedTrade {
  mint: string;
  symbol?: string;
  source: CoinAlert["source"];
  openedAt: number;
  closedAt: number;
  costSol: number;
  proceedsSol: number;
  txCostSol: number;
  pnlSol: number;
  pnlPct: number;
  reason: string;
}

export interface BookData {
  startSol: number;
  balanceSol: number;
  open: Position[];
  closed: ClosedTrade[];
  seen: string[];
  day: { date: string; realizedSol: number; stoppedReason?: string };
}

const MAX_CLOSED = 2000;
const MAX_SEEN = 5000;

/** The paper account: balance, open positions, trade history. Saved to a JSON file. */
export class PaperBook {
  private readonly seenSet: Set<string>;
  private saveTimer?: NodeJS.Timeout;
  private saving: Promise<void> = Promise.resolve();

  private constructor(
    readonly data: BookData,
    private readonly path: string | undefined,
    private readonly onSaveError: (err: unknown) => void,
  ) {
    this.seenSet = new Set(data.seen);
  }

  static async open(path: string, startSol: number, onSaveError: (err: unknown) => void = () => {}): Promise<PaperBook> {
    const saved = await readJsonFile<BookData>(path);
    return new PaperBook(saved ?? PaperBook.fresh(startSol), path, onSaveError);
  }

  static memory(startSol: number): PaperBook {
    return new PaperBook(PaperBook.fresh(startSol), undefined, () => {});
  }

  private static fresh(startSol: number): BookData {
    return { startSol, balanceSol: startSol, open: [], closed: [], seen: [], day: { date: "", realizedSol: 0 } };
  }

  hasSeen(mint: string): boolean {
    return this.seenSet.has(mint);
  }

  markSeen(mint: string): void {
    this.seenSet.add(mint);
    this.data.seen.push(mint);
    if (this.data.seen.length > MAX_SEEN) this.seenSet.delete(this.data.seen.shift()!);
    this.changed();
  }

  /** Call after mutating `data`. */
  changed(): void {
    if (this.data.closed.length > MAX_CLOSED) this.data.closed.splice(0, this.data.closed.length - MAX_CLOSED);
    if (!this.path || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.save().catch(this.onSaveError);
    }, 1000);
    this.saveTimer.unref();
  }

  async flush(): Promise<void> {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    await this.save();
  }

  private save(): Promise<void> {
    const path = this.path;
    if (!path) return Promise.resolve();
    this.saving = this.saving.catch(() => {}).then(() => writeJsonAtomic(path, this.data));
    return this.saving;
  }
}
