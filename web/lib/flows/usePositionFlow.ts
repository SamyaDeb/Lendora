"use client";
import {useState} from "react";
import {useQueries, useQuery} from "@tanstack/react-query";
import {formatUnits, maxUint256, type PublicClient} from "viem";
import {useAccount, usePublicClient} from "wagmi";
import {erc20Abi, lendoraRouterAbi} from "@lendora/sdk";
import {deployment, TICKERS} from "@/lib/env";
import {browserApi} from "@/lib/api";
import {deadline, useChainMarket} from "@/lib/hooks";
import {readMarket, type MarketChainState} from "@/lib/chain";
import {currentDebt, preview} from "@/lib/preview";
import type {Step} from "@/lib/tx";
import {buildSwap} from "@/lib/swap";
import {guardReasonList, tokenPaused} from "@/lib/guard";
import {wad} from "@/lib/format";
import {parseAmount} from "@/components/ui";
import {planned, useTrackedWriter, useTxRunner} from "./common";

export type PositionAction = "close" | "repay" | "add" | "withdrawCollateral" | "withdrawLend";

/** Every stock's chain state for the connected wallet (same query as useChainMarket, so cards share the cache). */
export function useAllPositions() {
  const pc = usePublicClient();
  const {address} = useAccount();
  const qs = useQueries({
    queries: TICKERS.map((t) => ({queryKey: ["chain", t, address ?? null], queryFn: () => readMarket(pc as PublicClient, deployment(), t, address), enabled: Boolean(pc), refetchInterval: 5000})),
  });
  return TICKERS.map((t, i) => ({symbol: t, st: qs[i].data as MarketChainState | undefined, error: qs[i].isError && !qs[i].data}));
}

/** Health summary of a position (undefined HF = no debt). */
export function positionSummary(st: MarketChainState) {
  const u = st.user;
  if (!u) return {hasBorrow: false, hasLend: false, debt: 0n};
  const debt = currentDebt(st);
  return {hasBorrow: u.borrowShares > 0n || u.collateral > 0n, hasLend: u.vaultShares > 0n, debt, hf: debt > 0n ? preview(st, {collateralIn: 0n, borrowAmount: 0n}).hfNow : undefined};
}

/**
 * One stock's positions and their exits (06 `/portfolio`). The step lists are PositionCard's, unchanged: close
 * (buy back with USDG, repay, withdraw), repay with the stock, add collateral (rescue top-up, RT-R8), withdraw
 * collateral, withdraw the lend. Exits are never geo-blocked (APP-R2).
 */
export function usePositionFlow(symbol: string) {
  const d = deployment();
  const s = d.stocks[symbol];
  const q = useChainMarket(symbol);
  const w = useTrackedWriter();
  const steps = useTxRunner(`portfolio:${symbol}`, w.lastHash);
  const [add, setAdd] = useState("");
  const principal = useQuery({
    queryKey: ["borrowFlows", symbol, w.address],
    enabled: Boolean(w.address),
    queryFn: async () => {
      const c = browserApi();
      const [b, r, l] = await Promise.all([
        c.events(symbol, {type: "borrow", account: w.address, limit: 500}),
        c.events(symbol, {type: "repay", account: w.address, limit: 500}),
        c.events(symbol, {type: "liquidate", account: w.address, limit: 500}),
      ]);
      const sum = (xs: {assets: string | null}[]) => xs.reduce((a, e) => a + Number(e.assets ?? 0), 0);
      return sum(b.data) - sum(r.data) - sum(l.data);
    },
  });
  const lendFlows = useQuery({
    queryKey: ["lendFlows", symbol, w.address],
    enabled: Boolean(w.address),
    queryFn: async () => {
      const c = browserApi();
      const [l, wl] = await Promise.all([c.events(symbol, {type: "lend", account: w.address, limit: 500}), c.events(symbol, {type: "withdrawLend", account: w.address, limit: 500})]);
      const sum = (xs: {assets: string | null}[]) => xs.reduce((a, e) => a + Number(e.assets ?? 0), 0);
      return sum(l.data) - sum(wl.data);
    },
  });
  const st = q.data;
  const u = st?.user;
  const debt = st ? currentDebt(st) : 0n;
  const addAmt = parseAmount(add, 6) ?? 0n;

  function lists(): Record<PositionAction, Step[]> | undefined {
    if (!st || !u) return;
    const dl = deadline(st.now);
    const usdgIn = (debt * st.stockAnswer * 102n) / (10n ** 20n * 100n) + 1n;
    return {
      close: [
        {id: "approve", label: "Approve USDG", kind: "approve", skip: u.usdgAllowance >= usdgIn, run: async () => void (await w.send({address: d.usdg, abi: erc20Abi, functionName: "approve", args: [d.router!, maxUint256]}))},
        {
          id: "close",
          label: `Buy back ${wad(debt, 4)} ${symbol}, repay, withdraw collateral`,
          kind: "execute",
          run: async () => void (await w.send({address: d.router!, abi: lendoraRouterAbi, functionName: "closeShort", args: [s.stockToken, usdgIn, buildSwap(d, d.usdg, s.stockToken, usdgIn, (debt * 1001n) / 1000n), w.address, dl]})),
        },
      ],
      repay: [
        {id: "approve", label: `Approve ${symbol}`, kind: "approve", skip: u.stockAllowance >= (debt * 101n) / 100n, run: async () => void (await w.send({address: s.stockToken, abi: erc20Abi, functionName: "approve", args: [d.router!, maxUint256]}))},
        {id: "repay", label: `Repay ${wad(debt, 4)} ${symbol}`, kind: "execute", run: async () => void (await w.send({address: d.router!, abi: lendoraRouterAbi, functionName: "repay", args: [s.stockToken, 0n, maxUint256, w.address, dl]}))},
      ],
      add: [
        {id: "approve", label: "Approve USDG", kind: "approve", skip: u.usdgAllowance >= addAmt, run: async () => void (await w.send({address: d.usdg, abi: erc20Abi, functionName: "approve", args: [d.router!, maxUint256]}))},
        {id: "add", label: `Add ${add} USDG collateral`, kind: "execute", run: async () => void (await w.send({address: d.router!, abi: lendoraRouterAbi, functionName: "addCollateral", args: [s.stockToken, addAmt, w.address, dl]}))},
      ],
      withdrawCollateral: [{id: "withdraw", label: "Withdraw all collateral", kind: "execute", run: async () => void (await w.send({address: d.router!, abi: lendoraRouterAbi, functionName: "withdrawCollateral", args: [s.stockToken, maxUint256, w.address, dl]}))}],
      withdrawLend: [
        {id: "approve", label: `Approve r${symbol}`, kind: "approve", skip: u.vaultAllowance >= u.vaultShares, run: async () => void (await w.send({address: s.vault, abi: erc20Abi, functionName: "approve", args: [d.router!, maxUint256]}))},
        {id: "withdraw", label: `Withdraw all ${symbol}`, kind: "execute", run: async () => void (await w.send({address: d.router!, abi: lendoraRouterAbi, functionName: "withdrawLend", args: [s.stockToken, u.vaultShares, 0n, w.address, dl]}))},
      ],
    };
  }

  const COPY: Record<PositionAction, {pending: string; done: string; failed: string}> = {
    close: {pending: `Closing your ${symbol} position`, done: `Closed your ${symbol} position`, failed: `Couldn't close ${symbol}`},
    repay: {pending: `Repaying ${symbol}`, done: `Repaid ${wad(debt, 4)} ${symbol}`, failed: `Couldn't repay ${symbol}`},
    add: {pending: `Adding ${add} USDG collateral`, done: `Added ${add} USDG collateral`, failed: "Couldn't add collateral"},
    withdrawCollateral: {pending: "Withdrawing collateral", done: "Withdrew your collateral", failed: "Couldn't withdraw collateral"},
    withdrawLend: {pending: `Withdrawing ${symbol}`, done: `Withdrew your ${symbol}`, failed: `Couldn't withdraw ${symbol}`},
  };

  const plan = (a: PositionAction) => {
    const l = lists();
    return l ? planned(l[a]) : [];
  };
  async function confirm(a: PositionAction) {
    const l = lists();
    if (!l) return false;
    const ok = await steps.run(l[a], COPY[a]);
    if (ok && a === "add") setAdd("");
    return ok;
  }

  const price = st ? Number(st.stockAnswer) / 1e8 : 0;
  // No indexed opening event yet (the indexer is behind the chain): unknown, not "everything is profit".
  const accrued = principal.data !== undefined && principal.data > 0 ? Number(formatUnits(debt, 18)) - principal.data : undefined;
  const fees = lendFlows.data !== undefined && lendFlows.data > 0 && u ? Number(formatUnits(u.vaultAssets, 18)) - lendFlows.data : undefined;
  return {symbol, st, u, debt, price, accrued, fees, add, setAdd, addAmt, plan, confirm, steps, paused: st ? tokenPaused(st.guardReasons) : false, guard: st ? guardReasonList(st.guardReasons) : [], ready: w.ready};
}

export type PositionFlow = ReturnType<typeof usePositionFlow>;
