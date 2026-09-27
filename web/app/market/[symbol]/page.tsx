import Link from "next/link";
import {notFound} from "next/navigation";
import {safe, serverApi} from "@/lib/api";
import {TICKERS, explorer} from "@/lib/env";
import {et, num, pct, usd} from "@/lib/format";
import {GuardBanner, Notice, Stat, StatusBadge} from "@/components/ui";
import {MarketCharts} from "@/components/MarketCharts";

export async function generateMetadata({params}: {params: Promise<{symbol: string}>}) {
  return {title: `${(await params).symbol.toUpperCase()} market`};
}

export default async function MarketPage({params}: {params: Promise<{symbol: string}>}) {
  const symbol = (await params).symbol.toUpperCase();
  if (!TICKERS.includes(symbol)) notFound();
  const c = serverApi();
  const [detail, hourly, daily] = await Promise.all([safe(c.market(symbol)), safe(c.history(symbol, {interval: "1h"})), safe(c.history(symbol, {interval: "1d", from: new Date(Date.now() - 400 * 86_400_000).toISOString()}))]);
  if (!detail) return <Notice tone="warn" title="Market data is temporarily unavailable">Try again in a moment.</Notice>;
  const m = detail.data;
  const sch = m.schedule;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold">{symbol}</h1>
        <StatusBadge status={m.marketStatus} />
        <div className="ml-auto flex gap-2">
          <Link href={`/lend/${symbol}`} className="btn btn-ghost">
            Lend
          </Link>
          <Link href={`/short/${symbol}`} className="btn">
            Borrow / short
          </Link>
        </div>
      </div>
      {m.guard.tripped && <GuardBanner reasons={m.guard.reasons} />}
      <dl className="card grid grid-cols-2 gap-4 p-4 sm:grid-cols-4">
        <Stat label="Price (per share)" value={usd(m.price.usdPerShare)} />
        <Stat label="Supplied" value={num(Number(m.supplied))} />
        <Stat label="Borrowed" value={`${num(Number(m.borrowed))} (${usd(m.borrowedUsd, 0)})`} />
        <Stat label="Utilization" value={pct(m.utilization)} />
        <Stat label="Supply APY (variable)" value={pct(m.supplyApy)} />
        <Stat label="Borrow APR (variable)" value={pct(m.borrowApr)} />
        <Stat label="% of float borrowed" value={pct(m.siPctFloat, 3)} />
        <Stat label="Days to cover" value={m.daysToCover === null ? "–" : num(m.daysToCover, 1)} />
      </dl>
      <MarketCharts hourly={hourly?.data ?? []} daily={daily?.data ?? []} />
      <div className="grid gap-4 md:grid-cols-2">
        <section className="card space-y-2 p-4" aria-labelledby="sched">
          <h2 id="sched" className="font-semibold">
            Weekend buffer schedule
          </h2>
          <p className="text-sm text-[var(--color-muted)]">
            While the price feed is closed, the oracle marks the borrowed stock up by a buffer, ramping in over {Math.round(m.params.oracle.rampInSec / 3600)}h before the close.
          </p>
          <dl className="grid grid-cols-2 gap-3">
            <Stat label="Buffer now" value={pct(sch.bufferNow)} />
            <Stat label="Buffer at next close" value={sch.bufferAtClose ? pct(sch.bufferAtClose) : "–"} />
            <Stat label="Ramp-in starts" value={sch.rampStart ? et(Date.parse(sch.rampStart) / 1000) : "–"} />
            <Stat label="Feed closes" value={sch.nextClose ? et(Date.parse(sch.nextClose) / 1000) : "–"} />
            <Stat label="Feed reopens" value={sch.reopen ? et(Date.parse(sch.reopen) / 1000) : "–"} />
            <Stat label="Next earnings buffer" value={sch.nextEvent ? `${pct(sch.nextEvent.buffer, 0)} from ${new Date(sch.nextEvent.fullBy).toUTCString().slice(0, 22)}` : "none scheduled"} />
          </dl>
        </section>
        <section className="card space-y-2 p-4" aria-labelledby="params">
          <h2 id="params" className="font-semibold">
            Parameters
          </h2>
          <dl className="grid grid-cols-2 gap-3">
            <Stat label="LLTV" value={pct(m.params.lltv, 0)} />
            <Stat label="Utilization cap (U_MAX)" value={pct(m.params.uMax, 0)} />
            <Stat label="Min HF to open (t+24h)" value={num(Number(m.params.hfMinOpen), 2)} />
            <Stat label="Supply cap" value={`${num(Number(m.params.supplyCapShares), 0)} (${usd(m.params.supplyCapUsd, 0)})`} />
            <Stat label="Per-address borrow cap" value={usd(m.params.perAddressCapUsd, 0)} />
            <Stat label="Volatility σ / z" value={`${pct(m.params.oracle.sigma, 0)} / ${num(Number(m.params.oracle.z), 1)}`} />
          </dl>
        </section>
      </div>
      <section className="card p-4" aria-labelledby="contracts">
        <h2 id="contracts" className="mb-2 font-semibold">
          Contracts
        </h2>
        <ul className="grid gap-x-10 gap-y-1 text-sm lg:grid-cols-2">
          {Object.entries(m.contracts).map(([k, v]) =>
            v ? (
              <li key={k} className="flex justify-between gap-2">
                <span className="text-[var(--color-muted)]">{k}</span>
                {explorer ? (
                  <a className="num truncate underline" href={`${explorer}/address/${v}`} rel="noreferrer" target="_blank">
                    {v}
                  </a>
                ) : (
                  <span className="num truncate">{v}</span>
                )}
              </li>
            ) : null,
          )}
        </ul>
      </section>
    </div>
  );
}
