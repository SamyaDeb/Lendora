"use client";
import {useState} from "react";
import Link from "next/link";
import {useQuery} from "@tanstack/react-query";
import {formatUnits, maxUint256} from "viem";
import {useAccount} from "wagmi";
import {erc20Abi, stocklineRouterAbi, underlyingEquivalent} from "@stockline/sdk";
import {deployment, TICKERS} from "@/lib/env";
import {browserApi} from "@/lib/api";
import {deadline, useChainMarket, useWriter} from "@/lib/hooks";
import {currentDebt, preview} from "@/lib/preview";
import {useSteps, type Step} from "@/lib/tx";
import {buildSwap} from "@/lib/swap";
import {guardReasonList, tokenPaused} from "@/lib/guard";
import {num, wad} from "@/lib/format";
import {useRestricted} from "@/app/providers";
import {AmountInput, parseAmount} from "./ui";
import {Empty, HealthFactor, Notice, Skeleton, Stat, StepList} from "./ui";
import {FaucetButton} from "./FaucetButton";

/** 06 `/portfolio`: every Stockline position of the wallet, from the chain (APP-R5), refreshed every 5 s and after
 * every transaction (APP-R7). Exits are always available (APP-R2, APP-R4, CP-R4). */
export function Portfolio() {
  const {address} = useAccount();
  const restricted = useRestricted();
  if (!address)
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold">Portfolio</h1>
        {restricted && <RestrictedNote />}
        <Empty title="Connect a wallet to see your positions" />
      </div>
    );
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Portfolio</h1>
      {restricted && <RestrictedNote />}
      {!restricted && <FaucetButton />}
      <div className="space-y-4" data-testid="positions">
        {TICKERS.map((t) => (
          <PositionCard key={t} symbol={t} restricted={restricted} />
        ))}
      </div>
    </div>
  );
}

function RestrictedNote() {
  return <Notice tone="warn">Stockline is not available in your region. You can still repay, close and withdraw your existing positions.</Notice>;
}

function PositionCard({symbol, restricted}: {symbol: string; restricted: boolean}) {
  const d = deployment();
  const s = d.stocks[symbol];
  const q = useChainMarket(symbol);
  const w = useWriter();
  const steps = useSteps(`portfolio:${symbol}`);
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
  const st = q.data;
  if (!st) return <div className="card p-4"><Skeleton className="h-16 w-full" /></div>;
  const u = st.user!;
  const debt = currentDebt(st);
  const hasBorrow = u.borrowShares > 0n || u.collateral > 0n;
  const hasLend = u.vaultShares > 0n;
  if (!hasBorrow && !hasLend) return null;
  const pv = preview(st, {collateralIn: 0n, borrowAmount: 0n});
  const paused = tokenPaused(st.guardReasons);
  const dl = deadline(st.now);
  const price = Number(st.stockAnswer) / 1e8;
  const accrued = principal.data !== undefined ? Number(formatUnits(debt, 18)) - principal.data : undefined;

  const close: Step[] = (() => {
    const usdgIn = (debt * st.stockAnswer * 102n) / (10n ** 20n * 100n) + 1n;
    return [
      {id: "approve", label: "Approve USDG", kind: "approve", skip: u.usdgAllowance >= usdgIn, run: async () => void (await w.send({address: d.usdg, abi: erc20Abi, functionName: "approve", args: [d.router!, maxUint256]}))},
      {
        id: "close",
        label: `Buy back ${wad(debt, 4)} ${symbol}, repay, withdraw collateral`,
        kind: "execute",
        run: async () => void (await w.send({address: d.router!, abi: stocklineRouterAbi, functionName: "closeShort", args: [s.stockToken, usdgIn, buildSwap(d, d.usdg, s.stockToken, usdgIn, (debt * 1001n) / 1000n), w.address, dl]})),
      },
    ];
  })();
  const repayAll: Step[] = [
    {id: "approve", label: `Approve ${symbol}`, kind: "approve", skip: u.stockAllowance >= (debt * 101n) / 100n, run: async () => void (await w.send({address: s.stockToken, abi: erc20Abi, functionName: "approve", args: [d.router!, maxUint256]}))},
    {id: "repay", label: `Repay ${wad(debt, 4)} ${symbol}`, kind: "execute", run: async () => void (await w.send({address: d.router!, abi: stocklineRouterAbi, functionName: "repay", args: [s.stockToken, 0n, maxUint256, w.address, dl]}))},
  ];
  const addAmt = parseAmount(add, 6) ?? 0n;
  const addCollateral: Step[] = [
    {id: "approve", label: "Approve USDG", kind: "approve", skip: u.usdgAllowance >= addAmt, run: async () => void (await w.send({address: d.usdg, abi: erc20Abi, functionName: "approve", args: [d.router!, maxUint256]}))},
    {id: "add", label: `Add ${add} USDG collateral`, kind: "execute", run: async () => void (await w.send({address: d.router!, abi: stocklineRouterAbi, functionName: "addCollateral", args: [s.stockToken, addAmt, w.address, dl]}))},
  ];
  const withdrawAll: Step[] = [{id: "withdraw", label: "Withdraw all collateral", kind: "execute", run: async () => void (await w.send({address: d.router!, abi: stocklineRouterAbi, functionName: "withdrawCollateral", args: [s.stockToken, maxUint256, w.address, dl]}))}];
  const withdrawLend: Step[] = [
    {id: "approve", label: `Approve r${symbol}`, kind: "approve", skip: u.vaultAllowance >= u.vaultShares, run: async () => void (await w.send({address: s.vault, abi: erc20Abi, functionName: "approve", args: [d.router!, maxUint256]}))},
    {id: "withdraw", label: `Withdraw all ${symbol}`, kind: "execute", run: async () => void (await w.send({address: d.router!, abi: stocklineRouterAbi, functionName: "withdrawLend", args: [s.stockToken, u.vaultShares, 0n, w.address, dl]}))},
  ];

  return (
    <article className="card space-y-3 p-4" aria-labelledby={`pos-${symbol}`} data-testid={`position-${symbol}`}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 id={`pos-${symbol}`} className="text-lg font-semibold">
          {symbol}
        </h2>
        {st.guardReasons !== 0n && <span className="text-sm text-[var(--color-danger)]">Guard tripped: {guardReasonList(st.guardReasons).join(", ")} (exits still work)</span>}
      </div>
      {paused && <Notice tone="warn">The issuer has paused {symbol}. Repaying or closing needs {symbol} transfers and waits for the issuer; USDG collateral can still be withdrawn once your debt allows it.</Notice>}
      {hasLend && (
        <div className="flex flex-wrap items-end justify-between gap-3 border-t border-[var(--color-line)] pt-3">
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <Stat label={`Lent (r${symbol})`} value={`${wad(u.vaultAssets, 4)} ${symbol}`} />
            <Stat label="Shares of stock" value={wad(underlyingEquivalent(u.vaultAssets, st.multiplier), 4)} />
            <Stat label="Value" value={`$${num(Number(formatUnits(u.vaultAssets, 18)) * price)}`} />
          </dl>
          <button className="btn btn-ghost" disabled={steps.busy} onClick={() => steps.run(withdrawLend)} data-testid={`withdraw-lend-${symbol}`}>
            Withdraw
          </button>
        </div>
      )}
      {hasBorrow && (
        <div className="space-y-3 border-t border-[var(--color-line)] pt-3">
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label="Debt" value={`${wad(debt, 4)} ${symbol}`} />
            <Stat label="Collateral" value={`${num(Number(formatUnits(u.collateral, 6)))} USDG`} />
            <Stat label="Health factor now" value={<HealthFactor hf={debt > 0n ? pv.hfNow : undefined} />} />
            <Stat label="…at the next close" value={<HealthFactor hf={debt > 0n ? pv.hfAtClose : undefined} />} />
            <Stat label="Liquidation price now" value={debt > 0n ? `$${num(Number(formatUnits(pv.liqPriceNow, 8)))}` : "–"} />
            <Stat label="…during the next closure" value={debt > 0n && pv.liqPriceAtClose ? `$${num(Number(formatUnits(pv.liqPriceAtClose, 8)))}` : "–"} />
            <Stat label="Accrued interest" value={accrued !== undefined ? `${num(accrued, 6)} ${symbol}` : "–"} />
            <Stat label="Price now" value={`$${num(price)}`} />
          </dl>
          <p className="text-xs text-[var(--color-muted)]">Liquidation happens at a health factor of 1.00.</p>
          <div className="flex flex-wrap items-end gap-2">
            {debt > 0n && (
              <>
                <button className="btn" disabled={steps.busy} onClick={() => steps.run(close)} data-testid={`close-${symbol}`}>
                  Close (buy back with USDG)
                </button>
                <button className="btn btn-ghost" disabled={steps.busy} onClick={() => steps.run(repayAll)} data-testid={`repay-${symbol}`}>
                  Repay with {symbol}
                </button>
              </>
            )}
            {debt === 0n && u.collateral > 0n && (
              <button className="btn" disabled={steps.busy} onClick={() => steps.run(withdrawAll)} data-testid={`withdraw-collateral-${symbol}`}>
                Withdraw collateral
              </button>
            )}
            {/* RT-R8: "Add collateral" is a rescue top-up for a position with debt; new collateral enters with a borrow. */}
            {u.borrowShares > 0n && (
              <div className="flex items-end gap-2">
                <div className="w-40">
                  <AmountInput label="Add collateral" value={add} onChange={setAdd} decimals={6} unit="USDG" testId={`add-amount-${symbol}`} />
                </div>
                <button className="btn btn-ghost" disabled={steps.busy || addAmt === 0n} onClick={async () => (await steps.run(addCollateral)) && setAdd("")} data-testid={`add-${symbol}`}>
                  Add
                </button>
              </div>
            )}
          </div>
        </div>
      )}
      <StepList steps={steps.states} />
      {steps.error && <Notice tone="danger">{steps.error}</Notice>}
      {!restricted && (
        <Link href={`/short/${symbol}`} className="text-sm underline">
          Open more
        </Link>
      )}
    </article>
  );
}
