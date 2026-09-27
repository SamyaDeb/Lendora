import {formatUnits} from "viem";
import {WAD} from "@stockline/sdk";
import type {Preview} from "@/lib/preview";
import {et, num, pct, until, wad} from "@/lib/format";
import {HealthFactor} from "./ui";

/** 06 §Preview panel: everything shown before signing, computed by @stockline/sdk. */
export function PreviewPanel({p, symbol, now, mode}: {p: Preview; symbol: string; now: number; mode: "short" | "borrow"}) {
  const liq = (x?: bigint) => (x === undefined || x === 0n ? "–" : `$${num(Number(formatUnits(x, 8)), 2)}`);
  const row = (label: string, value: React.ReactNode, testId?: string, raw?: bigint) => (
    <div className="flex justify-between gap-3 py-1" data-testid={testId} data-wad={raw?.toString()}>
      <dt className="text-[var(--color-muted)]">{label}</dt>
      <dd className="num text-right font-medium">{value}</dd>
    </div>
  );
  return (
    <section className="card p-4" aria-labelledby="pv" data-testid="preview">
      <h2 id="pv" className="mb-2 font-semibold">
        Preview
      </h2>
      <dl className="divide-y divide-[var(--color-line)] text-sm">
        {row("Borrowed", `${wad(p.borrowed, 4)} ${symbol} ($${num(p.borrowedUsd)})`, "pv-borrowed", p.borrowed)}
        {row("Borrow APR (variable)", `${pct(p.borrowAprNow, 2, true)} now · ${pct(p.borrowAprPlus10, 2, true)} at +10% utilization`)}
        {row("Health factor now", <HealthFactor hf={p.hfNow} />, "pv-hf-now")}
        {p.closure && row("…at the next close (full buffer)", <HealthFactor hf={p.hfAtClose} />, "pv-hf-close")}
        {row("…if the price rises 10%", <HealthFactor hf={p.hfPlus10} />, "pv-hf-plus10")}
        {row("Liquidation price now", liq(p.liqPriceNow), "pv-liq-now", p.liqPriceNow)}
        {p.closure && row("…during the next closure", liq(p.liqPriceAtClose), "pv-liq-close")}
        {p.swap && row("You receive (min)", `${num(Number(formatUnits(p.swap.usdgOut, 6)))} USDG (min ${num(Number(formatUnits(p.swap.minOut, 6)))})`, "pv-swap")}
        {p.swap && row("Price impact", pct(p.swap.priceImpact))}
      </dl>
      {p.closure && (
        <p className="mt-3 text-sm" data-testid="pv-countdown">
          {p.closure.open
            ? p.closure.rampStartTs > now
              ? `Weekend mode starts ramping ${et(p.closure.rampStartTs)} (in ${until(p.closure.rampStartTs, now)}). Buffer at close: ${pct(p.closure.bufferAtClose, 1, true)}.`
              : `Weekend buffer is ramping now; full ${pct(p.closure.bufferAtClose, 1, true)} at ${et(p.closure.closeTs)}.`
            : `Weekend mode is active until the first price after ${et(p.closure.reopenTs || p.closure.closeTs)}.`}
        </p>
      )}
      {p.event && <p className="mt-1 text-sm">Earnings buffer {pct(p.event.bufferWad, 0, true)} in force by {new Date(Number(p.event.startTs) * 1000).toUTCString().slice(0, 22)} UTC.</p>}
      {!p.opensOk && (
        <p role="alert" className="mt-2 text-sm text-[var(--color-danger)]">
          The router will refuse this: the health factor 24 hours from now would be {num(Number(p.hfHorizon) / Number(WAD))}, below 1.10. Add collateral or borrow less.
        </p>
      )}
      <p className="mt-3 text-xs text-[var(--color-muted)]">
        Liquidation happens at a health factor of 1.00. You owe the stock itself: if {symbol} pays a dividend, it is added through the token&apos;s multiplier (currently{" "}
        {num(Number(formatUnits(p.multiplier, 18)), 6)}), so borrowers pay manufactured dividends to lenders.{mode === "short" ? " A short loses if the price rises." : ""}
      </p>
    </section>
  );
}
