"use client";
import {useState} from "react";
import type {BackstopData} from "@/lib/fixtures";
import {countdown} from "@/lib/session";
import {num, pct, usd} from "@/lib/format";
import {Address, AmountInput, Badge, Button, Icon, Notice, ProgressBar, Segmented, Stat} from "@/components/ui";

/**
 * 09 §2 `/backstop`: stake USDG as first-loss capital. APY, coverage vs target, cooldown, past payouts, risks.
 * Phase 5 and behind NEXT_PUBLIC_FEATURE_BACKSTOP: preview data, actions disabled.
 */
export function BackstopView({b, now}: {b: BackstopData; now: number}) {
  const [mode, setMode] = useState<"stake" | "unstake">("stake");
  const [amount, setAmount] = useState("");
  const coverage = b.poolAssets / b.borrowedUsd;
  const cooldownTs = b.user?.cooldownEndsAt ? Date.parse(b.user.cooldownEndsAt) / 1000 : undefined;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="max-w-2xl">
          <div className="flex items-center gap-3">
            <h1 className="t-display">Backstop</h1>
            <Badge tone="weekend" icon="clock">
              Preview · Phase 5
            </Badge>
          </div>
          <p className="mt-2 text-[15px] text-muted">Stake USDG to protect lenders. If a liquidation leaves bad debt, the backstop covers it first. In return, stakers earn a share of every borrow fee.</p>
        </div>
        <dl className="flex gap-8">
          <Stat label="Staking APY (variable)" size="lg" tone="supply" value={pct(b.apy)} hint="From the backstop fee share" />
          <Stat label="Pool" size="lg" value={usd(b.poolAssets, 0)} />
        </dl>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_400px] lg:items-start">
        <div className="min-w-0 space-y-6">
          <section className="panel p-5" aria-labelledby="cov-h">
            <h2 id="cov-h" className="t-title">
              Coverage
            </h2>
            <dl className="mt-4 grid gap-5 sm:grid-cols-3">
              <Stat size="sm" label="Pool vs borrowed" value={pct(coverage, 1)} hint={`Target ${pct(b.targetRatio, 0)} of ${usd(b.borrowedUsd, 0)} borrowed`} />
              <Stat size="sm" label="Largest single cover" value={usd(b.poolAssets * b.coverCap, 0)} hint={`${pct(b.coverCap, 0)} of the pool per event`} />
              <Stat size="sm" label="Withdrawal cooldown" value={`${b.cooldownDays} days`} hint="So stakers can't leave ahead of a known loss" />
            </dl>
            <div className="mt-4">
              <p className="t-label mb-1.5">Progress to target</p>
              <ProgressBar value={coverage / b.targetRatio} label="Coverage progress to target" />
            </div>
            {coverage < b.targetRatio && <p className="mt-3 text-[13px] text-muted">Below target, the backstop&apos;s fee share rises to 7.5% (lenders keep 87.5%) until it catches up.</p>}
          </section>

          <section className="panel p-5" aria-labelledby="pay-h">
            <h2 id="pay-h" className="t-title">
              Past payouts
            </h2>
            {b.payouts.length === 0 ? (
              <p className="mt-3 text-[14px] text-muted">No bad debt has been covered yet.</p>
            ) : (
              <ul className="mt-3 divide-y divide-line">
                {b.payouts.map((p) => (
                  <li key={p.tx} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3 text-[14px]">
                    <Badge tone="danger">Covered</Badge>
                    <span className="num">{usd(p.amount)}</span>
                    <span className="text-muted">{p.symbol} bad debt</span>
                    <span className="ml-auto text-[13px] text-muted">{new Date(p.time).toUTCString().slice(5, 16)}</span>
                    <Address address={p.tx} kind="tx" />
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="panel p-5" aria-labelledby="brisk-h">
            <h2 id="brisk-h" className="t-title">
              Risks in plain words
            </h2>
            <ul className="mt-3 space-y-3 text-[14px] leading-relaxed text-dim">
              <li className="flex gap-2.5"><Icon name="alert" size={16} className="mt-1 shrink-0 text-danger" />You can lose part of your stake: bad debt is paid from the pool before lenders lose anything.</li>
              <li className="flex gap-2.5"><Icon name="alert" size={16} className="mt-1 shrink-0 text-caution" />One cover uses at most {pct(b.coverCap, 0)} of the pool. Larger losses are shared with lenders pro rata.</li>
              <li className="flex gap-2.5"><Icon name="clock" size={16} className="mt-1 shrink-0 text-accent-text" />Unstaking takes {b.cooldownDays} days. Your stake keeps covering losses during the cooldown.</li>
            </ul>
          </section>
        </div>

        <aside className="panel space-y-4 p-5 lg:sticky lg:top-[126px]" aria-label="Stake or unstake">
          <Segmented
            label="Stake or unstake"
            value={mode}
            onChange={setMode}
            options={[
              {value: "stake", label: "Stake"},
              {value: "unstake", label: "Unstake"},
            ]}
          />
          <AmountInput label={mode === "stake" ? "Amount to stake" : "Amount to unstake"} value={amount} onChange={setAmount} decimals={6} unit="USDG" usdPrice={1} />
          {mode === "unstake" && <p className="text-[13px] text-muted">Starts a {b.cooldownDays}-day cooldown. You can withdraw when it ends.</p>}
          <Button size="lg" className="w-full" disabled title="The backstop launches in Phase 5">
            {mode === "stake" ? "Stake" : "Start cooldown"} · opens in Phase 5
          </Button>
          {b.user && (
            <dl className="space-y-3 border-t border-line pt-4">
              <Stat size="sm" label="Your stake" value={`${num(b.user.staked)} USDG`} />
              <Stat size="sm" label="Earned" tone="supply" value={`${num(b.user.earned)} USDG`} hint="Paid from the backstop fee share" />
              {cooldownTs && (
                <Notice tone="info" title={cooldownTs > now ? `Cooldown: ${countdown(cooldownTs, now)} left` : "Cooldown finished"}>
                  {cooldownTs > now ? "Your stake still covers losses until then." : "You can withdraw your stake now."}
                </Notice>
              )}
            </dl>
          )}
        </aside>
      </div>
    </div>
  );
}
