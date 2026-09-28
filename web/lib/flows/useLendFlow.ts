"use client";
import {useState} from "react";
import {useQuery} from "@tanstack/react-query";
import {maxUint256} from "viem";
import {erc20Abi, stocklineRouterAbi, vaultV2FullAbi, withdrawableAssets} from "@stockline/sdk";
import {deployment} from "@/lib/env";
import {browserApi} from "@/lib/api";
import {deadline, useChainMarket} from "@/lib/hooks";
import type {Step} from "@/lib/tx";
import {tokenPaused} from "@/lib/guard";
import {parseAmount} from "@/components/ui";
import {amt, planned, useTrackedWriter, useTxRunner} from "./common";

export type LendMode = "deposit" | "withdraw";

/**
 * Lend / withdraw through the router into rSTOCK (US-L1, US-L3, LM-R22). The calls, arguments and step lists are the
 * ones LendPanel used; only the presentation moved out.
 */
export function useLendFlow(symbol: string) {
  const d = deployment();
  const s = d.stocks[symbol];
  const [mode, setModeRaw] = useState<LendMode>("deposit");
  const [amount, setAmount] = useState("");
  const chainQ = useChainMarket(symbol);
  const apiQ = useQuery({queryKey: ["market", symbol], queryFn: () => browserApi().market(symbol), refetchInterval: 10_000});
  const w = useTrackedWriter();
  const steps = useTxRunner(`lend:${mode}`, w.lastHash);
  const flows = useQuery({
    queryKey: ["lendFlows", symbol, w.address],
    enabled: Boolean(w.address),
    queryFn: async () => {
      const c = browserApi();
      const [l, wl] = await Promise.all([c.events(symbol, {type: "lend", account: w.address, limit: 500}), c.events(symbol, {type: "withdrawLend", account: w.address, limit: 500})]);
      const sum = (xs: {assets: string | null}[]) => xs.reduce((a, e) => a + Number(e.assets ?? 0), 0);
      return sum(l.data) - sum(wl.data);
    },
  });
  const st = chainQ.data;
  const u = st?.user;
  const parsed = parseAmount(amount, 18);
  const cap = BigInt(s.capAssets);
  const atCap = st ? st.adapterAssets >= (cap * 999n) / 1000n : false;
  const withdrawable = st && u ? withdrawableAssets(u.vaultAssets, st.vaultIdle, st.adapterAssets, st.market.totalSupplyAssets, st.market.totalBorrowAssets) : 0n;
  const market = apiQ.data?.data;
  const price = market ? Number(market.price.usdPerToken) : 0;
  const value = u ? Number(u.vaultAssets) / 1e18 : 0;
  const earnings = flows.data !== undefined && u ? value - flows.data : undefined;
  const max = mode === "deposit" ? u?.stockBalance : withdrawable;
  const invalid = !parsed || parsed === 0n || (max !== undefined && parsed > max);

  const setMode = (m: LendMode) => {
    setModeRaw(m);
    setAmount("");
    steps.reset();
  };

  /** The step list for the current input (reads previewDeposit for the slippage floor, as before). */
  async function build(): Promise<Step[] | undefined> {
    if (!st || !u || !parsed || parsed === 0n) return;
    const dl = deadline(st.now);
    if (mode === "deposit") {
      const minShares = ((await w.pc.readContract({address: s.vault, abi: vaultV2FullAbi, functionName: "previewDeposit", args: [parsed]})) * 999n) / 1000n;
      return [
        {id: "approve", label: `Approve ${symbol}`, kind: "approve", skip: u.stockAllowance >= parsed, run: async () => void (await w.send({address: s.stockToken, abi: erc20Abi, functionName: "approve", args: [d.router!, maxUint256]}))},
        {id: "lend", label: `Deposit ${amount} ${symbol} into r${symbol}`, kind: "execute", run: async () => void (await w.send({address: d.router!, abi: stocklineRouterAbi, functionName: "lend", args: [s.stockToken, parsed, minShares, w.address, dl]}))},
      ];
    }
    const all = parsed >= u.vaultAssets;
    const shares = all ? u.vaultShares : (parsed * u.vaultShares + u.vaultAssets - 1n) / u.vaultAssets;
    const minAssets = (parsed * 999n) / 1000n;
    return [
      {id: "approve", label: `Approve r${symbol}`, kind: "approve", skip: u.vaultAllowance >= shares, run: async () => void (await w.send({address: s.vault, abi: erc20Abi, functionName: "approve", args: [d.router!, maxUint256]}))},
      {id: "withdraw", label: `Withdraw ${amount} ${symbol}`, kind: "execute", run: async () => void (await w.send({address: d.router!, abi: stocklineRouterAbi, functionName: "withdrawLend", args: [s.stockToken, shares, minAssets, w.address, dl]}))},
    ];
  }

  /** Steps as the review sheet shows them before signing (same labels and skips as `build`). */
  const plan =
    u && parsed
      ? planned(
          mode === "deposit"
            ? [
                {id: "approve", label: `Approve ${symbol}`, kind: "approve", skip: u.stockAllowance >= parsed},
                {id: "lend", label: `Deposit ${amount} ${symbol} into r${symbol}`, kind: "execute"},
              ]
            : [
                {id: "approve", label: `Approve r${symbol}`, kind: "approve", skip: u.vaultAllowance >= (parsed >= u.vaultAssets ? u.vaultShares : (parsed * u.vaultShares + u.vaultAssets - 1n) / (u.vaultAssets || 1n))},
                {id: "withdraw", label: `Withdraw ${amount} ${symbol}`, kind: "execute"},
              ],
        )
      : [];

  async function confirm() {
    const list = await build();
    if (!list) return false;
    const a = amt(amount);
    const ok = await steps.run(
      list,
      mode === "deposit" ? {pending: `Lending ${a} ${symbol}`, done: `Lent ${a} ${symbol}`, failed: `Couldn't lend ${symbol}`, doneBody: `It now earns the lend APY as r${symbol}.`} : {pending: `Withdrawing ${a} ${symbol}`, done: `Withdrew ${a} ${symbol}`, failed: `Couldn't withdraw ${symbol}`},
    );
    if (ok) setAmount("");
    return ok;
  }

  return {symbol, mode, setMode, amount, setAmount, parsed, st, u, market, price, value, earnings, atCap, withdrawable, max, invalid, paused: st ? tokenPaused(st.guardReasons) : false, ready: w.ready, address: w.address, plan, steps, confirm, loading: chainQ.isPending};
}

export type LendFlow = ReturnType<typeof useLendFlow>;
