import { SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "./solana.js";

export interface RpcClient {
  call<T>(method: string, params: unknown[]): Promise<T>;
}

/** Bare-bones Solana JSON-RPC client. Read-only: this bot never signs or sends anything. */
export class HttpRpcClient implements RpcClient {
  private nextId = 1;

  constructor(
    private readonly url: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async call<T>(method: string, params: unknown[]): Promise<T> {
    const res = await this.fetchImpl(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`RPC ${method} failed: HTTP ${res.status}`);
    const body = (await res.json()) as { result?: T; error?: { message?: string } };
    if (body.error) throw new Error(`RPC ${method} failed: ${body.error.message ?? "unknown error"}`);
    return body.result as T;
  }
}

export interface SafetyReport {
  isToken: boolean;
  tokenProgram?: "spl-token" | "token-2022";
  mintAuthorityRevoked?: boolean;
  freezeAuthorityRevoked?: boolean;
  /** Share of total supply held by the 10 largest wallets, not counting pools and bonding curves. */
  top10HolderPct?: number;
  /** Machine-readable red flags, for your trading bot. */
  flags: string[];
  /** The same red flags in plain English. */
  warnings: string[];
  /** Set when a check couldn't finish (RPC down, rate limited). */
  error?: string;
}

/** Above this, the top 10 wallets can crash the price by selling. */
export const TOP10_WARN_PCT = 30;

type Account = { owner: string; data: unknown } | null;

interface MintInfo {
  mintAuthority: string | null;
  freezeAuthority: string | null;
  supply: string;
  extensions?: Array<{ extension: string; state?: Record<string, unknown> }>;
}

const RISKY_EXTENSIONS: Record<string, { flag: string; warning: string }> = {
  permanentDelegate: { flag: "permanent_delegate", warning: "Has a permanent delegate: someone can move or burn tokens in any wallet" },
  transferHook: { flag: "transfer_hook", warning: "Runs custom code on every transfer (can be used to block selling)" },
  nonTransferable: { flag: "non_transferable", warning: "Tokens can't be transferred or sold" },
  pausableConfig: { flag: "pausable", warning: "The creator can pause all transfers" },
};

function parsedOf(data: unknown): { type?: string; info?: unknown } | undefined {
  if (data && typeof data === "object" && "parsed" in data) {
    return (data as { parsed: { type?: string; info?: unknown } }).parsed;
  }
  return undefined;
}

function transferFeeBps(state: Record<string, unknown> | undefined): number {
  const bps = (key: string) => {
    const fee = state?.[key] as { transferFeeBasisPoints?: unknown } | undefined;
    return typeof fee?.transferFeeBasisPoints === "number" ? fee.transferFeeBasisPoints : 0;
  };
  return Math.max(bps("olderTransferFee"), bps("newerTransferFee"));
}

/**
 * Read-only red-flag check for a coin. Never throws: RPC trouble comes back in `error`.
 * `isToken: false` without `error` means the address definitely isn't a coin.
 */
export async function checkSafety(rpc: RpcClient, mint: string): Promise<SafetyReport> {
  const report: SafetyReport = { isToken: false, flags: [], warnings: [] };
  const flag = (f: string, warning: string) => {
    report.flags.push(f);
    report.warnings.push(warning);
  };

  let info: MintInfo;
  try {
    const account = await rpc.call<{ value: Account }>("getAccountInfo", [mint, { encoding: "jsonParsed", commitment: "confirmed" }]);
    const parsed = parsedOf(account.value?.data);
    if (!account.value || ![TOKEN_PROGRAM, TOKEN_2022_PROGRAM].includes(account.value.owner) || parsed?.type !== "mint") {
      return report;
    }
    report.isToken = true;
    report.tokenProgram = account.value.owner === TOKEN_PROGRAM ? "spl-token" : "token-2022";
    info = parsed.info as MintInfo;
  } catch (err) {
    report.error = err instanceof Error ? err.message : String(err);
    return report;
  }

  report.mintAuthorityRevoked = info.mintAuthority === null;
  report.freezeAuthorityRevoked = info.freezeAuthority === null;
  if (!report.mintAuthorityRevoked) flag("mint_authority", "The creator can still mint more tokens");
  if (!report.freezeAuthorityRevoked) flag("freeze_authority", "The creator can freeze wallets (you might not be able to sell)");

  for (const ext of info.extensions ?? []) {
    const risky = RISKY_EXTENSIONS[ext.extension];
    if (risky) flag(risky.flag, risky.warning);
    if (ext.extension === "transferFeeConfig") {
      const bps = transferFeeBps(ext.state);
      if (bps > 0) flag("transfer_fee", `Charges a ${bps / 100}% fee on every transfer`);
    }
    if (ext.extension === "defaultAccountState" && ext.state?.accountState === "frozen") {
      flag("default_frozen", "New holders start out frozen");
    }
  }

  try {
    report.top10HolderPct = await top10WalletPct(rpc, mint, BigInt(info.supply));
    if (report.top10HolderPct > TOP10_WARN_PCT) {
      flag("concentrated", `The top 10 wallets hold ${report.top10HolderPct.toFixed(1)}% of supply`);
    }
  } catch (err) {
    report.error = `couldn't load holders: ${err instanceof Error ? err.message : String(err)}`;
  }
  return report;
}

/**
 * Pools and bonding curves hold most of a new coin's supply, so counting them would flag every
 * coin. Real wallets are plain accounts owned by the System Program; pools are program accounts.
 */
async function top10WalletPct(rpc: RpcClient, mint: string, supply: bigint): Promise<number> {
  if (supply === 0n) return 0;
  const largest = await rpc.call<{ value: Array<{ address: string; amount: string }> }>("getTokenLargestAccounts", [
    mint,
    { commitment: "confirmed" },
  ]);
  if (largest.value.length === 0) return 0;

  const tokenAccounts = await rpc.call<{ value: Account[] }>("getMultipleAccounts", [
    largest.value.map((a) => a.address),
    { encoding: "jsonParsed", commitment: "confirmed" },
  ]);
  const holderOf = tokenAccounts.value.map((acc) => (parsedOf(acc?.data)?.info as { owner?: string } | undefined)?.owner);
  const holders = [...new Set(holderOf.filter((o): o is string => Boolean(o)))];

  const holderAccounts = await rpc.call<{ value: Account[] }>("getMultipleAccounts", [
    holders,
    { encoding: "base64", dataSlice: { offset: 0, length: 0 }, commitment: "confirmed" },
  ]);
  const isWallet = new Map(holders.map((h, i) => [h, holderAccounts.value[i]?.owner === SYSTEM_PROGRAM]));

  let top10 = 0n;
  let counted = 0;
  for (let i = 0; i < largest.value.length && counted < 10; i++) {
    const holder = holderOf[i];
    if (!holder || !isWallet.get(holder)) continue;
    top10 += BigInt(largest.value[i].amount);
    counted++;
  }
  return Number((top10 * 10_000n) / supply) / 100;
}
