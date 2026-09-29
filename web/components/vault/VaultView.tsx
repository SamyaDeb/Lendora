"use client";
import {useEffect, useState, type ReactNode} from "react";
import {AnimatePresence, motion} from "motion/react";
import {earnings, hedgeStatus, PAUSE_COPY, splitFor, type VaultOverview, type VaultUser, type VaultWindow, type WithdrawRequest} from "@/lib/vault";
import {et, num, pct, usd} from "@/lib/format";
import {cn} from "@/lib/cn";
import {Address, ApyHero, AssetIcon, Badge, Button, EmptyState, Icon, Notice, NumberTicker, ProgressBar, Segmented, Skeleton, StackBar, Stat, UtilBar, useMediaQuery, YieldSplitBar} from "@/components/ui";
import {LineChart} from "@/components/charts/LineChart";
import {WithdrawRequestCard} from "./WithdrawRequestCard";

export type PanelMode = "deposit" | "withdraw";

export interface VaultViewProps {
  o?: VaultOverview;
  u?: VaultUser;
  /** A wallet is connected (or pinned by a preview). */
  connected: boolean;
  error?: boolean;
  onRetry?: () => void;
  /** The data comes from fixtures (shows the "Preview" badge). */
  fixture?: boolean;
  /** When the overview was fetched (ms), for chain-time countdowns. */
  fetchedAt?: number;
  /** The mobile bar opens the panel in this mode. */
  onMode: (m: PanelMode) => void;
  /** The deposit / withdraw panel (the container builds it from the flows). */
  panel: ReactNode;
  onClaim?: (r: WithdrawRequest) => void;
  claimBusy?: boolean;
}

const SOURCES = [
  {key: "lending", label: "Lending fees", color: "var(--supply)", text: "Paid by the borrowers of the Stock Tokens the vault lends on Lendora (about 90% of what it holds). Rises with utilization."},
  {key: "funding", label: "Perp funding", color: "var(--accent-text)", text: "Paid by perp longs to the vault's short hedge while longs outnumber shorts. It can turn negative; if it stays below the lending APY for 72 hours, that stock's sleeve moves to USDG."},
  {key: "buffer", label: "Cash buffer", color: "var(--violet-200)", text: "USDG yield on the 5% kept in cash for instant withdrawals and rebalancing."},
  {key: "costs", label: "Costs", color: "var(--danger)", text: "Swaps, rebalancing and venue fees, and the performance fee: 10% of gains above your previous high. No management fee."},
] as const;

/**
 * 08 `/vault` (USDG Earn): what you earn and why, your position, the history, how it works, the risks and how the
 * vault is run, with the deposit / withdraw panel beside it (a bottom sheet on mobile). Props only.
 */
export function VaultView({o, u, connected, error, onRetry, fixture, fetchedAt, onMode, panel, onClaim, claimBusy}: VaultViewProps) {
  const [win, setWin] = useState<VaultWindow>("30d");
  const desktop = useMediaQuery("(min-width: 1024px)");
  const [sheet, setSheet] = useState(false);
  const openSheet = (m: PanelMode) => (onMode(m), setSheet(true));
  useEffect(() => {
    if (desktop) setSheet(false);
  }, [desktop]);
  useEffect(() => {
    if (!sheet) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setSheet(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sheet]);

  const open = u ? u.requests.filter((r) => r.status !== "claimed") : [];
  const showStrip = connected && u && (u.shares > 0 || open.length > 0);

  return (
    <div className="space-y-6 pb-24 lg:pb-0" data-testid="vault">
      <header className="max-w-3xl">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="t-display">USDG Earn</h1>
          {fixture && (
            <Badge tone="weekend" icon="info" data-testid="preview-badge">
              Preview
            </Badge>
          )}
        </div>
        <p className="mt-2 text-[15px] text-muted">Earn lending fees and perp funding on USDG, hedged so stock prices barely move your balance.</p>
      </header>

      {o ? <StateNotices o={o} /> : null}

      {error && !o ? (
        <EmptyState title="Vault data didn't load" tone="danger" icon="alert" action={onRetry && <Button variant="secondary" onClick={onRetry}>Try again</Button>}>
          The vault&apos;s data source didn&apos;t respond. Nothing about your balance has changed; withdrawals and claims work again as soon as it does.
        </EmptyState>
      ) : !o ? (
        <VaultSkeleton />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_400px] lg:items-start">
          <div className="min-w-0 space-y-6">
            <section className="panel grid gap-6 p-5 md:grid-cols-2 md:gap-8" aria-label="Net APY and where it comes from">
              <ApyHero apy={o.apy} series={o.apySeries.slice(-90).map((p) => p.v)} window={win} onWindow={setWin} />
              <YieldSplitBar split={splitFor(o, win)} label={`Yield split, ${win}`} />
              <dl className="grid grid-cols-2 gap-x-6 gap-y-5 border-t border-line pt-5 sm:grid-cols-3 md:col-span-2">
                <Stat label="Deposits" value={<NumberTicker value={o.tvl} format="usdCompact" />} hint={o.cap > 0 ? <span className="mt-1 block space-y-1"><span className="block">of {usd(o.cap, 0)} cap</span><ProgressBar value={o.tvl / o.cap} label="Deposits used of the cap" /></span> : "Cap opens at launch"} testId="tvl" />
                <Stat label="Share price" value={`${num(o.sharePrice, 4)}`} hint="USDG per share" testId="share-price" />
                <Stat label="Instant liquidity now" value={usd(o.instantCapacity, 0)} hint="Paid at once; more is queued" className="col-span-2 sm:col-span-1" testId="instant-capacity" />
              </dl>
            </section>

            {showStrip && u && <PositionStrip o={o} u={u} open={open} fetchedAt={fetchedAt} onClaim={onClaim} claimBusy={claimBusy} />}

            <Performance o={o} />

            <div className="grid gap-6 md:grid-cols-2">
              <section className="panel p-5" aria-labelledby="sources-h">
                <h2 id="sources-h" className="t-title">
                  Where the yield comes from
                </h2>
                <p className="mt-1 text-[13px] text-muted">Annualized over the last {win}, historical and variable.</p>
                <ul className="mt-4 space-y-4">
                  {SOURCES.map((s) => {
                    const v = splitFor(o, win)[s.key];
                    return (
                      <li key={s.key} className="flex gap-3">
                        <span className="mt-1.5 size-2.5 shrink-0 rounded-[3px]" style={{background: s.color}} aria-hidden />
                        <div className="min-w-0">
                          <p className="flex flex-wrap justify-between gap-x-3 text-[14.5px] font-medium">
                            {s.label} <span className={cn("num", v < 0 && "text-danger")}>{`${v < 0 ? "−" : "+"}${pct(Math.abs(v))}`}</span>
                          </p>
                          <p className="mt-0.5 text-[13.5px] leading-relaxed text-muted">{s.text}</p>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
              <HowItWorks />
            </div>

            <Risks o={o} />
            <HowItsRun o={o} />
          </div>

          {/* One panel instance: sticky column on desktop, bottom sheet on mobile (test ids stay unique). */}
          <AnimatePresence>
            {sheet && !desktop && (
              <motion.div key="scrim" className="fixed inset-0 z-40 bg-[var(--scrim)] lg:hidden" initial={{opacity: 0}} animate={{opacity: 1}} exit={{opacity: 0}} transition={{duration: 0.2}} onClick={() => setSheet(false)} aria-hidden />
            )}
          </AnimatePresence>
          <aside
            aria-label="Deposit or withdraw"
            role={!desktop && sheet ? "dialog" : undefined}
            aria-modal={!desktop && sheet ? true : undefined}
            className={cn(
              "panel p-5",
              "lg:sticky lg:top-[126px] lg:max-h-[calc(100vh-146px)] lg:translate-y-0 lg:overflow-y-auto",
              "max-lg:fixed max-lg:inset-x-0 max-lg:bottom-0 max-lg:z-50 max-lg:max-h-[90dvh] max-lg:overflow-y-auto max-lg:rounded-b-none max-lg:rounded-t-[var(--r-lg)] max-lg:pb-[max(1.25rem,env(safe-area-inset-bottom))] max-lg:shadow-[var(--shadow-pop),inset_0_0_0_1px_var(--border-strong)]",
              "max-lg:transition-[transform,visibility] max-lg:duration-300 max-lg:ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none",
              sheet ? "max-lg:visible max-lg:translate-y-0" : "max-lg:invisible max-lg:translate-y-full",
            )}
            data-testid="vault-panel"
          >
            <div className="mb-3 flex items-center justify-between lg:hidden">
              <span className="mx-auto h-1 w-10 rounded-full bg-white/20" aria-hidden />
            </div>
            <button type="button" className="absolute right-4 top-4 grid size-11 place-items-center rounded-[8px] text-muted hover:bg-white/[0.06] hover:text-fg lg:hidden" onClick={() => setSheet(false)} aria-label="Close">
              <Icon name="close" size={18} />
            </button>
            {panel}
          </aside>
        </div>
      )}

      {/* Mobile action bar */}
      {o && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-[color-mix(in_srgb,var(--bg)_88%,transparent)] px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur-md lg:hidden">
          <div className="mx-auto flex max-w-lg gap-2">
            <Button variant="supply" size="lg" className="flex-1" onClick={() => openSheet("deposit")} data-testid="open-deposit">
              Deposit
            </Button>
            <Button variant="secondary" size="lg" className="flex-1" onClick={() => openSheet("withdraw")} data-testid="open-withdraw">
              Withdraw
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** One notice per vault state (each with its reason in words). */
export function StateNotices({o}: {o: VaultOverview}) {
  const perpShare = pct(o.allocation.perpMargin, 0);
  return (
    <div className="space-y-3 empty:hidden" data-testid="vault-notices">
      {o.pauseReason === "cap_zero" && (
        <Notice tone="info" title="This vault hasn't launched">
          {PAUSE_COPY.cap_zero} Until then the numbers on this page are illustrative.
        </Notice>
      )}
      {o.pauseReason === "cap_full" && <Notice tone="warn" title="Deposits are closed">{PAUSE_COPY.cap_full}</Notice>}
      {o.pauseReason === "paused" && <Notice tone="warn" title="Deposits are paused">{PAUSE_COPY.paused}</Notice>}
      {o.nav.stale && (
        <Notice tone="warn" title="Deposits and instant withdrawals are paused">
          {o.nav.ageSec === null
            ? "The vault hasn't published its first price report yet, so it can't price shares."
            : `The vault's perp price report is ${Math.round(o.nav.ageSec / 60)} minutes old${o.marketClosed ? " while markets are closed" : ""}, so it can't price shares.`}{" "}
          It never mints or burns on stale data. Withdrawal requests and claims of settled requests still work.
        </Notice>
      )}
      {o.venue.status === "halted" && (
        <Notice tone="danger" title={`${o.venue.name} has halted withdrawals`}>
          Queued withdrawals may take longer than 72 hours while the hedge margin (about {perpShare} of the vault) is stuck on the venue. The lent Stock Tokens and the cash buffer aren&apos;t affected. If the venue fails for good, that margin is what the vault can lose.
        </Notice>
      )}
      {o.killSwitch.map((k) => (
        <Notice key={k.symbol} tone="info" title={`The ${k.symbol} sleeve is in USDG`}>
          The {k.symbol} sleeve moved to USDG because funding stayed negative. Your balance isn&apos;t affected; the APY is lower.
        </Notice>
      ))}
      {o.marketClosed && !o.nav.stale && (
        <Notice tone="weekend" title="Markets are closed">
          Perps keep trading while Stock Token prices are frozen. The vault holds extra margin ({o.marginTargetClosed}× maintenance instead of {o.marginTarget}×) and doesn&apos;t trade stock until the open. Queued withdrawals settle after the next open.
        </Notice>
      )}
    </div>
  );
}

function PositionStrip({o, u, open, fetchedAt, onClaim, claimBusy}: {o: VaultOverview; u: VaultUser; open: VaultUser["requests"]; fetchedAt?: number; onClaim?: (r: WithdrawRequest) => void; claimBusy?: boolean}) {
  const earned = earnings(u);
  return (
    <section className="panel space-y-5 p-5" aria-labelledby="position-h" data-testid="position-strip">
      <h2 id="position-h" className="t-title">
        Your position
      </h2>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
        <Stat label="Value" size="lg" value={<NumberTicker value={u.value} format="num" suffix=" USDG" />} testId="position-value" />
        <Stat label="Earned" size="lg" tone={earned !== undefined ? "supply" : undefined} value={earned !== undefined ? `${earned < 0 ? "−" : "+"}${num(Math.abs(earned))} USDG` : "–"} hint={earned !== undefined ? "Value minus what you put in" : "Waiting for your deposits to be indexed"} testId="position-earned" />
        <Stat label="Shares" size="lg" value={num(u.shares, 4)} hint={`At ${num(o.sharePrice, 4)} USDG each`} className="col-span-2 sm:col-span-1" />
      </dl>
      {open.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-[13px] font-medium text-dim">Withdrawal requests</h3>
          <div className="grid gap-3 md:grid-cols-2">
            {open.map((r) => (
              <WithdrawRequestCard key={r.id} r={r} asOf={o.asOf.time} fetchedAt={fetchedAt} onClaim={onClaim} busy={claimBusy} />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

type Metric = "price" | "apy";
type Range = "30d" | "90d" | "1y";
const RANGE_DAYS: Record<Range, number> = {"30d": 30, "90d": 90, "1y": 365};

function Performance({o}: {o: VaultOverview}) {
  const [metric, setMetric] = useState<Metric>("price");
  const [range, setRange] = useState<Range>("90d");
  const src = metric === "price" ? o.sharePriceSeries : o.apySeries;
  const end = src.length ? src[src.length - 1].t : 0;
  const points = src.filter((p) => p.t >= end - RANGE_DAYS[range] * 86_400);
  return (
    <section className="space-y-3" aria-labelledby="perf-h">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="perf-h" className="t-title">
          Performance
        </h2>
        <div className="flex flex-wrap gap-2">
          <Segmented<Metric> label="Chart" value={metric} onChange={setMetric} testIdPrefix="chart-" options={[{value: "price", label: "Share price"}, {value: "apy", label: "APY"}]} />
          <Segmented<Range> label="Range" value={range} onChange={setRange} testIdPrefix="range-" options={[{value: "30d", label: "30d"}, {value: "90d", label: "90d"}, {value: "1y", label: "1y"}]} />
        </div>
      </div>
      <LineChart
        title={metric === "price" ? "Share price" : "Net APY, daily"}
        subtitle="Historical. Past returns don't predict future ones."
        a={metric === "price" ? {label: "USDG per share", points, color: "var(--supply)", zero: false, format: (v) => num(v, 4)} : {label: "Net APY", points, unit: "%", color: "var(--supply)"}}
      />
    </section>
  );
}

function HowItWorks() {
  return (
    <section className="panel p-5" aria-labelledby="how-h">
      <h2 id="how-h" className="t-title">
        How it works
      </h2>
      <FlowDiagram />
      <ol className="mt-4 space-y-3 text-[14px] leading-relaxed text-dim">
        {[
          "You deposit USDG and get vault shares.",
          "The vault buys Stock Tokens and lends about 90% of them on Lendora.",
          "It shorts the same amount on a perp venue, so price moves in the stock and the short cancel out. You earn the lending fees and the funding, in USDG.",
        ].map((t, i) => (
          <li key={i} className="flex gap-3">
            <span className="num grid size-6 shrink-0 place-items-center rounded-full bg-white/[0.06] text-[12.5px] font-medium text-fg shadow-[inset_0_0_0_1px_var(--border-strong)]">{i + 1}</span>
            {t}
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Deposit → stock (lent) + perp short → yield in USDG. Drawn from tokens; the text says the same thing. */
function FlowDiagram() {
  const box = "fill-[var(--surface-sunken)]";
  return (
    <svg viewBox="0 0 340 172" className="mt-4 h-auto w-full" role="img" aria-label="Your USDG buys Stock Tokens, 90% of which are lent on Lendora, and opens a perp short of the same size. Lending fees and funding come back as yield in USDG.">
      <defs>
        <marker id="vault-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0L8 4L0 8z" fill="var(--text-muted)" />
        </marker>
      </defs>
      <g fontFamily="inherit" fontSize="11.5" textAnchor="middle">
        <rect x="2" y="62" width="76" height="46" rx="10" className={box} stroke="var(--border-strong)" />
        <text x="40" y="82" fill="var(--text)">Your</text>
        <text x="40" y="97" fill="var(--text)">USDG</text>

        <rect x="124" y="10" width="112" height="52" rx="10" className={box} stroke="var(--supply)" />
        <text x="180" y="32" fill="var(--text)">Stock Tokens</text>
        <text x="180" y="49" fill="var(--text-muted)" fontSize="10.5">90% lent on Lendora</text>

        <rect x="124" y="110" width="112" height="52" rx="10" className={box} stroke="var(--borrow)" />
        <text x="180" y="132" fill="var(--text)">Perp short</text>
        <text x="180" y="149" fill="var(--text-muted)" fontSize="10.5">same amount</text>

        <text x="180" y="90" fill="var(--text-muted)" fontSize="10.5">price moves cancel</text>

        <rect x="276" y="62" width="62" height="46" rx="10" className={box} stroke="var(--supply)" />
        <text x="307" y="82" fill="var(--supply)">Yield</text>
        <text x="307" y="97" fill="var(--text)">in USDG</text>
      </g>
      <g fill="none" stroke="var(--text-muted)" strokeWidth="1.25" markerEnd="url(#vault-arrow)">
        <path d="M78 76 L122 40" />
        <path d="M78 94 L122 130" />
        <path d="M236 40 L274 74" />
        <path d="M236 130 L274 96" />
      </g>
      <g fontSize="10" fill="var(--text-muted)" fontFamily="inherit">
        <text x="258" y="46">fees</text>
        <text x="250" y="128">funding</text>
      </g>
    </svg>
  );
}

function Risk({icon, tone, children}: {icon: "alert" | "moon" | "clock" | "shield" | "info"; tone: string; children: ReactNode}) {
  return (
    <li className="flex gap-2.5">
      <Icon name={icon} size={16} className={cn("mt-1 shrink-0", tone)} />
      <span>{children}</span>
    </li>
  );
}

function Risks({o}: {o: VaultOverview}) {
  return (
    <section className="panel p-5" aria-labelledby="vrisk-h" data-testid="vault-risks">
      <h2 id="vrisk-h" className="t-title">
        Risks in plain words
      </h2>
      <ul className="mt-3 space-y-3 text-[14px] leading-relaxed text-dim">
        <Risk icon="alert" tone="text-caution">
          The yield is variable and can fall to zero or below. You can lose money; nothing here is insured.
        </Risk>
        <Risk icon="alert" tone="text-caution">
          Funding can turn negative. If it stays below the lending APY for 72 hours, that stock&apos;s sleeve unwinds to USDG.
        </Risk>
        <Risk icon="alert" tone="text-caution">
          The perp venue is a single point of failure: if it halts withdrawals, the hedge margin (about {pct(o.allocation.perpMargin, 0)} of the vault) is at risk.
        </Risk>
        <Risk icon="moon" tone="text-weekend">
          On weekends perps keep trading while the stock price is frozen. The vault keeps extra margin and doesn&apos;t trade stock until markets reopen.
        </Risk>
        <Risk icon="clock" tone="text-accent-text">
          Withdrawals are instant up to the cash buffer ({usd(o.instantCapacity, 0)} now). Larger amounts are queued and paid within 72 hours or at the next US market open, whichever is later.
        </Risk>
        <Risk icon="shield" tone="text-accent-text">
          The vault is new. Its contracts are audited separately from the lending markets, and audits reduce but don&apos;t remove smart contract risk.
        </Risk>
      </ul>
    </section>
  );
}

function HowItsRun({o}: {o: VaultOverview}) {
  const {maxDelta, minMargin} = hedgeStatus(o);
  const inBand = maxDelta <= o.bandPct;
  const target = o.marketClosed ? o.marginTargetClosed : o.marginTarget;
  return (
    <details className="panel group p-5" data-testid="how-its-run">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-[8px] [&::-webkit-details-marker]:hidden">
        <span>
          <span className="t-title block">How it&apos;s run</span>
          <span className="t-label mt-1 block">Holdings, hedge, sleeves, venue and contracts</span>
        </span>
        <span className="grid size-11 shrink-0 place-items-center rounded-[8px] text-muted group-hover:text-fg">
          <Icon name="chevronDown" size={18} className="transition-transform duration-200 group-open:rotate-180 motion-reduce:transition-none" />
        </span>
      </summary>
      <div className="mt-5 space-y-6">
        <div>
          <h3 className="mb-3 text-[14px] font-medium text-dim">What the vault holds</h3>
          <StackBar
            label="Holdings"
            items={[
              {label: "Stocks lent (rSTOCK)", value: o.allocation.lent, color: "var(--supply)", note: "Earning lending fees"},
              {label: "Stocks held", value: o.allocation.held, color: "var(--violet-400)", note: "Kept wrapped for fast unwinds"},
              {label: "Perp hedge margin", value: o.allocation.perpMargin, color: "var(--borrow)", note: `On ${o.venue.name}`},
              {label: "Cash buffer", value: o.allocation.cash, color: "var(--violet-200)", note: "Pays instant withdrawals"},
            ]}
          />
        </div>

        <div className="space-y-4 border-t border-line pt-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-[14px] font-medium text-dim">Hedge status</h3>
            <Badge tone={inBand ? "success" : "caution"} icon={inBand ? "check" : "alert"}>
              {inBand ? "Hedged within the band" : "Rebalancing"}
            </Badge>
          </div>
          <dl className="grid gap-5 sm:grid-cols-3">
            <div>
              <Stat size="sm" label="Largest net delta" value={pct(maxDelta, 1)} hint={`Band ±${pct(o.bandPct, 0)} of each sleeve`} />
              <div className="mt-2" aria-label="Delta used of the band">
                <UtilBar value={maxDelta / o.bandPct} cap={1} />
              </div>
            </div>
            <Stat size="sm" label="Lowest margin ratio" value={minMargin === null ? "–" : `${num(minMargin, 1)}×`} tone={minMargin !== null && minMargin < target ? "caution" : undefined} hint={`Target ≥ ${o.marginTarget}× maintenance, ${o.marginTargetClosed}× while closed`} />
            <Stat size="sm" label="Last rebalance" value={o.lastRebalance ? et(Date.parse(o.lastRebalance) / 1000) : "–"} hint="At least once per US session" />
          </dl>
        </div>

        <div className="border-t border-line pt-5">
          <h3 className="mb-2 text-[14px] font-medium text-dim">Sleeves</h3>
          <ul className="divide-y divide-line" data-testid="sleeves">
            {o.sleeves.map((s) => (
              <li key={s.symbol} className="flex flex-wrap items-center gap-x-5 gap-y-2 py-3 text-[14px]">
                <span className="flex w-24 items-center gap-2.5">
                  <AssetIcon ticker={s.symbol} size="sm" />
                  {s.symbol}
                </span>
                <span className="text-muted">
                  Weight <span className="num text-fg">{pct(s.weight, 0)}</span>
                </span>
                <span className="text-muted">
                  Cap <span className="num text-fg">{usd(s.cap, 0)}</span>
                </span>
                {s.status === "active" ? (
                  <>
                    <span className="text-muted">
                      Delta <span className={cn("num", Math.abs(s.delta) > o.bandPct * 0.75 ? "text-caution" : "text-fg")}>{s.delta >= 0 ? "+" : "−"}{pct(Math.abs(s.delta), 1)}</span>
                    </span>
                    <span className="text-muted">
                      Margin <span className={cn("num", s.marginRatio !== null && s.marginRatio < target * 1.2 ? "text-caution" : "text-fg")}>{s.marginRatio === null ? "–" : `${num(s.marginRatio, 1)}×`}</span>
                    </span>
                    <Badge tone="success" icon="check" className="ml-auto">
                      Active
                    </Badge>
                  </>
                ) : (
                  <Badge tone="neutral" icon="pause" className="ml-auto">
                    Unwound to USDG
                  </Badge>
                )}
              </li>
            ))}
          </ul>
        </div>

        <dl className="grid gap-5 border-t border-line pt-5 sm:grid-cols-3">
          <Stat size="sm" label="Perp venue" value={o.venue.name} hint={o.venue.status === "ok" ? "Operating normally" : "Withdrawals halted"} tone={o.venue.status === "halted" ? "danger" : undefined} />
          <Stat size="sm" label="Price report age" value={o.nav.ageSec === null ? "none yet" : o.nav.ageSec < 120 ? `${o.nav.ageSec}s` : `${Math.round(o.nav.ageSec / 60)} min`} hint={o.nav.stale ? "Stale: shares can't be priced" : "Fresh; stale after 15 min"} tone={o.nav.stale ? "caution" : undefined} />
          <Stat size="sm" label="Data as of" value={`Block ${o.asOf.block}`} hint={new Date(o.asOf.time).toUTCString().slice(5, 22) + " UTC"} />
        </dl>

        <div className="border-t border-line pt-5">
          <h3 className="mb-2 text-[14px] font-medium text-dim">Contracts</h3>
          <ul className="grid gap-x-8 gap-y-1 sm:grid-cols-2">
            {(
              [
                ["Vault", o.contracts.vault],
                ["Strategy manager", o.contracts.strategy],
                ["NAV oracle", o.contracts.navOracle],
                ["Perp adapter", o.contracts.perpAdapter],
              ] as const
            ).map(([k, v]) => (
              <li key={k} className="flex min-w-0 items-center justify-between gap-3 border-b border-line py-2 text-[13.5px] last:border-0 sm:[&:nth-last-child(2)]:border-0">
                <span className="text-muted">{k}</span>
                <Address address={v} />
              </li>
            ))}
          </ul>
        </div>
      </div>
    </details>
  );
}

/** Layout-matched placeholder: hero panel, chart, two columns, and the panel column. */
export function VaultSkeleton() {
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_400px] lg:items-start" aria-busy="true" aria-label="Loading USDG Earn" data-testid="vault-loading">
      <div className="min-w-0 space-y-6">
        <div className="panel grid gap-6 p-5 md:grid-cols-2 md:gap-8">
          <div className="space-y-3">
            <Skeleton className="block h-4 w-40" />
            <Skeleton className="block h-14 w-48" />
            <Skeleton className="block h-3 w-64" />
          </div>
          <div className="space-y-4">
            <Skeleton className="block h-2.5 w-full rounded-full" />
            <div className="grid grid-cols-2 gap-3">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="block h-5 w-full" />
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-5 border-t border-line pt-5 sm:grid-cols-3 md:col-span-2">
            {[0, 1, 2].map((i) => (
              <span key={i} className="flex flex-col gap-2">
                <Skeleton className="block h-3 w-20" />
                <Skeleton className="block h-5 w-24" />
              </span>
            ))}
          </div>
        </div>
        <div className="panel h-[330px] p-5">
          <Skeleton className="block h-4 w-32" />
          <Skeleton className="mt-6 block h-[230px] w-full" />
        </div>
      </div>
      <div className="panel hidden space-y-4 p-5 lg:block">
        <Skeleton className="block h-8 w-full" />
        <Skeleton className="block h-[72px] w-full" />
        <Skeleton className="block h-12 w-full" />
      </div>
    </div>
  );
}
