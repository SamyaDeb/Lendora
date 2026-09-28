"use client";
import {useEffect, useState, type ReactNode} from "react";
import Link from "next/link";
import {useQuery} from "@tanstack/react-query";
import {AnimatePresence, motion} from "motion/react";
import {browserApi, type HistoryPoint, type MarketDetail} from "@/lib/api";
import {availableToBorrow, borrowEase} from "@/lib/market";
import {et, num, pct, usd} from "@/lib/format";
import {cn} from "@/lib/cn";
import {Address, AssetIcon, Button, EaseBadge, EmptyState, Icon, Notice, NumberTicker, Skeleton, Stat, StatusBadge, UtilBar, useMediaQuery} from "@/components/ui";
import {MarketCharts} from "@/components/charts/MarketCharts";
import {ActionPanel, type ActionTab} from "./ActionPanel";

type DetailResponse = Awaited<ReturnType<ReturnType<typeof browserApi>["market"]>>;

/** 06 `/stock/[ticker]`: market detail on the left, the Lend / Borrow / Short panel on the right (bottom sheet on mobile). */
export function StockView({symbol, initial, hourly, daily, initialTab}: {symbol: string; initial?: DetailResponse; hourly: HistoryPoint[]; daily: HistoryPoint[]; initialTab: ActionTab}) {
  const q = useQuery({queryKey: ["market", symbol], queryFn: () => browserApi().market(symbol), initialData: initial, refetchInterval: 10_000});
  const m = q.data?.data;
  const [tab, setTab] = useState<ActionTab>(initialTab);
  const desktop = useMediaQuery("(min-width: 1024px)");
  const [sheet, setSheet] = useState(false);
  const openSheet = (t: ActionTab) => (setTab(t), setSheet(true));
  useEffect(() => {
    if (desktop) setSheet(false);
  }, [desktop]);
  useEffect(() => {
    if (!sheet) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setSheet(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sheet]);

  const price = m ? Number(m.price.usdPerShare) : undefined;
  const available = m ? availableToBorrow(m, Number(m.params.uMax)) : undefined;

  return (
    <div className="space-y-6 pb-24 lg:pb-0">
      <nav aria-label="Breadcrumb" className="text-[13px] text-muted">
        <Link href="/" className="hover:text-fg">
          Markets
        </Link>{" "}
        / <span className="text-dim">{symbol}</span>
      </nav>

      <header className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <AssetIcon ticker={symbol} size="lg" />
        <div>
          <h1 className="t-display leading-none">{symbol}</h1>
          <p className="mt-1 text-[13.5px] text-muted">Stock Token · lending market on Morpho Blue</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {m ? <StatusBadge status={m.marketStatus} /> : <Skeleton className="h-6 w-20 rounded-full" />}
          {m && <EaseBadge ease={borrowEase(m, Number(m.params.uMax))} />}
        </div>
        <div className="ml-auto text-right">
          <p className="t-label">Price per share</p>
          <p className="text-[28px] font-medium tracking-[-0.02em]">{price !== undefined ? <NumberTicker value={price} format="usd" /> : <Skeleton className="h-8 w-28" />}</p>
        </div>
      </header>

      {m?.guard.tripped && (
        <Notice tone="danger" title="Borrowing is paused here">
          The oracle&apos;s safety guard is tripped. Lending, repaying, closing and withdrawing still work. The Borrow tab and the{" "}
          <Link href="/status" className="underline underline-offset-2">
            status page
          </Link>{" "}
          say why.
        </Notice>
      )}

      {m ? (
        <dl className="panel grid grid-cols-2 gap-x-6 gap-y-5 p-5 sm:grid-cols-4">
          <Stat label="Lend APY (variable)" tone="supply" value={<NumberTicker value={m.supplyApy} format="pct" />} hint="Paid by borrowers, net of the 10% fee" />
          <Stat label="Borrow APR (variable)" tone="borrow" value={<NumberTicker value={Number(m.borrowApr)} format="pct" />} hint="Rises steeply above the cap" />
          <Stat label="Utilization" value={<UtilBar value={Number(m.utilization)} cap={Number(m.params.uMax)} />} hint={`Capped at ${pct(m.params.uMax, 0)}`} />
          <Stat label="Available to borrow" value={`${num(available ?? 0, 2)}`} hint={price ? usd((available ?? 0) * price, 0) : undefined} />
          <Stat label="Supplied" value={num(Number(m.supplied))} hint={price ? usd(Number(m.supplied) * price, 0) : undefined} />
          <Stat label="Borrowed" tone="borrow" value={num(Number(m.borrowed))} hint={usd(m.borrowedUsd, 0)} />
          <Stat label="Short interest" value={pct(m.siPctFloat, 3)} hint="of the float" />
          <Stat label="Days to cover" value={m.daysToCover === null ? "–" : num(m.daysToCover, 1)} hint={`${m.borrowers} borrowers`} />
        </dl>
      ) : q.isError ? (
        <EmptyState title="Market data didn't load" tone="danger" icon="alert" action={<Button variant="secondary" onClick={() => q.refetch()}>Try again</Button>}>
          The data API didn&apos;t respond. You can still lend and borrow: the panel reads the chain directly.
        </EmptyState>
      ) : (
        <div className="panel grid grid-cols-2 gap-5 p-5 sm:grid-cols-4" aria-busy="true">
          {Array.from({length: 8}, (_, i) => (
            <span key={i} className="flex flex-col gap-2">
              <Skeleton className="block h-3 w-20" />
              <Skeleton className="block h-5 w-16" />
            </span>
          ))}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_420px] lg:items-start">
        <div className="min-w-0 space-y-6">
          <MarketCharts hourly={hourly} daily={daily} />
          {m && <RiskInPlainWords m={m} symbol={symbol} />}
          {m && <Contracts m={m} />}
        </div>

        {/* One panel instance: sticky column on desktop, bottom sheet on mobile (test ids stay unique). */}
        <AnimatePresence>
          {sheet && !desktop && (
            <motion.div key="scrim" className="fixed inset-0 z-40 bg-[var(--scrim)] lg:hidden" initial={{opacity: 0}} animate={{opacity: 1}} exit={{opacity: 0}} transition={{duration: 0.2}} onClick={() => setSheet(false)} aria-hidden />
          )}
        </AnimatePresence>
        <aside
          aria-label={`Lend, borrow or short ${symbol}`}
          role={!desktop && sheet ? "dialog" : undefined}
          aria-modal={!desktop && sheet ? true : undefined}
          className={cn(
            "panel p-5",
            "lg:sticky lg:top-[126px] lg:max-h-[calc(100vh-146px)] lg:translate-y-0 lg:overflow-y-auto",
            "max-lg:fixed max-lg:inset-x-0 max-lg:bottom-0 max-lg:z-50 max-lg:max-h-[90dvh] max-lg:overflow-y-auto max-lg:rounded-b-none max-lg:rounded-t-[var(--r-lg)] max-lg:pb-[max(1.25rem,env(safe-area-inset-bottom))] max-lg:shadow-[var(--shadow-pop),inset_0_0_0_1px_var(--border-strong)]",
            "max-lg:transition-[transform,visibility] max-lg:duration-300 max-lg:ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none",
            sheet ? "max-lg:visible max-lg:translate-y-0" : "max-lg:invisible max-lg:translate-y-full",
          )}
        >
          <div className="mb-3 flex items-center justify-between lg:hidden">
            <span className="mx-auto h-1 w-10 rounded-full bg-white/20" aria-hidden />
          </div>
          <button type="button" className="absolute right-4 top-4 grid size-8 place-items-center rounded-[8px] text-muted hover:bg-white/[0.06] hover:text-fg lg:hidden" onClick={() => setSheet(false)} aria-label="Close">
            <Icon name="close" size={18} />
          </button>
          <ActionPanel symbol={symbol} tab={tab} onTab={setTab} price={price} available={available} />
        </aside>
      </div>

      {/* Mobile action bar */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-[color-mix(in_srgb,var(--bg)_88%,transparent)] px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur-md lg:hidden">
        <div className="mx-auto flex max-w-lg gap-2">
          <Button variant="supply" className="flex-1" onClick={() => openSheet("lend")}>
            Lend
          </Button>
          <Button variant="borrow" className="flex-1" onClick={() => openSheet("borrow")}>
            Borrow
          </Button>
          <Button variant="secondary" className="flex-1" onClick={() => openSheet("short")}>
            Short
          </Button>
        </div>
      </div>
    </div>
  );
}

function Plain({icon, title, children}: {icon: ReactNode; title: string; children: ReactNode}) {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-[8px] bg-white/[0.06] shadow-[inset_0_0_0_1px_var(--border)]">{icon}</span>
      <div>
        <p className="text-[14.5px] font-medium">{title}</p>
        <p className="mt-0.5 text-[13.5px] leading-relaxed text-muted">{children}</p>
      </div>
    </li>
  );
}

/** Risk settings in plain words (06: LLTV, caps, U_MAX, weekend buffer schedule). */
function RiskInPlainWords({m, symbol}: {m: MarketDetail; symbol: string}) {
  const sch = m.schedule;
  const rampH = Math.round(m.params.oracle.rampInSec / 3600);
  return (
    <section className="grid gap-6 md:grid-cols-2" aria-label="Risk settings">
      <div className="panel p-5">
        <h2 className="t-title">How this market works</h2>
        <ul className="mt-4 space-y-4">
          <Plain icon={<Icon name="alert" size={16} className="text-caution" />} title={`Liquidation at ${pct(m.params.lltv, 0)} loan-to-value`}>
            When your debt reaches {pct(m.params.lltv, 0)} of your collateral&apos;s value (health factor 1.00), anyone can repay it and take collateral at a discount.
          </Plain>
          <Plain icon={<Icon name="shield" size={16} className="text-accent-text" />} title="A 24-hour safety check to open">
            New borrows need a health factor of at least {num(Number(m.params.hfMinOpen), 2)} for the next 24 hours, counting any weekend or earnings buffer in that window.
          </Plain>
          <Plain icon={<Icon name="trendUp" size={16} className="text-borrow" />} title={`Utilization capped at ${pct(m.params.uMax, 0)}`}>
            Above the cap, the borrow rate climbs steeply so lenders can withdraw. Lenders earn more when utilization is high.
          </Plain>
          <Plain icon={<Icon name="layers" size={16} className="text-dim" />} title="Caps">
            Each address can borrow up to {usd(m.params.perAddressCapUsd, 0)} here. The market holds at most {num(Number(m.params.supplyCapShares), 0)} {symbol} ({usd(m.params.supplyCapUsd, 0)}).
          </Plain>
          <Plain icon={<Icon name="info" size={16} className="text-dim" />} title="Borrowers owe the stock and its dividends">
            Dividends are added through the Stock Token&apos;s multiplier, so borrowers pay them to lenders.
          </Plain>
        </ul>
      </div>
      <div className="panel p-5">
        <h2 className="t-title flex items-center gap-2">
          <Icon name="moon" size={18} className="text-weekend" /> Weekend mode
        </h2>
        <p className="mt-2 text-[13.5px] leading-relaxed text-muted">
          When US markets close, the price feed stops. The oracle then marks {symbol} up by a safety buffer (ramping in over {rampH}h before the close), so borrowers need more collateral until the first price after reopening.
        </p>
        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-4">
          <Stat size="sm" label="Buffer now" tone={Number(sch.bufferNow) > 0 ? "weekend" : undefined} value={pct(sch.bufferNow)} />
          <Stat size="sm" label="Buffer at next close" tone="weekend" value={sch.bufferAtClose ? pct(sch.bufferAtClose) : "–"} />
          <Stat size="sm" label="Ramp-in starts" value={sch.rampStart ? et(Date.parse(sch.rampStart) / 1000) : "–"} />
          <Stat size="sm" label="Feed closes" value={sch.nextClose ? et(Date.parse(sch.nextClose) / 1000) : "–"} />
          <Stat size="sm" label="Feed reopens" value={sch.reopen ? et(Date.parse(sch.reopen) / 1000) : "–"} />
          <Stat size="sm" label="Next earnings buffer" value={sch.nextEvent ? `${pct(sch.nextEvent.buffer, 0)}` : "None scheduled"} hint={sch.nextEvent ? `from ${new Date(sch.nextEvent.fullBy).toUTCString().slice(0, 22)}` : undefined} />
        </dl>
        <p className="mt-4 text-[12.5px] text-muted">
          Volatility inputs: σ {pct(m.params.oracle.sigma, 0)}, z {num(Number(m.params.oracle.z), 1)}. Buffer between {pct(m.params.oracle.bMin, 1)} and {pct(m.params.oracle.bMax, 1)}.
        </p>
      </div>
    </section>
  );
}

function Contracts({m}: {m: MarketDetail}) {
  return (
    <section className="panel p-5" aria-labelledby="contracts">
      <h2 id="contracts" className="t-title">
        Contracts
      </h2>
      <ul className="mt-3 grid gap-x-8 gap-y-1 sm:grid-cols-2">
        {Object.entries(m.contracts).map(([k, v]) =>
          v ? (
            <li key={k} className="flex min-w-0 items-center justify-between gap-3 border-b border-line py-2 text-[13.5px] last:border-0 sm:[&:nth-last-child(2)]:border-0">
              <span className="text-muted">{k}</span>
              <Address address={v} />
            </li>
          ) : null,
        )}
      </ul>
    </section>
  );
}
