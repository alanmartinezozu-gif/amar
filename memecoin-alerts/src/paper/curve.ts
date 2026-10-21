import type { RpcClient } from "../rpc.js";
import { PUMP_PROGRAM } from "../solana.js";

/** A pump.fun bonding curve, in whole tokens and SOL. Read-only: we only ever look at it. */
export interface CurveState {
  vTokens: number;
  vSol: number;
  realTokens: number;
  realSol: number;
  totalSupply: number;
  /** True once the coin has graduated to a regular pool and the curve stops trading. */
  complete: boolean;
}

const TOKEN_UNITS = 1e6; // pump.fun coins have 6 decimals
const LAMPORTS_PER_SOL = 1e9;

/** Anchor account layout: 8-byte discriminator, five u64s, then the `complete` flag. Newer fields follow. */
export function decodeBondingCurve(data: Buffer): CurveState | null {
  if (data.length < 49) return null;
  const u64 = (offset: number) => Number(data.readBigUInt64LE(offset));
  return {
    vTokens: u64(8) / TOKEN_UNITS,
    vSol: u64(16) / LAMPORTS_PER_SOL,
    realTokens: u64(24) / TOKEN_UNITS,
    realSol: u64(32) / LAMPORTS_PER_SOL,
    totalSupply: u64(40) / TOKEN_UNITS,
    complete: data[48] === 1,
  };
}

export function priceSol(c: Pick<CurveState, "vSol" | "vTokens">): number {
  return c.vTokens > 0 ? c.vSol / c.vTokens : 0;
}

export function mcapSol(c: CurveState): number {
  return priceSol(c) * c.totalSupply;
}

/** Tokens a buy of `sol` (fee included) gets right now. The curve is constant-product: vSol × vTokens = k. */
export function tokensForSol(c: CurveState, sol: number, feePct: number): number {
  const solIn = sol * (1 - feePct / 100);
  const out = c.vTokens - (c.vSol * c.vTokens) / (c.vSol + solIn);
  return Math.max(0, Math.min(out, c.realTokens));
}

/** SOL a sale of `tokens` gets right now, after the fee. */
export function solForTokens(c: CurveState, tokens: number, feePct: number): number {
  const out = c.vSol - (c.vSol * c.vTokens) / (c.vTokens + tokens);
  return Math.max(0, Math.min(out, c.realSol)) * (1 - feePct / 100);
}

export interface CurveSource {
  /** Current state of each curve that could be read. Missing keys mean "unknown right now". */
  read(keys: string[]): Promise<Map<string, CurveState>>;
}

export class RpcCurveSource implements CurveSource {
  constructor(private readonly rpc: RpcClient) {}

  async read(keys: string[]): Promise<Map<string, CurveState>> {
    const states = new Map<string, CurveState>();
    for (let i = 0; i < keys.length; i += 100) {
      const chunk = keys.slice(i, i + 100);
      const res = await this.rpc.call<{ value: Array<{ owner: string; data: [string, string] } | null> }>("getMultipleAccounts", [
        chunk,
        { encoding: "base64", commitment: "confirmed" },
      ]);
      res.value.forEach((account, j) => {
        if (account?.owner !== PUMP_PROGRAM) return;
        const state = decodeBondingCurve(Buffer.from(account.data[0], "base64"));
        if (state) states.set(chunk[j], state);
      });
    }
    return states;
  }
}
