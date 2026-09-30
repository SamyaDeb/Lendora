import {describe, expect, it, vi} from "vitest";
import type {PublicClient, WalletClient} from "viem";
import {GAS_HEADROOM_PCT, simulateAndSend} from "@/lib/tx";

/**
 * Found by testnetBreak on 46630: a router `lend` sent with the bare gas estimate ran out of gas on-chain (326,005 of
 * 332,112, tx 0x39195c93…), because on Robinhood Chain (Arbitrum Orbit) part of the gas pays the L1 data fee, which
 * moves between estimation and inclusion. The app sends every transaction with headroom and names an out-of-gas
 * failure instead of a bare "transaction reverted".
 */
const call = {address: "0x0000000000000000000000000000000000000001", abi: [], functionName: "lend", args: []} as never;
const account = "0x0000000000000000000000000000000000000002" as const;

function clients(estimate: bigint, receipt: {status: "success" | "reverted"; gasUsed: bigint}) {
  const request = {address: "0x1", functionName: "lend"};
  const pc = {
    simulateContract: vi.fn().mockResolvedValue({request}),
    estimateContractGas: vi.fn().mockResolvedValue(estimate),
    waitForTransactionReceipt: vi.fn().mockResolvedValue(receipt),
  } as unknown as PublicClient;
  const wc = {writeContract: vi.fn().mockResolvedValue("0xhash")} as unknown as WalletClient;
  return {pc, wc};
}

describe("gas headroom for the L1 data fee (Arbitrum Orbit)", () => {
  it("sends with the estimate plus headroom", async () => {
    const {pc, wc} = clients(300_000n, {status: "success", gasUsed: 290_000n});
    await simulateAndSend(pc, wc, account, call);
    expect((wc.writeContract as ReturnType<typeof vi.fn>).mock.calls[0][0].gas).toBe((300_000n * (100n + GAS_HEADROOM_PCT)) / 100n);
    expect(GAS_HEADROOM_PCT).toBeGreaterThanOrEqual(25n);
  });

  it("an out-of-gas failure says so (and that retrying is safe)", async () => {
    const limit = (300_000n * (100n + GAS_HEADROOM_PCT)) / 100n;
    const {pc, wc} = clients(300_000n, {status: "reverted", gasUsed: limit - 100n});
    await expect(simulateAndSend(pc, wc, account, call)).rejects.toThrow(/ran out of gas.*retry/i);
  });
});
