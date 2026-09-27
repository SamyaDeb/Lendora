"use client";
import {useEffect, useMemo, useRef, useState} from "react";
import Link from "next/link";
import {useQuery} from "@tanstack/react-query";
import {formatUnits, maxUint256} from "viem";
import {useSignMessage} from "wagmi";
import {erc20Abi, morphoAbi, stocklineRouterAbi} from "@stockline/sdk";
import {deployment} from "@/lib/env";
import {deadline, useChainMarket, useWriter} from "@/lib/hooks";
import {quoteSwap} from "@/lib/chain";
import {maxBorrowFor, preview} from "@/lib/preview";
import {useSteps, type Step} from "@/lib/tx";
import {compliance} from "@/lib/compliance";
import {buildSwap} from "@/lib/swap";
import {guardReasonList} from "@/lib/guard";
import {track} from "@/lib/analytics";
import {AmountInput, parseAmount} from "./AmountInput";
import {PreviewPanel} from "./PreviewPanel";
import {GuardBanner, Notice, StepList} from "./ui";

/** 06 `/short/[symbol]`: open a short (borrow + sell, US-B2) or just borrow (US-B1), with the preview panel. */
export function ShortPanel({symbol}: {symbol: string}) {
  const d = deployment();
  const s = d.stocks[symbol];
  const [mode, setMode] = useState<"short" | "borrow">("short");
  const [collateral, setCollateral] = useState("");
  const [amount, setAmount] = useState("");
  const [targetHf, setTargetHf] = useState(1.5);
  const [compound, setCompound] = useState(false);
  const chainQ = useChainMarket(symbol);
  const w = useWriter();
  const {signMessageAsync} = useSignMessage();
  const steps = useSteps(`borrow:${mode}`);
  const st = chainQ.data;
  const collIn = parseAmount(collateral, 6) ?? 0n;
  const borrowAmt = parseAmount(amount, 18) ?? 0n;

  const quote = useQuery({
    queryKey: ["quote", symbol, borrowAmt.toString(), mode],
    enabled: mode === "short" && borrowAmt > 0n,
    queryFn: () => quoteSwap(w.pc, d, s.stockToken, d.usdg, borrowAmt),
  });
  const pv = useMemo(() => (st && (borrowAmt > 0n || collIn > 0n) ? preview(st, {collateralIn: collIn, borrowAmount: borrowAmt, usdgOut: mode === "short" ? quote.data : undefined, compound: mode === "short" && compound}) : undefined), [st, collIn, borrowAmt, mode, quote.data, compound]);
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

  async function submit() {
    if (!st || !pv || !w.address) return;
    const u = st.user!;
    const dl = deadline(st.now);
    let att: {expiry: string; signature: `0x${string}`} | undefined;
    const list: Step[] = [
      {id: "approve", label: "Approve USDG", kind: "approve", skip: collIn === 0n || u.usdgAllowance >= collIn, run: async () => void (await w.send({address: d.usdg, abi: erc20Abi, functionName: "approve", args: [d.router!, maxUint256]}))},
      {
        id: "authorize",
        label: "Authorize the Stockline router on Morpho (revocable any time with Morpho setAuthorization)",
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
            await w.send({address: d.router!, abi: stocklineRouterAbi, functionName: "openShort", args: [s.stockToken, collIn, borrowAmt, swap, compound, w.address, a, dl]});
          } else {
            await w.send({address: d.router!, abi: stocklineRouterAbi, functionName: "borrow", args: [s.stockToken, collIn, borrowAmt, w.address, a, dl]});
          }
        },
      },
    ];
    if (await steps.run(list)) {
      setAmount("");
      setCollateral("");
    }
  }

  const disabled = !w.ready || tripped || !pv || borrowAmt === 0n || !pv.opensOk || (mode === "short" && !pv.swap) || steps.busy || (st?.user ? collIn > st.user.usdgBalance : false);
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
      <section className="card space-y-4 p-4" aria-labelledby="short-h">
        <h1 id="short-h" className="text-2xl font-bold">
          Borrow {symbol}
        </h1>
        {tripped && <GuardBanner reasons={guardReasons} />}
        {!w.address && <Notice>Connect a wallet to borrow. Borrowing needs a compliance check and is not available in restricted regions.</Notice>}
        <fieldset className="flex gap-2">
          <legend className="sr-only">Mode</legend>
          {(["short", "borrow"] as const).map((m) => (
            <label key={m} className={`btn cursor-pointer ${mode === m ? "" : "btn-ghost"}`}>
              <input type="radio" className="sr-only" name="mode" checked={mode === m} onChange={() => setMode(m)} data-testid={`mode-${m}`} />
              {m === "short" ? "Open short (sell borrowed stock)" : "Just borrow"}
            </label>
          ))}
        </fieldset>
        <AmountInput label="Collateral" value={collateral} onChange={setCollateral} decimals={6} unit="USDG" max={st?.user?.usdgBalance} testId="collateral" />
        <div className="space-y-1">
          <label htmlFor="target" className="flex justify-between text-sm font-medium">
            <span>Target health factor at t+24h</span>
            <span className="num">{targetHf.toFixed(2)}</span>
          </label>
          <input id="target" type="range" min={1.1} max={3} step={0.05} value={targetHf} onChange={(e) => applyTarget(Number(e.target.value))} className="w-full" aria-describedby="target-hint" data-testid="target-hf" />
          <p id="target-hint" className="text-xs text-[var(--color-muted)]">
            Sets the borrow amount for your collateral. The router requires at least 1.10 including the next weekend or earnings buffer.
          </p>
        </div>
        <AmountInput label="Borrow amount" value={amount} onChange={setAmount} decimals={18} unit={symbol} testId="borrow-amount" />
        {mode === "short" && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={compound} onChange={(e) => setCompound(e.target.checked)} /> Add the sale proceeds to my collateral
          </label>
        )}
        <button className="btn w-full" disabled={disabled} onClick={submit} data-testid="submit">
          {steps.busy ? "Working…" : mode === "short" ? "Open short" : "Borrow"}
        </button>
        <StepList steps={steps.states} />
        {steps.error && <Notice tone="danger">{steps.error}</Notice>}
        {steps.states.length > 0 && !steps.busy && !steps.error && (
          <Notice tone="safe">
            Done.{" "}
            <Link href="/portfolio" className="underline">
              See your position
            </Link>
          </Notice>
        )}
      </section>
      <div className="space-y-4">{pv && st ? <PreviewPanel p={pv} symbol={symbol} now={Number(st.now)} mode={mode} /> : <Notice>Enter collateral and an amount to see the preview.</Notice>}</div>
    </div>
  );
}
