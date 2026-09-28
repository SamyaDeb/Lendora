"use client";
import {useMemo, useState} from "react";
import Link from "next/link";
import type {HistoryPoint, Market} from "@/lib/api";
import {num, pct, usd} from "@/lib/format";
import {cn} from "@/lib/cn";
import {AssetIcon, Badge, Button, EmptyState, Icon, Segmented, Sparkline} from "@/components/ui";
import {LineChart} from "@/components/charts/LineChart";

type ColKey = "borrowed" | "borrowedUsd" | "siPctFloat" | "utilization" | "borrowApr" | "change" | "dtc";
const change24 = (m: Market) => Number(m.newShorts24h) - Number(m.covered24h);
const COLS: {key: ColKey; label: string; val: (m: Market) => number; show: (m: Market) => string}[] = [
  {key: "borrowed", label: "Short interest (shares)", val: (m) => Number(m.borrowed), show: (m) => num(Number(m.borrowed))},
  {key: "borrowedUsd", label: "Short interest (USD)", val: (m) => Number(m.borrowedUsd), show: (m) => usd(m.borrowedUsd, 0)},
  {key: "siPctFloat", label: "% of float", val: (m) => Number(m.siPctFloat), show: (m) => pct(m.siPctFloat, 3)},
  {key: "utilization", label: "Utilization", val: (m) => Number(m.utilization), show: (m) => pct(m.utilization)},
  {key: "borrowApr", label: "Borrow APR", val: (m) => Number(m.borrowApr), show: (m) => pct(m.borrowApr)},
  {key: "change", label: "24h change", val: change24, show: (m) => `${change24(m) >= 0 ? "+" : ""}${num(change24(m))}`},
  {key: "dtc", label: "Days to cover", val: (m) => m.daysToCover ?? -1, show: (m) => (m.daysToCover === null ? "–" : num(m.daysToCover, 1))},
];

/** Change in borrowed shares over the last `hours` of hourly history, as a fraction of the starting value. */
function changeOver(h: HistoryPoint[] | undefined, hours: number) {
  if (!h || h.length < 2) return undefined;
  const end = h[h.length - 1];
  const t = Date.parse(end.bucket) - hours * 3600_000;
  const start = h.find((p) => Date.parse(p.bucket) >= t) ?? h[0];
  const a = Number(start.borrowed);
  const b = Number(end.borrowed);
  return {abs: b - a, rel: a > 0 ? (b - a) / a : 0};
}

/** 07 §4 public dashboard: most shorted, biggest movers, per-stock history, weekend panel, API. No wallet needed. */
export function DataView({markets, histories, asOf, weekendPanel, revenuePanel, apiUrl}: {markets?: Market[]; histories: Record<string, HistoryPoint[]>; asOf?: {block: string; confirmed: boolean}; weekendPanel?: React.ReactNode; revenuePanel?: React.ReactNode; apiUrl: string}) {
  const [sort, setSort] = useState<{key: ColKey; desc: boolean}>({key: "borrowedUsd", desc: true});
  const rows = useMemo(() => {
    const col = COLS.find((c) => c.key === sort.key)!;
    return [...(markets ?? [])].sort((a, b) => (sort.desc ? col.val(b) - col.val(a) : col.val(a) - col.val(b)));
  }, [markets, sort]);
  const tickers = Object.keys(histories);
  const [t, setT] = useState(tickers.includes("NVDA") ? "NVDA" : tickers[0]);
  const pts = histories[t] ?? [];
  const s = (f: (p: HistoryPoint) => number) => pts.map((p) => ({t: Date.parse(p.bucket) / 1000, v: f(p)}));

  const movers = (markets ?? []).map((m) => ({m, day: changeOver(histories[m.symbol], 24), week: changeOver(histories[m.symbol], 24 * 7)}));
  const byDay = [...movers].filter((x) => x.day).sort((a, b) => Math.abs(b.day!.rel) - Math.abs(a.day!.rel)).slice(0, 3);
  const byWeek = [...movers].filter((x) => x.week).sort((a, b) => Math.abs(b.week!.rel) - Math.abs(a.week!.rel)).slice(0, 3);

  return (
    <div className="space-y-8">
      <div className="max-w-2xl">
        <h1 className="t-display">Short interest</h1>
        <p className="mt-2 text-[15px] text-muted">Every Lendora borrow is onchain, so short interest is live, not reported twice a month. Scope: Lendora markets only. Free to use, no wallet needed.</p>
      </div>

      {!markets ? (
        <EmptyState title="Short-interest data didn't load" tone="danger" icon="alert">
          The data API didn&apos;t respond. It usually recovers within a minute; the chain is the source either way.
        </EmptyState>
      ) : (
        <>
          <section className="grid gap-4 md:grid-cols-3" aria-label="Most shorted">
            {[...markets]
              .sort((a, b) => Number(b.borrowedUsd) - Number(a.borrowedUsd))
              .slice(0, 3)
              .map((m, i) => (
                <Link key={m.symbol} href={`/stock/${m.symbol}`} className="panel pressable block p-5 hover:shadow-[var(--ring-hover)]">
                  <div className="flex items-center gap-3">
                    <AssetIcon ticker={m.symbol} />
                    <span className="flex-1 font-medium">{m.symbol}</span>
                    <Badge tone={i === 0 ? "borrow" : "neutral"}>#{i + 1} most shorted</Badge>
                  </div>
                  <p className="num mt-4 text-[26px] font-medium tracking-[-0.02em] text-borrow">{usd(m.borrowedUsd, 0)}</p>
                  <p className="text-[13px] text-muted">
                    <span className="num">{num(Number(m.borrowed))}</span> shares · <span className="num">{pct(m.siPctFloat, 3)}</span> of float
                  </p>
                  <div className="mt-3">
                    <Sparkline values={(histories[m.symbol] ?? []).filter((_, j) => j % 6 === 0).map((p) => Number(p.borrowed))} color="var(--borrow)" width={220} height={32} label={`${m.symbol} short interest trend`} />
                  </div>
                </Link>
              ))}
          </section>

          <section className="grid gap-4 md:grid-cols-2" aria-label="Biggest changes">
            <Movers title="Biggest changes today" items={byDay.map((x) => ({m: x.m, c: x.day!}))} />
            <Movers title="Biggest changes this week" items={byWeek.map((x) => ({m: x.m, c: x.week!}))} />
          </section>

          <section className="space-y-3" aria-labelledby="lb-h">
            <h2 id="lb-h" className="t-title">
              Leaderboard
            </h2>
            <div className="panel overflow-x-auto md:overflow-clip">
              <table className="w-full min-w-[820px] border-separate border-spacing-0 text-[14px]" data-testid="leaderboard">
                <caption className="sr-only">Short interest by stock. Select a column header to sort.</caption>
                <thead>
                  <tr className="[&>th]:border-b [&>th]:border-line">
                    <th scope="col" className="bg-surface px-4 py-3 text-left text-[13px] font-normal text-muted md:sticky md:top-[102px] md:z-10">
                      Stock
                    </th>
                    {COLS.map((c) => {
                      const active = sort.key === c.key;
                      return (
                        <th key={c.key} scope="col" className="bg-surface px-4 py-3 text-right font-normal md:sticky md:top-[102px] md:z-10" aria-sort={active ? (sort.desc ? "descending" : "ascending") : "none"}>
                          <button className={cn("pressable inline-flex flex-row-reverse items-center gap-1 text-[13px] hover:text-fg", active ? "text-fg" : "text-muted")} onClick={() => setSort((x) => ({key: c.key, desc: x.key === c.key ? !x.desc : true}))}>
                            <Icon name={active ? (sort.desc ? "arrowDown" : "arrowUp") : "sort"} size={13} className={active ? "text-accent-text" : "opacity-60"} />
                            {c.label}
                          </button>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((m) => (
                    <tr key={m.symbol} className="transition-colors hover:bg-white/[0.03] [&>*]:border-b [&>*]:border-line last:[&>*]:border-0">
                      <th scope="row" className="px-4 py-3 text-left font-normal">
                        <Link href={`/stock/${m.symbol}`} className="inline-flex items-center gap-2.5 font-medium hover:underline">
                          <AssetIcon ticker={m.symbol} size="sm" />
                          {m.symbol}
                        </Link>
                      </th>
                      {COLS.map((c) => (
                        <td key={c.key} className={cn("num px-4 py-3 text-right", c.key === "change" && (change24(m) > 0 ? "text-borrow" : change24(m) < 0 ? "text-supply" : ""))}>
                          {c.show(m)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {asOf && (
              <p className="text-[12.5px] text-muted">
                As of block <span className="num">{asOf.block}</span> {asOf.confirmed ? "(final)" : "(not yet final)"}. 24h change: new shorts minus covered, in shares; pink means more shorting.
              </p>
            )}
          </section>
        </>
      )}

      <section className="space-y-3" aria-labelledby="hist-h">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="hist-h" className="t-title">
            Per-stock history
          </h2>
          {tickers.length > 0 && <Segmented label="Stock" value={t} onChange={setT} options={tickers.map((x) => ({value: x, label: x}))} />}
        </div>
        <LineChart title={`${t} short interest`} subtitle="Hourly, weekends shaded" a={{label: "Borrowed (shares)", color: "var(--borrow)", points: s((p) => Number(p.borrowed))}} b={{label: "Borrow APR", unit: "%", color: "var(--accent-text)", points: s((p) => Number(p.borrowApr))}} />
      </section>

      {weekendPanel}
      {revenuePanel}

      <ApiSection apiUrl={apiUrl} />
    </div>
  );
}

function Movers({title, items}: {title: string; items: {m: Market; c: {abs: number; rel: number}}[]}) {
  return (
    <div className="panel p-5">
      <h2 className="text-[15px] font-medium">{title}</h2>
      {items.length === 0 ? (
        <p className="mt-3 text-[13.5px] text-muted">Not enough history yet.</p>
      ) : (
        <ul className="mt-3 divide-y divide-line">
          {items.map(({m, c}) => (
            <li key={m.symbol} className="flex items-center gap-3 py-2.5 text-[14px]">
              <AssetIcon ticker={m.symbol} size="sm" />
              <span className="flex-1 font-medium">{m.symbol}</span>
              <span className="num text-muted">{`${c.abs >= 0 ? "+" : ""}${num(c.abs)} sh`}</span>
              <span className={cn("num inline-flex w-24 items-center justify-end gap-1 font-medium", c.rel > 0 ? "text-borrow" : c.rel < 0 ? "text-supply" : "text-dim")}>
                <Icon name={c.rel >= 0 ? "arrowUp" : "arrowDown"} size={13} />
                <span className="sr-only">{c.rel >= 0 ? "Up" : "Down"}</span>
                {pct(Math.abs(c.rel), 1)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ApiSection({apiUrl}: {apiUrl: string}) {
  const SNIPPETS: Record<string, string> = {
    curl: `curl ${apiUrl}/v1/markets/NVDA`,
    TypeScript: `import {api} from "@stockline/sdk";\nconst sl = api.createClient("${apiUrl}");\nconst {data} = await sl.markets();\nconsole.log(data.map((m) => [m.symbol, m.borrowed, m.siPctFloat]));`,
    Python: `import requests\nm = requests.get("${apiUrl}/v1/markets").json()\nfor s in m["data"]:\n    print(s["symbol"], s["borrowed"], s["borrowApr"])`,
    WebSocket: `const ws = new WebSocket("${apiUrl.replace(/^http/, "ws")}/v1/stream");\nws.onopen = () => ws.send(JSON.stringify({channel: "market", symbol: "NVDA"}));\nws.onmessage = (e) => console.log(JSON.parse(e.data));`,
  };
  const [lang, setLang] = useState("curl");
  const [copied, setCopied] = useState(false);
  return (
    <section className="panel space-y-4 p-5" aria-labelledby="built">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="built" className="t-title">
            Built on this data
          </h2>
          <p className="mt-1 text-[13.5px] text-muted">Free public API: 60 requests a minute, or 600 with a key (sign in with a wallet). Data as is, attribution requested.</p>
        </div>
        <a href={`${apiUrl}/v1/openapi.json`} className="inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-[14px] shadow-[inset_0_0_0_1px_rgba(141,127,242,0.9)] hover:bg-white/[0.06]">
          API docs (OpenAPI 3.1) <Icon name="external" size={13} />
        </a>
      </div>
      <Segmented label="Language" value={lang} onChange={setLang} options={Object.keys(SNIPPETS).map((k) => ({value: k, label: k}))} />
      <div className="relative">
        <pre className="overflow-x-auto rounded-sm bg-sunken p-4 pr-14 text-[12.5px] leading-relaxed text-dim shadow-[inset_0_0_0_1px_var(--border)]">
          <code className="font-mono">{SNIPPETS[lang]}</code>
        </pre>
        <Button
          variant="ghost"
          size="sm"
          className="absolute right-2 top-2"
          onClick={() => void navigator.clipboard?.writeText(SNIPPETS[lang]).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1500)))}
          aria-label="Copy code"
        >
          <Icon name={copied ? "check" : "copy"} size={14} className={copied ? "text-success" : undefined} />
        </Button>
      </div>
    </section>
  );
}
