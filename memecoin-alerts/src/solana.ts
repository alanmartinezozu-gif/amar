import bs58 from "bs58";

export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

/** Coins every pair trades against: never a "new coin". */
export const QUOTE_MINTS = new Set([SOL_MINT, USDC_MINT, USDT_MINT]);

/** Well-known addresses that show up in posts but are never a new coin. */
const NOT_NEW_COINS = new Set([
  ...QUOTE_MINTS,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", // pump.fun program
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", // Jupiter aggregator
]);

const BASE58 = "1-9A-HJ-NP-Za-km-z";
// 32-44 base58 characters that aren't part of a longer run (transaction signatures are ~88).
const ADDRESS_RUN = new RegExp(`(?<![${BASE58}])[${BASE58}]{32,44}(?![${BASE58}])`, "g");
const ADDRESS_EXACT = new RegExp(`^[${BASE58}]{32,44}$`);

export function isSolanaAddress(value: string): boolean {
  if (!ADDRESS_EXACT.test(value)) return false;
  try {
    return bs58.decode(value).length === 32;
  } catch {
    return false;
  }
}

/** Long single-case runs with no digits are words or hashtags, not addresses. */
function looksLikeWord(value: string): boolean {
  return !/\d/.test(value) && (value === value.toLowerCase() || value === value.toUpperCase());
}

/** Every Solana address in the given text (post body, expanded links), deduped, in order of appearance. */
export function extractMints(texts: Iterable<string>): string[] {
  const found = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(ADDRESS_RUN)) {
      const candidate = match[0];
      if (NOT_NEW_COINS.has(candidate) || looksLikeWord(candidate) || !isSolanaAddress(candidate)) continue;
      found.add(candidate);
    }
  }
  return [...found];
}

export function coinLinks(mint: string) {
  return {
    pumpfun: `https://pump.fun/coin/${mint}`,
    dexscreener: `https://dexscreener.com/solana/${mint}`,
    solscan: `https://solscan.io/token/${mint}`,
  };
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}
