"use client";
import {useEffect, useMemo, useRef, useState} from "react";
import {useQuery} from "@tanstack/react-query";
import {formatUnits, maxUint256} from "viem";
import {useSignMessage} from "wagmi";
import {erc20Abi, morphoAbi, lendoraRouterAbi} from "@lendora/sdk";
import {deployment} from "@/lib/env";
import {deadline, useChainMarket} from "@/lib/hooks";
import {quoteSwap} from "@/lib/chain";
import {maxBorrowFor, preview} from "@/lib/preview";
import type {Step} from "@/lib/tx";
import {compliance} from "@/lib/compliance";
import {buildSwap} from "@/lib/swap";
import {guardReasonList} from "@/lib/guard";
import {track} from "@/lib/analytics";
import {collateralRequirement} from "@/lib/requirements";
import {parseAmount} from "@/components/ui";
import {amt, planned, useTrackedWriter, useTxRunner} from "./common";

export type BorrowMode = "short" | "borrow";

/**
 * Open a short (borrow + sell, US-B2) or just borrow (US-B1). Calls, arguments and the step list are the ones
 * ShortPanel used (approve → authorize Morpho, first time only → terms → compliance attestation → execute).
 */
export function useBorrowFlow(symbol: string, mode: BorrowMode) {
  const d = deployment();
  const s = d.stocks[symbol];
  const [collateral, setCollateral] = useState("");
  const [amount, setAmount] = useState("");
  const [targetHf, setTargetHf] = useState(1.5);
  const [compound, setCompound] = useState(false);
  const chainQ = useChainMarket(symbol);
  const w = useTrackedWriter();
  const {signMessageAsync} = useSignMessage();
  const steps = useTxRunner(`borrow:${mode}`, w.lastHash);
  const st = chainQ.data;
  const collIn = parseAmount(collateral, 6) ?? 0n;
  const borrowAmt = parseAmount(amount, 18) ?? 0n;

  const quote = useQuery({
    queryKey: ["quote", symbol, borrowAmt.toString(), mode],
    enabled: mode === "short" && borrowAmt > 0n,
    queryFn: () => quoteSwap(w.pc, d, s.stockToken, d.usdg, borrowAmt),
  });
  const pv = useMemo(() => (st && (borrowAmt > 0n || collIn > 0n) ? preview(st, {collateralIn: collIn, borrowAmount: borrowAmt, usdgOut: mode === "short" ? quote.data : undefined, compound: mode === "short" && compound}) : undefined), [st, collIn, borrowAmt, mode, quote.data, compound]);
  const requirement = useMemo(() => (st && borrowAmt > 0n ? collateralRequirement(st, borrowAmt) : undefined), [st, borrowAmt]);
  const tracked = useRef(false);
  useEffect(() => {
    if (pv && borrowAmt > 0n && !tracked.current) {
      tracked.current = true;
      track("preview", {funnel: `borrow:${mode}`});
    }
  }, [pv, borrowAmt, mode]);

  const guardReasons = st ? guardReasonList(st.guardReasons) : [];
  const tripped = st ? st.guardReasons !== 0n : false;

  function applyTarget(hf: number) {
    setTargetHf(hf);
    if (!st) return;
    const max = maxBorrowFor(st, collIn, BigInt(Math.round(hf * 1e4)) * 10n ** 14n);
    setAmount(max > 0n ? formatUnits((max * 999n) / 1000n, 18) : "");
  }

  const u = st?.user;
  const verb = mode === "short" ? "Short" : "Borrow";

  function build(): Step[] | undefined {
    if (!st || !pv || !w.address) return;
    const u = st.user!;
    const dl = deadline(st.now);
    let att: {expiry: string; signature: `0x${string}`} | undefined;
    return [
      {id: "approve", label: "Approve USDG", kind: "approve", skip: collIn === 0n || u.usdgAllowance >= collIn, run: async () => void (await w.send({address: d.usdg, abi: erc20Abi, functionName: "approve", args: [d.router!, maxUint256]}))},
      {
        id: "authorize",
        label: "Authorize the Lendora router on Morpho (first time only; revocable any time)",
        kind: "authorize",
        skip: u.authorized,
        run: async () => void (await w.send({address: d.morpho, abi: morphoAbi, functionName: "setAuthorization", args: [d.router!, true]})),
      },
      {
        id: "terms",
        label: "Accept the terms and risk disclosure (signature, no gas)",
        kind: "sign",
        run: async () => {
          if ((await compliance.termsStatus(w.address!)).accepted) return;
          const t = await compliance.terms(w.address!);
          const signature = await signMessageAsync({message: t.message!});
          await compliance.acceptTerms(w.address!, signature, t.version);
        },
      },
      {id: "attest", label: "Compliance check (region, sanctions)", kind: "attest", run: async () => void (att = await compliance.attest(w.address!))},
      {
        id: "execute",
        label: mode === "short" ? `Borrow ${amount} ${symbol} and sell for USDG` : `Borrow ${amount} ${symbol}`,
        kind: "execute",
        run: async () => {
          const a = {expiry: BigInt(att!.expiry), signature: att!.signature};
          if (mode === "short") {
            const q = pv.swap!;
            const swap = buildSwap(d, s.stockToken, d.usdg, borrowAmt, q.minOut);
            await w.send({address: d.router!, abi: lendoraRouterAbi, functionName: "openShort", args: [s.stockToken, collIn, borrowAmt, swap, compound, w.address, a, dl]});
          } else {
            await w.send({address: d.router!, abi: lendoraRouterAbi, functionName: "borrow", args: [s.stockToken, collIn, borrowAmt, w.address, a, dl]});
          }
        },
      },
    ];
  }

  const list = build();
  const plan = list ? planned(list) : [];

  async function confirm() {
    const l = build();
    if (!l) return false;
    const a = amt(amount);
    const ok = await steps.run(l, {pending: mode === "short" ? `Shorting ${a} ${symbol}` : `Borrowing ${a} ${symbol}`, done: mode === "short" ? `Shorted ${a} ${symbol}` : `Borrowed ${a} ${symbol}`, failed: `Couldn't ${verb.toLowerCase()} ${symbol}`, doneBody: "See it in your portfolio."});
    if (ok) {
      setAmount("");
      setCollateral("");
    }
    return ok;
  }

  const overBalance = u ? collIn > u.usdgBalance : false;
  // T35: Morpho lends only what the market holds; more fails at the simulation ("not enough available stock").
  const liquidity = st ? st.market.totalSupplyAssets - st.market.totalBorrowAssets : undefined;
  const overLiquidity = liquidity !== undefined && borrowAmt > liquidity;
  /** Why the review can't open yet, in plain words (undefined = ready). */
  const blocker = !w.address
    ? "Connect a wallet to borrow."
    : tripped
      ? "Borrowing opens again when the safety guard clears. Your exits are on the portfolio page."
      : borrowAmt === 0n
        ? `Enter how much ${symbol} to ${verb.toLowerCase()}.`
        : overBalance
          ? "That's more USDG than you hold."
          : pv && !pv.opensOk
            ? "Not enough collateral: the health factor 24 hours from now would be below 1.10. Add collateral or borrow less."
            : overLiquidity
            ? `Only ${formatUnits(liquidity!, 18).replace(/(\.\d{4})\d+$/, "$1")} ${symbol} can be borrowed right now. Borrow less, or wait for lenders or the allocator to add more.`
            : mode === "short" && !pv?.swap
              ? "Getting a swap quote…"
              : undefined;
  const disabled = !w.ready || tripped || !pv || borrowAmt === 0n || !pv.opensOk || (mode === "short" && !pv.swap) || steps.busy || overBalance || overLiquidity;

  return {symbol, mode, verb, collateral, setCollateral, amount, setAmount, targetHf, applyTarget, compound, setCompound, st, u, pv, quote, requirement, collIn, borrowAmt, tripped, guardReasons, disabled, blocker, ready: w.ready, address: w.address, plan, steps, confirm, loading: chainQ.isPending};
}

export type BorrowFlow = ReturnType<typeof useBorrowFlow>;
