import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import { SOL_MINT, USDC_MINT, extractMints, isSolanaAddress } from "../src/solana.js";
import { addr } from "./helpers.js";

describe("extractMints", () => {
  const a = addr(1);
  const b = addr(2);

  it("finds a contract address in post text", () => {
    expect(extractMints([`New one 🚀 CA: ${a} send it`])).toEqual([a]);
  });

  it("finds addresses inside pump.fun and DexScreener links", () => {
    expect(extractMints([`https://pump.fun/coin/${a}`, `https://dexscreener.com/solana/${b}?ref=x`])).toEqual([a, b]);
  });

  it("dedupes across the text and its links", () => {
    expect(extractMints([`CA ${a}`, `https://pump.fun/coin/${a}`])).toEqual([a]);
  });

  it("ignores transaction signatures, which are longer base58 runs", () => {
    const signature = bs58.encode(Uint8Array.from({ length: 64 }, (_, i) => (i * 13 + 5) & 255));
    expect(signature.length).toBeGreaterThan(80);
    expect(extractMints([`tx: ${signature}`])).toEqual([]);
  });

  it("ignores SOL, USDC and long words", () => {
    expect(extractMints([`${SOL_MINT} ${USDC_MINT} supercalifragilisticexpialidociousness`])).toEqual([]);
  });

  it("ignores Ethereum addresses", () => {
    expect(extractMints(["0x1f9840a85d5af5bf1d1762f925bdaddc4201f984"])).toEqual([]);
  });
});

describe("isSolanaAddress", () => {
  it("accepts 32-byte base58 strings only", () => {
    expect(isSolanaAddress(addr(3))).toBe(true);
    expect(isSolanaAddress(bs58.encode(new Uint8Array(31).fill(9)))).toBe(false);
    expect(isSolanaAddress("not an address")).toBe(false);
    expect(isSolanaAddress(addr(3).replace(/.$/, "0"))).toBe(false);
  });
});
