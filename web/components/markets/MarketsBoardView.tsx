"use client";
import {useMemo, useState} from "react";
import Link from "next/link";
import {useRouter} from "next/navigation";
import type {HistoryPoint, Market} from "@/lib/api";
import {availableToBorrow, borrowEase, totals, U_MAX} from "@/lib/market";
import {num, usd} from "@/lib/format";
import {cn} from "@/lib/cn";
import {AssetIcon, Button, ButtonLink, EaseBadge, EmptyState, Icon, NumberTicker, Segmented, Skeleton, Sparkline, Stat, UtilBar} from "@/components/ui";

type Key = "symbol" | "price" | "available" | "utilization" | "supplyApy" | "borrowApr";
type Filter = "all" | "borrowable" | "paused";

const VAL: Record<Key, (m: Market) => number | string> = {
  symbol: (m) => m.symbol,
  price: (m) => Number(m.price.usdPerShare),
  available: (m) => availableToBorrow(m) * Number(m.price.usdPerShare),
  utilization: (m) => Number(m.utilization),
  supplyApy: (m) => m.supplyApy,
  borrowApr: (m) => Number(m.borrowApr),
};

export interface MarketsBoardProps {
  markets?: Market[];
  histories: Record<string, HistoryPoint[] | undefined>;
  asOf?: {block: string; time: string; confirmed: boolean};
  error?: boolean;
  onRetry?: () => void;
}

/** 06 `/`: the borrow board. Summary strip, search and filter, a sortable table (cards on mobile). */
export function MarketsBoardView({markets, histories, asOf, error, onRetry}: MarketsBoardProps) {
  const [sort, setSort] = useState<{key: Key; desc: boolean}>({key: "utilization", desc: true});
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  const rows = useMemo(() => {
    const q = query.trim().toUpperCase();
    const list = (markets ?? []).filter((m) => (!q || m.symbol.includes(q)) && (filter === "all" || (filter === "paused" ? m.guard.tripped : !m.guard.tripped && borrowEase(m) !== "hard")));
    const v = VAL[sort.key];
    return list.sort((a, b) => {
      const x = v(a);
      const y = v(b);
      const c = typeof x === "string" ? x.localeCompare(y as string) : x - (y as number);
      return sort.desc ? -c : c;
    });
  }, [markets, query, filter, sort]);

  const t = markets ? totals(markets) : undefined;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
        <div className="max-w-xl">
          <h1 className="t-display">Stock lending markets</h1>
          <p className="mt-2 text-[15px] text-muted">Lend Stock Tokens to earn the fees borrowers pay, or borrow them to short or hedge. Rates move with utilization.</p>
        </div>
        <dl className="grid grid-cols-3 gap-4 md:flex md:gap-10" aria-label="Totals">
          <Stat label="Total supplied" size="lg" value={t ? <NumberTicker value={t.suppliedUsd} format="usdCompact" /> : <Skeleton className="h-7 w-24" />} />
          <Stat label="Total borrowed" size="lg" tone="borrow" value={t ? <NumberTicker value={t.borrowedUsd} format="usdCompact" /> : <Skeleton className="h-7 w-24" />} />
          <Stat label="Active borrowers" size="lg" value={t ? <NumberTicker value={t.borrowers} digits={0} /> : <Skeleton className="h-7 w-12" />} />
        </dl>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <label className="flex h-10 w-full items-center gap-2 rounded-sm bg-sunken px-3 shadow-[inset_0_0_0_1px_var(--border)] focus-within:shadow-[inset_0_0_0_1px_var(--accent)] sm:w-72">
          <Icon name="search" size={16} className="text-muted" />
          <span className="sr-only">Search stocks</span>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search a ticker" className="w-full bg-transparent text-[15px] outline-none placeholder:text-white/35 focus-visible:outline-none" />
        </label>
        <Segmented<Filter>
          label="Filter markets"
          value={filter}
          onChange={setFilter}
          options={[
            {value: "all", label: "All"},
            {value: "borrowable", label: "Can borrow now"},
            {value: "paused", label: "Paused"},
          ]}
        />
      </div>

      {error && !markets ? (
        <EmptyState title="Market data didn't load" tone="danger" icon="alert" action={onRetry && <Button variant="secondary" onClick={onRetry}>Try again</Button>}>
          The data API didn&apos;t respond. Your positions still read from the chain on the portfolio page.
        </EmptyState>
      ) : !markets ? (
        <BoardSkeleton />
      ) : rows.length === 0 ? (
        <EmptyState
          title={query ? `No stock matches “${query}”` : filter === "paused" ? "No market is paused" : "No market is open for borrowing right now"}
          icon="search"
          action={
            <Button variant="secondary" onClick={() => (setQuery(""), setFilter("all"))}>
              Show all markets
            </Button>
          }
        />
      ) : (
        <>
          <BoardTable rows={rows} histories={histories} sort={sort} setSort={setSort} />
          <BoardCards rows={rows} histories={histories} />
        </>
      )}

      {asOf && (
        <p className="text-[12.5px] text-muted">
          As of block <span className="num">{asOf.block}</span> · {asOf.confirmed ? "final" : "not yet final"} · Lend APY is paid by borrowers (net of the 10% protocol fee). Rates are variable. Available to borrow keeps each market under its {Math.round(U_MAX * 100)}% utilization cap.
        </p>
      )}
    </div>
  );
}

function SortHeader({k, label, sub, sort, setSort, align = "right"}: {k: Key; label: string; sub?: string; sort: {key: Key; desc: boolean}; setSort: (s: {key: Key; desc: boolean}) => void; align?: "left" | "right"}) {
  const active = sort.key === k;
  return (
    <th scope="col" aria-sort={active ? (sort.desc ? "descending" : "ascending") : "none"} className={cn("sticky top-[102px] z-10 bg-surface px-4 py-3 font-normal", align === "right" ? "text-right" : "text-left")}>
      <button
        type="button"
        onClick={() => setSort({key: k, desc: active ? !sort.desc : k !== "symbol"})}
        className={cn("pressable inline-flex items-center gap-1 rounded-[6px] text-[13px] hover:text-fg", active ? "text-fg" : "text-muted", align === "right" && "flex-row-reverse")}
      >
        <Icon name={active ? (sort.desc ? "arrowDown" : "arrowUp") : "sort"} size={13} className={active ? "text-accent-text" : "opacity-60"} />
        <span className="text-left leading-tight">
          {label}
          {sub && <span className="block text-[11.5px] text-muted">{sub}</span>}
        </span>
      </button>
    </th>
  );
}

function BoardTable({rows, histories, sort, setSort}: {rows: Market[]; histories: MarketsBoardProps["histories"]; sort: {key: Key; desc: boolean}; setSort: (s: {key: Key; desc: boolean}) => void}) {
  const router = useRouter();
  return (
    <div className="panel hidden overflow-clip md:block">
      <table className="w-full border-separate border-spacing-0 text-[14.5px]" data-testid="markets">
        <caption className="sr-only">Lendora markets. Select a column header to sort.</caption>
        <thead>
          <tr className="[&>th]:border-b [&>th]:border-line">
            <SortHeader k="symbol" label="Stock" align="left" sort={sort} setSort={setSort} />
            <SortHeader k="price" label="Price" sort={sort} setSort={setSort} />
            <SortHeader k="available" label="Available to borrow" sort={sort} setSort={setSort} />
            <SortHeader k="utilization" label="Utilization" sort={sort} setSort={setSort} />
            <SortHeader k="supplyApy" label="Lend APY" sub="paid by borrowers" sort={sort} setSort={setSort} />
            <SortHeader k="borrowApr" label="Borrow APR" sub="variable, 7d" sort={sort} setSort={setSort} />
            <th scope="col" className="sticky top-[102px] z-10 bg-surface px-4 py-3 text-left text-[13px] font-normal text-muted">
              Status
            </th>
            <th scope="col" className="sticky top-[102px] z-10 bg-surface px-4 py-3">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((m) => {
            const avail = availableToBorrow(m);
            const price = Number(m.price.usdPerShare);
            const apr = (histories[m.symbol] ?? []).map((p) => Number(p.borrowApr));
            const ease = borrowEase(m);
            return (
              <tr
                key={m.symbol}
                data-symbol={m.symbol}
                className="group cursor-pointer transition-colors duration-150 hover:bg-white/[0.03] [&>*]:border-b [&>*]:border-line last:[&>*]:border-0"
                onClick={(e) => {
                  if (!(e.target as HTMLElement).closest("a,button")) router.push(`/stock/${m.symbol}`);
                }}
              >
                <th scope="row" className="px-4 py-3.5 text-left font-normal">
                  <Link href={`/stock/${m.symbol}`} className="inline-flex items-center gap-3 rounded-[6px]">
                    <AssetIcon ticker={m.symbol} />
                    <span>
                      <span className="block font-medium text-fg group-hover:underline group-hover:underline-offset-2">{m.symbol}</span>
                      <span className="block text-[12.5px] text-muted">Stock Token</span>
                    </span>
                  </Link>
                </th>
                <td className="px-4 py-3.5 text-right">
                  <NumberTicker value={price} format="usd" />
                </td>
                <td className="px-4 py-3.5 text-right">
                  <span className="num block">{num(avail, 2)}</span>
                  <span className="num block text-[12.5px] text-muted">{usd(avail * price, 0)}</span>
                </td>
                <td className="w-[180px] px-4 py-3.5">
                  <UtilBar value={Number(m.utilization)} cap={U_MAX} data-col="utilization" />
                </td>
                <td className="px-4 py-3.5 text-right">
                  <NumberTicker value={m.supplyApy} format="pct" className="text-supply" />
                </td>
                <td className="px-4 py-3.5">
                  <span className="flex items-center justify-end gap-3">
                    <Sparkline values={apr.filter((_, i) => i % 3 === 0)} color="var(--borrow)" label={`${m.symbol} borrow APR, last 7 days`} width={64} />
                    <NumberTicker value={Number(m.borrowApr)} format="pct" className="w-[56px] text-right text-borrow" />
                  </span>
                </td>
                <td className="px-4 py-3.5">
                  <EaseBadge ease={ease} />
                </td>
                <td className="px-4 py-3.5 text-right">
                  <span className="inline-flex gap-2 opacity-90 transition-opacity group-hover:opacity-100">
                    <ButtonLink href={`/stock/${m.symbol}?tab=lend`} variant="secondary" size="sm" aria-label={`Lend ${m.symbol}`}>
                      Lend
                    </ButtonLink>
                    <ButtonLink href={`/stock/${m.symbol}?tab=borrow`} variant="secondary" size="sm" aria-label={`Borrow ${m.symbol}`}>
                      Borrow
                    </ButtonLink>
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function BoardCards({rows, histories}: {rows: Market[]; histories: MarketsBoardProps["histories"]}) {
  return (
    <ul className="space-y-3 md:hidden" aria-label="Markets">
      {rows.map((m) => {
        const price = Number(m.price.usdPerShare);
        const avail = availableToBorrow(m);
        const apr = (histories[m.symbol] ?? []).map((p) => Number(p.borrowApr));
        return (
          <li key={m.symbol}>
            <Link href={`/stock/${m.symbol}`} className="panel pressable block space-y-4 p-4 hover:shadow-[var(--ring-hover)]">
              <div className="flex items-center gap-3">
                <AssetIcon ticker={m.symbol} />
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{m.symbol}</p>
                  <p className="num text-[13px] text-muted">{usd(price)}</p>
                </div>
                <EaseBadge ease={borrowEase(m)} />
              </div>
              <dl className="grid grid-cols-3 gap-3">
                <Stat size="sm" label="Lend APY" value={<NumberTicker value={m.supplyApy} format="pct" />} tone="supply" />
                <Stat
                  size="sm"
                  label="Borrow APR"
                  tone="borrow"
                  value={
                    <span className="flex items-center gap-2">
                      <NumberTicker value={Number(m.borrowApr)} format="pct" />
                    </span>
                  }
                />
                <Stat size="sm" label="Available" value={num(avail, 1)} />
              </dl>
              <div className="flex items-center gap-3">
                <span className="t-label shrink-0">Utilization</span>
                <UtilBar value={Number(m.utilization)} cap={U_MAX} />
                <Sparkline values={apr.filter((_, i) => i % 3 === 0)} color="var(--borrow)" label={`${m.symbol} borrow APR, last 7 days`} width={56} />
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/** Skeleton with the table's exact columns on desktop and the card shape on mobile (no spinner). */
function BoardSkeleton() {
  const heads = ["Stock", "Price", "Available to borrow", "Utilization", "Lend APY", "Borrow APR", "Status", ""];
  return (
    <div aria-busy="true" aria-label="Loading markets">
      <div className="panel hidden overflow-clip md:block">
        <table className="w-full border-separate border-spacing-0 text-[14.5px]">
          <thead>
            <tr className="[&>th]:border-b [&>th]:border-line">
              {heads.map((h, i) => (
                <th key={i} scope="col" className={cn("px-4 py-3 text-[13px] font-normal text-muted", i === 0 || i === 6 ? "text-left" : "text-right")}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[0, 1, 2].map((r) => (
              <tr key={r} className="[&>td]:border-b [&>td]:border-line last:[&>td]:border-0">
                <td className="px-4 py-3.5">
                  <span className="flex items-center gap-3">
                    <Skeleton className="size-9 rounded-[8px]" />
                    <span className="flex flex-col gap-1.5">
                      <Skeleton className="block h-4 w-14" />
                      <Skeleton className="block h-3 w-20" />
                    </span>
                  </span>
                </td>
                <td className="px-4 py-3.5 text-right"><Skeleton className="h-4 w-16" /></td>
                <td className="px-4 py-3.5 text-right"><Skeleton className="h-4 w-20" /></td>
                <td className="w-[180px] px-4 py-3.5"><Skeleton className="block h-1.5 w-full" /></td>
                <td className="px-4 py-3.5 text-right"><Skeleton className="h-4 w-12" /></td>
                <td className="px-4 py-3.5 text-right"><Skeleton className="h-4 w-28" /></td>
                <td className="px-4 py-3.5"><Skeleton className="h-6 w-28 rounded-full" /></td>
                <td className="px-4 py-3.5 text-right"><Skeleton className="h-8 w-32" /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="space-y-3 md:hidden">
        {[0, 1, 2].map((r) => (
          <div key={r} className="panel space-y-4 p-4">
            <div className="flex items-center gap-3">
              <Skeleton className="size-9 rounded-[8px]" />
              <span className="flex flex-1 flex-col gap-1.5">
                <Skeleton className="block h-4 w-14" />
                <Skeleton className="block h-3 w-16" />
              </span>
              <Skeleton className="h-6 w-24 rounded-full" />
            </div>
            <div className="grid grid-cols-3 gap-3">
              {[0, 1, 2].map((c) => (
                <span key={c} className="flex flex-col gap-1.5">
                  <Skeleton className="block h-3 w-14" />
                  <Skeleton className="block h-4 w-12" />
                </span>
              ))}
            </div>
            <Skeleton className="block h-1.5 w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
