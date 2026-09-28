"use client";
import {useMemo, useRef, useState} from "react";
import {formatUnits} from "viem";
import {WAD} from "@stockline/sdk";
import type {BorrowFlow} from "@/lib/flows/useBorrowFlow";
import {preview, type Preview} from "@/lib/preview";
import {et, num, pct, until, wad} from "@/lib/format";
import {cn} from "@/lib/cn";
import {AmountInput, Button, GuardBanner, HealthFactor, HealthMeter, Icon, NumberTicker, Row} from "@/components/ui";
import {ReviewSheet} from "@/components/review/ReviewSheet";
import {NeedFunds, WalletGate} from "./WalletGate";

const liqText = (x?: bigint) => (x === undefined || x === 0n ? "–" : `$${num(Number(formatUnits(x, 8)), 2)}`);

/** Borrow and Short tabs (one flow; the mode is the tab). Collateral, target health, amount, live risk preview. */
export function BorrowForm({f, price, available}: {f: BorrowFlow; price?: number; available?: number}) {
  const [review, setReview] = useState(false);
  const {symbol, pv, st} = f;
  // The flow clears its inputs on success, which clears the preview: the open sheet keeps the last one.
  const lastPv = useRef(pv);
  if (pv) lastPv.current = pv;
  const sheetPv = pv ?? lastPv.current;
  // Existing position's health factor, so the meter shows before → after.
  const before = useMemo(() => (st?.user && st.user.borrowShares > 0n ? preview(st, {collateralIn: 0n, borrowAmount: 0n}).hfNow : undefined), [st]);
  const hfTone = f.targetHf >= 1.5 ? "text-success" : f.targetHf >= 1.1 ? "text-caution" : "text-danger";
  return (
    <div className="space-y-4">
      {f.tripped && <GuardBanner reasons={f.guardReasons} />}
      <p className="text-[13.5px] leading-snug text-muted">
        {f.mode === "short"
          ? `Borrow ${symbol} and sell it for USDG in one step. You profit if the price falls; you lose if it rises.`
          : `Borrow ${symbol} to hold, hedge or use elsewhere. You repay the stock itself.`}
      </p>

      <div className="space-y-1.5">
        <span className="text-[13px] font-medium text-dim">Collateral asset</span>
        <div className="flex gap-2" role="radiogroup" aria-label="Collateral asset">
          <button type="button" role="radio" aria-checked className="pressable inline-flex h-8 items-center gap-1.5 rounded-full bg-raised px-3 text-[13px] shadow-[inset_0_0_0_1px_var(--border-strong)]">
            <Icon name="check" size={13} className="text-success" /> USDG
          </button>
          <button type="button" role="radio" aria-checked={false} disabled className="inline-flex h-8 items-center rounded-full px-3 text-[13px] text-muted shadow-[inset_0_0_0_1px_var(--border)] disabled:opacity-60" title="Yield-earning USDG vault shares as collateral come later">
            USDG vault share · coming later
          </button>
        </div>
      </div>

      <NeedFunds token="USDG" show={f.u?.usdgBalance === 0n} />
      <AmountInput label="Collateral" value={f.collateral} onChange={f.setCollateral} decimals={6} unit="USDG" max={f.u?.usdgBalance} maxLabel="Wallet balance" usdPrice={1} testId="collateral" disabled={!f.address} />

      <div className="space-y-1.5">
        <label htmlFor="target" className="flex items-baseline justify-between text-[13px] font-medium text-dim">
          <span>Safety target (health factor in 24 h)</span>
          <span className={cn("num text-[15px]", hfTone)}>{f.targetHf.toFixed(2)}</span>
        </label>
        <input id="target" type="range" min={1.1} max={3} step={0.05} value={f.targetHf} onChange={(e) => f.applyTarget(Number(e.target.value))} className="w-full" aria-describedby="target-hint" data-testid="target-hf" disabled={!f.address} />
        <p id="target-hint" className="text-[12.5px] text-muted">
          Sets the amount for your collateral. Higher is safer. Opening needs at least 1.10, including the next weekend or earnings buffer.
        </p>
      </div>

      <AmountInput
        label={f.mode === "short" ? "Amount to short" : "Amount to borrow"}
        value={f.amount}
        onChange={f.setAmount}
        decimals={18}
        unit={symbol}
        usdPrice={price}
        testId="borrow-amount"
        disabled={!f.address}
        hint={available !== undefined ? `${num(available, 2)} ${symbol} available to borrow` : undefined}
      />
      {f.mode === "short" && (
        <label className="flex items-start gap-2.5 text-[13.5px] text-dim">
          <input type="checkbox" className="mt-0.5 size-4" checked={f.compound} onChange={(e) => f.setCompound(e.target.checked)} /> Add the sale proceeds to my collateral (safer: raises the health factor)
        </label>
      )}

      {pv && st && (
        <section className="space-y-3 rounded-sm bg-sunken p-4 shadow-[inset_0_0_0_1px_var(--border)]" aria-label="Live risk">
          <HealthMeter hf={before} next={pv.hfNow} />
          {f.requirement && (
            <div className="flex items-baseline justify-between gap-3 text-[13.5px]">
              <span className="text-muted">Collateral required to open</span>
              <span className="text-right">
                <NumberTicker value={Number(formatUnits(f.requirement.required, 6))} format="num" suffix=" USDG" className="font-medium text-fg" />
                {f.requirement.buffer > 0n && <span className="block text-[12px] text-weekend">incl. {num(Number(formatUnits(f.requirement.buffer, 6)))} USDG weekend buffer</span>}
              </span>
            </div>
          )}
        </section>
      )}

      {pv && st ? <PreviewDetails p={pv} symbol={symbol} now={Number(st.now)} mode={f.mode} /> : <p className="text-[13px] text-muted">Enter collateral and an amount to see your health factor and liquidation price.</p>}

      <WalletGate>
        <Button size="lg" variant="borrow" className="w-full" disabled={f.disabled} onClick={() => setReview(true)} data-testid="submit">
          {f.mode === "short" ? `Review short` : `Review borrow`}
        </Button>
        {f.blocker && f.address && !f.steps.busy && <p className="mt-2 text-[12.5px] text-muted">{f.blocker}</p>}
      </WalletGate>

      {sheetPv && (
        <ReviewSheet
          open={review}
          onOpenChange={setReview}
          title={f.mode === "short" ? `Review short` : `Review borrow`}
          confirmLabel={`${f.verb} ${f.amount} ${symbol}`}
          successTitle={`${f.mode === "short" ? "Shorted" : "Borrowed"} ${f.amount} ${symbol}`}
          successBody="Watch its health factor in your portfolio. Add collateral before weekends if it gets close to 1.10."
          requireLiquidationPrice
          risk={{pv: sheetPv, hfBefore: before, requirement: f.requirement, symbol}}
          summary={
            <>
              <Row label={f.mode === "short" ? "You short" : "You borrow"} value={`${wad(sheetPv.borrowed, 4)} ${symbol} ($${num(sheetPv.borrowedUsd)})`} emphasis />
              <Row label="Collateral" value={`${num(Number(formatUnits(sheetPv.collateral, 6)))} USDG`} />
              {sheetPv.swap && <Row label="You receive (min)" value={`${num(Number(formatUnits(sheetPv.swap.minOut, 6)))} USDG · ${pct(sheetPv.swap.priceImpact)} price impact`} />}
            </>
          }
          plan={f.plan}
          steps={f.steps.states}
          busy={f.steps.busy}
          error={f.steps.error}
          blocker={f.disabled && !f.steps.busy ? f.blocker : undefined}
          onConfirm={f.confirm}
        />
      )}
    </div>
  );
}

/** 06 §Preview panel, computed by @stockline/sdk. Test ids and data-wad values are read by the e2e suite. */
function PreviewDetails({p, symbol, now, mode}: {p: Preview; symbol: string; now: number; mode: "short" | "borrow"}) {
  return (
    <section aria-labelledby="pv" data-testid="preview" className="space-y-2">
      <h3 id="pv" className="text-[13px] font-medium text-dim">
        Preview
      </h3>
      <dl className="divide-y divide-line">
        <Row label="Borrowed" value={`${wad(p.borrowed, 4)} ${symbol} ($${num(p.borrowedUsd)})`} testId="pv-borrowed" raw={p.borrowed} />
        <Row label="Borrow APR (variable)" value={`${pct(p.borrowAprNow, 2, true)} now · ${pct(p.borrowAprPlus10, 2, true)} at +10% util.`} />
        <Row label="Health factor now" value={<HealthFactor hf={p.hfNow} />} testId="pv-hf-now" />
        {p.closure && <Row label="…at the next close (full buffer)" value={<HealthFactor hf={p.hfAtClose} />} testId="pv-hf-close" />}
        <Row label="…if the price rises 10%" value={<HealthFactor hf={p.hfPlus10} />} testId="pv-hf-plus10" />
        <Row label="Liquidation price now" value={<span className="text-fg">{liqText(p.liqPriceNow)}</span>} testId="pv-liq-now" raw={p.liqPriceNow} emphasis />
        {p.closure && <Row label="…during the next closure" value={liqText(p.liqPriceAtClose)} testId="pv-liq-close" />}
        {p.swap && <Row label="You receive (min)" value={`${num(Number(formatUnits(p.swap.usdgOut, 6)))} USDG (min ${num(Number(formatUnits(p.swap.minOut, 6)))})`} testId="pv-swap" />}
        {p.swap && <Row label="Price impact" value={pct(p.swap.priceImpact)} />}
      </dl>
      {p.closure && (
        <p className="flex gap-2 text-[12.5px] text-muted" data-testid="pv-countdown">
          <Icon name="moon" size={14} className="mt-0.5 shrink-0 text-weekend" />
          <span>
            {p.closure.open
              ? p.closure.rampStartTs > now
                ? `Weekend mode starts ramping ${et(p.closure.rampStartTs)} (in ${until(p.closure.rampStartTs, now)}). Buffer at close: ${pct(p.closure.bufferAtClose, 1, true)}.`
                : `Weekend buffer is ramping now; full ${pct(p.closure.bufferAtClose, 1, true)} at ${et(p.closure.closeTs)}.`
              : `Weekend mode is active until the first price after ${et(p.closure.reopenTs || p.closure.closeTs)}.`}
          </span>
        </p>
      )}
      {p.event && <p className="text-[12.5px] text-muted">Earnings buffer {pct(p.event.bufferWad, 0, true)} in force by {new Date(Number(p.event.startTs) * 1000).toUTCString().slice(0, 22)} UTC.</p>}
      {!p.opensOk && (
        <p role="alert" className="text-[13px] text-danger">
          The router will refuse this: the health factor 24 hours from now would be {num(Number(p.hfHorizon) / Number(WAD))}, below 1.10. Add collateral or borrow less.
        </p>
      )}
      <p className="text-[12.5px] text-muted">
        Liquidation happens at a health factor of 1.00. You owe the stock itself: if {symbol} pays a dividend, it is added through the token&apos;s multiplier (currently {num(Number(formatUnits(p.multiplier, 18)), 6)}), so borrowers pay manufactured dividends to lenders.
        {mode === "short" ? " A short loses if the price rises." : ""}
      </p>
    </section>
  );
}
