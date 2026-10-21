import { describe, expect, it } from "vitest";
import { checkSafety } from "../src/rpc.js";
import { FakeRpc, addr } from "./helpers.js";

const SUPPLY = 1_000_000_000_000_000n;

describe("checkSafety", () => {
  it("passes a typical pump.fun coin and ignores the bonding curve's share", async () => {
    const rpc = new FakeRpc();
    const mint = addr(1);
    rpc.addMint(mint, { supply: SUPPLY.toString() });
    rpc.addHolder(mint, (SUPPLY * 80n) / 100n, "pool");
    for (let i = 0; i < 12; i++) rpc.addHolder(mint, SUPPLY / 100n);

    const report = await checkSafety(rpc, mint);
    expect(report).toMatchObject({
      isToken: true,
      tokenProgram: "spl-token",
      mintAuthorityRevoked: true,
      freezeAuthorityRevoked: true,
      top10HolderPct: 10,
      flags: [],
      warnings: [],
    });
    expect(report.error).toBeUndefined();
  });

  it("flags mint and freeze authority and concentrated holders", async () => {
    const rpc = new FakeRpc();
    const mint = addr(2);
    rpc.addMint(mint, { mintAuthority: addr(90), freezeAuthority: addr(91), supply: SUPPLY.toString() });
    rpc.addHolder(mint, (SUPPLY * 45n) / 100n);

    const report = await checkSafety(rpc, mint);
    expect(report.flags).toEqual(["mint_authority", "freeze_authority", "concentrated"]);
    expect(report.warnings.join("\n")).toMatch(/mint more tokens[\s\S]*freeze wallets[\s\S]*45\.0% of supply/);
  });

  it("flags dangerous Token-2022 extensions", async () => {
    const rpc = new FakeRpc();
    const mint = addr(3);
    rpc.addMint(mint, {
      token2022: true,
      extensions: [
        { extension: "permanentDelegate", state: { delegate: addr(92) } },
        { extension: "transferFeeConfig", state: { olderTransferFee: { transferFeeBasisPoints: 0 }, newerTransferFee: { transferFeeBasisPoints: 500 } } },
        { extension: "metadataPointer", state: {} },
      ],
    });

    const report = await checkSafety(rpc, mint);
    expect(report.tokenProgram).toBe("token-2022");
    expect(report.flags).toEqual(["permanent_delegate", "transfer_fee"]);
    expect(report.warnings[1]).toBe("Charges a 5% fee on every transfer");
  });

  it("says plainly when an address isn't a coin", async () => {
    const rpc = new FakeRpc();
    const wallet = addr(4);
    rpc.addWallet(wallet);
    expect(await checkSafety(rpc, wallet)).toEqual({ isToken: false, flags: [], warnings: [] });
    expect(await checkSafety(rpc, addr(5))).toEqual({ isToken: false, flags: [], warnings: [] });
  });

  it("reports RPC failures instead of throwing", async () => {
    const rpc = new FakeRpc();
    rpc.failOn.set("getAccountInfo", new Error("RPC getAccountInfo failed: HTTP 429"));
    const report = await checkSafety(rpc, addr(6));
    expect(report.isToken).toBe(false);
    expect(report.error).toMatch(/429/);
  });

  it("keeps the authority checks when only the holder lookup fails", async () => {
    const rpc = new FakeRpc();
    const mint = addr(7);
    rpc.addMint(mint);
    rpc.failOn.set("getTokenLargestAccounts", new Error("too many requests"));
    const report = await checkSafety(rpc, mint);
    expect(report.isToken).toBe(true);
    expect(report.mintAuthorityRevoked).toBe(true);
    expect(report.top10HolderPct).toBeUndefined();
    expect(report.error).toBe("couldn't load holders: too many requests");
  });
});
