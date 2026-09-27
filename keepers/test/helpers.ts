import {encodeFunctionData, maxUint256, type Hex} from "viem";
import {erc20Abi, mockAggregatorAbi, mockStockTokenAbi, stocklineRouterAbi, vaultV2Abi} from "@stockline/sdk";
import type {Anvil} from "./anvil.js";
import {capIds, marketParams} from "../src/common/market.js";

/** Wed 2026-09-30 16:00Z (12:00 ET): an open session in the generated calendar. */
export const WED = 1_790_784_000n;
export const DEPLOYER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;
const PRICES: Record<string, bigint> = {SPY: 772_33000000n, NVDA: 225_66000000n, AAPL: 341_45000000n};

/** Move to `ts` and publish fresh feed rounds for every stock and USDG (mock feeds are open). */
export async function freshRounds(a: Anvil, ts: bigint, prices: Record<string, bigint> = PRICES): Promise<void> {
  await a.setTime(ts);
  const m = a.d.mocks!;
  for (const t of Object.keys(a.d.stocks)) {
    await a.send(DEPLOYER, m[`${t}_feed`], encodeFunctionData({abi: mockAggregatorAbi, functionName: "setAnswer", args: [prices[t]]}));
  }
  await a.send(DEPLOYER, m.usdgFeed, encodeFunctionData({abi: mockAggregatorAbi, functionName: "setAnswer", args: [100_000_000n]}));
}

/** Mint Stock Tokens to `lender` and lend them through the router. */
export async function lend(a: Anvil, ticker: string, lender: `0x${string}`, amount: bigint): Promise<void> {
  const token = a.d.stocks[ticker].stockToken;
  await a.send(DEPLOYER, token, encodeFunctionData({abi: mockStockTokenAbi, functionName: "mint", args: [lender, amount]}));
  await a.send(lender, token, encodeFunctionData({abi: erc20Abi, functionName: "approve", args: [a.d.router!, maxUint256]}));
  const block = await a.client.getBlock();
  await a.send(
    lender,
    a.d.router!,
    encodeFunctionData({abi: stocklineRouterAbi, functionName: "lend", args: [token, amount, 0n, lender, block.timestamp + 3600n]}),
  );
}

export async function allocation(a: Anvil, ticker: string): Promise<bigint> {
  const s = a.d.stocks[ticker];
  const ids = capIds(s.adapter, marketParams(a.d, s));
  return a.client.readContract({address: s.vault, abi: vaultV2Abi, functionName: "allocation", args: [ids[2]]});
}

export function call(abi: readonly unknown[], functionName: string, args: readonly unknown[] = []): Hex {
  // Loosely typed on purpose: tests encode calls to many contracts through one helper.
  return (encodeFunctionData as (p: unknown) => Hex)({abi, functionName, args});
}
