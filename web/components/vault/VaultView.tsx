"use client";
import {useState} from "react";
import {splitFor, type VaultOverview, type VaultUser} from "@/lib/vault";
import {et, num, pct, usd} from "@/lib/format";
import {cn} from "@/lib/cn";
import {AmountInput, AssetIcon, Badge, Button, Icon, Notice, Segmented, StackBar, Stat, UtilBar} from "@/components/ui";

/**
 * 08 `/vault`: the delta-neutral USDG vault. Deposit / withdraw, where the yield comes from (lending fees vs perp
 * funding), what the vault holds, hedge status and the risks in plain words. Phase 4: no contracts yet, so this runs
 * on labelled preview data and the actions are disabled.
 */
export function VaultView({v, user}: {v: VaultOverview; user?: VaultUser}) {
  const weekend = v.marketClosed;
  const split = splitFor(v, "30d");
  const [mode, setMode] = useState<"deposit" | "withdraw">("deposit");
  const [amount, setAmount] = useState("");
  const netDelta = Math.max(0, ...v.sleeves.map((s) => Math.abs(s.delta)));
  const minMargin = Math.min(...v.sleeves.map((s) => s.marginRatio));
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="max-w-2xl">
          <div className="flex items-center gap-3">
            <h1 className="t-display">USDG vault</h1>
            <Badge tone="weekend" icon="clock">
              Preview · Phase 4
            </Badge>
          </div>
          <p className="mt-2 text-[15px] text-muted">
            Deposit USDG. The vault buys Stock Tokens, lends most of them to Lendora borrowers and shorts the same amount on a perp venue, so the stock price barely moves your balance. You earn lending fees plus perp funding, in USDG.
          </p>
        </div>
        <dl className="flex gap-8">
          <Stat label="Net APY (variable, 30d)" size="lg" tone="supply" value={pct(v.apy.d30)} />
          <Stat label="Deposits" size="lg" value={usd(v.tvl, 0)} hint={`of ${usd(v.cap, 0)} cap`} />
          <Stat label="Share price" size="lg" value={`${num(v.sharePrice, 4)}`} hint="USDG per share" />
        </dl>
      </div>

      <Notice tone="info" title="This vault hasn't launched">
        The numbers on this page are illustrative. Depositing opens after the simulation gate, the audits and a 30-day test run (08).
      </Notice>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_400px] lg:items-start">
        <div className="min-w-0 space-y-6">
          <section className="panel p-5" aria-labelledby="yield-h">
            <h2 id="yield-h" className="t-title">
              Where the yield comes from
            </h2>
            <p className="mt-1 text-[13.5px] text-muted">Annualized, last 30 days, net of trading and rebalancing costs. Before the 10% performance fee.</p>
            <div className="mt-5">
              <StackBar
                label="Yield split"
                items={[
                  {label: "Lending fees", value: split.lending, color: "var(--supply)", note: "Paid by borrowers of the Stock Tokens the vault lends (90% of spot)"},
                  {label: "Perp funding", value: split.funding, color: "var(--accent-text)", note: "Paid by perp longs to the vault's short hedge; can turn negative"},
                  {label: "Cash buffer", value: split.buffer, color: "var(--violet-200)", note: "USDG yield on the 5% kept for withdrawals"},
                  {label: "Costs", value: split.costs, color: "var(--danger)", note: "Swaps, rebalancing and venue fees"},
                ]}
              />
            </div>
          </section>

          <section className="panel p-5" aria-labelledby="alloc-h">
            <h2 id="alloc-h" className="t-title">
              What the vault holds
            </h2>
            <div className="mt-5">
              <StackBar
                label="Allocation"
                items={[
                  {label: "Stocks lent (rSTOCK)", value: v.allocation.lent, color: "var(--supply)", note: "Earning lending fees"},
                  {label: "Stocks held", value: v.allocation.held, color: "var(--violet-400)", note: "Kept wrapped for fast unwinds"},
                  {label: "Perp hedge margin", value: v.allocation.perpMargin, color: "var(--borrow)", note: `On ${v.venue.name}`},
                  {label: "Cash buffer", value: v.allocation.cash, color: "var(--violet-200)", note: "Pays instant withdrawals"},
                ]}
              />
            </div>
            <ul className="mt-5 divide-y divide-line border-t border-line">
              {v.sleeves.map((s) => (
                <li key={s.symbol} className="flex flex-wrap items-center gap-x-5 gap-y-2 py-3 text-[14px]">
                  <span className="flex w-28 items-center gap-2.5">
                    <AssetIcon ticker={s.symbol} size="sm" />
                    {s.symbol}
                  </span>
                  <span className="text-muted">
                    Weight <span className="num text-fg">{pct(s.weight, 0)}</span>
                  </span>
                  <span className="text-muted">
                    Net delta <span className={cn("num", Math.abs(s.delta) > v.bandPct * 0.75 ? "text-caution" : "text-fg")}>{s.delta >= 0 ? "+" : ""}{pct(s.delta, 1)}</span>
                  </span>
                  <span className="text-muted">
                    Margin <span className={cn("num", s.marginRatio < v.marginTarget * 1.2 ? "text-caution" : "text-fg")}>{num(s.marginRatio, 1)}×</span>
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <section className="panel p-5" aria-labelledby="hedge-h">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 id="hedge-h" className="t-title">
                Hedge status
              </h2>
              <Badge tone={netDelta <= v.bandPct ? "success" : "caution"} icon={netDelta <= v.bandPct ? "check" : "alert"}>
                {netDelta <= v.bandPct ? "Hedged within the band" : "Rebalancing"}
              </Badge>
            </div>
            <dl className="mt-4 grid gap-5 sm:grid-cols-3">
              <Stat size="sm" label="Largest net delta" value={pct(netDelta, 1)} hint={`Band: ±${pct(v.bandPct, 0)} of each sleeve`} />
              <Stat size="sm" label="Lowest margin ratio" value={`${num(minMargin, 1)}×`} hint={`Target ≥ ${v.marginTarget}× maintenance${weekend ? " (3× while closed)" : ""}`} />
              <Stat size="sm" label="Last rebalance" value={et(Date.parse(v.lastRebalance) / 1000)} hint="At least once per US session" />
            </dl>
            <div className="mt-4">
              <p className="t-label mb-1.5">Delta used of the band</p>
              <UtilBar value={netDelta / v.bandPct} cap={1} />
            </div>
          </section>

          <section className="panel p-5" aria-labelledby="vrisk-h">
            <h2 id="vrisk-h" className="t-title">
              Risks in plain words
            </h2>
            <ul className="mt-3 space-y-3 text-[14px] leading-relaxed text-dim">
              <li className="flex gap-2.5"><Icon name="alert" size={16} className="mt-1 shrink-0 text-caution" />Funding can turn negative. If it stays below the lending APY for 72 hours, the sleeve unwinds to USDG.</li>
              <li className="flex gap-2.5"><Icon name="alert" size={16} className="mt-1 shrink-0 text-caution" />The perp venue is a single point of failure: if it halts withdrawals, the hedge margin (about {pct(v.allocation.perpMargin, 0)} of the vault) is at risk.</li>
              <li className="flex gap-2.5"><Icon name="moon" size={16} className="mt-1 shrink-0 text-weekend" />On weekends perps keep trading while the stock price is frozen. The vault keeps extra margin and doesn&apos;t trade spot until markets reopen.</li>
              <li className="flex gap-2.5"><Icon name="clock" size={16} className="mt-1 shrink-0 text-accent-text" />Large withdrawals are queued: paid within 72 hours or at the next US market open, whichever is later.</li>
            </ul>
          </section>
        </div>

        <aside className="panel space-y-4 p-5 lg:sticky lg:top-[126px]" aria-label="Deposit or withdraw">
          <Segmented
            label="Deposit or withdraw"
            value={mode}
            onChange={setMode}
            options={[
              {value: "deposit", label: "Deposit"},
              {value: "withdraw", label: "Withdraw"},
            ]}
          />
          <AmountInput label={mode === "deposit" ? "Amount to deposit" : "Amount to withdraw"} value={amount} onChange={setAmount} decimals={6} unit="USDG" usdPrice={1} max={mode === "withdraw" && user ? BigInt(Math.round(user.value * 1e6)) : undefined} maxLabel="Your balance" />
          {mode === "withdraw" && <p className="text-[13px] text-muted">Instant up to the cash buffer ({usd(v.instantCapacity, 0)} now). More is queued until the next settlement.</p>}
          {weekend && <Notice tone="weekend">Deposits and withdrawals pause while markets are closed if the perp price data is stale.</Notice>}
          <Button size="lg" className="w-full" disabled title="The vault launches in Phase 4">
            {mode === "deposit" ? "Deposit" : "Withdraw"} · opens in Phase 4
          </Button>
          {user && (
            <dl className="space-y-3 border-t border-line pt-4">
              <Stat size="sm" label="Your vault balance" value={`${num(user.value)} USDG`} hint={`${num(user.shares, 2)} shares`} />
            </dl>
          )}
        </aside>
      </div>
    </div>
  );
}
