"use client";
import {useMemo, useState} from "react";
import Link from "next/link";
import {useQuery} from "@tanstack/react-query";
import {browserApi, type Market} from "@/lib/api";
import {num, pct, usd} from "@/lib/format";
import {Empty} from "./ui";

type Resp = Awaited<ReturnType<ReturnType<typeof browserApi>["markets"]>>;
const COLS: {key: string; label: string; val: (m: Market) => number; show: (m: Market) => string}[] = [
  {key: "borrowed", label: "Short interest (shares)", val: (m) => Number(m.borrowed), show: (m) => num(Number(m.borrowed))},
  {key: "borrowedUsd", label: "Short interest (USD)", val: (m) => Number(m.borrowedUsd), show: (m) => usd(m.borrowedUsd, 0)},
  {key: "siPctFloat", label: "% of float", val: (m) => Number(m.siPctFloat), show: (m) => pct(m.siPctFloat, 3)},
  {key: "utilization", label: "Utilization", val: (m) => Number(m.utilization), show: (m) => pct(m.utilization)},
  {key: "borrowApr", label: "Borrow APR", val: (m) => Number(m.borrowApr), show: (m) => pct(m.borrowApr)},
  {key: "change", label: "24h change", val: (m) => Number(m.newShorts24h) - Number(m.covered24h), show: (m) => `${Number(m.newShorts24h) - Number(m.covered24h) >= 0 ? "+" : ""}${num(Number(m.newShorts24h) - Number(m.covered24h))}`},
  {key: "dtc", label: "Days to cover", val: (m) => m.daysToCover ?? -1, show: (m) => (m.daysToCover === null ? "–" : num(m.daysToCover, 1))},
];

/** 07 §4 leaderboard, sortable, refreshed every 5 s. */
export function Leaderboard({initial}: {initial?: Resp}) {
  const q = useQuery({queryKey: ["markets"], queryFn: () => browserApi().markets(), initialData: initial, refetchInterval: 5000});
  const [sort, setSort] = useState({key: "borrowedUsd", desc: true});
  const rows = useMemo(() => {
    const col = COLS.find((c) => c.key === sort.key)!;
    return [...(q.data?.data ?? [])].sort((a, b) => (sort.desc ? col.val(b) - col.val(a) : col.val(a) - col.val(b)));
  }, [q.data, sort]);
  if (!q.data) return <Empty title="Short-interest data is temporarily unavailable" />;
  return (
    <div className="card overflow-x-auto">
      <table className="w-full min-w-[760px] text-sm" data-testid="leaderboard">
        <caption className="sr-only">Short interest by stock</caption>
        <thead className="border-b border-[var(--color-line)] text-xs text-[var(--color-muted)]">
          <tr>
            <th scope="col" className="px-3 py-2 text-left">
              Stock
            </th>
            {COLS.map((c) => (
              <th key={c.key} scope="col" className="px-3 py-2 text-right" aria-sort={sort.key === c.key ? (sort.desc ? "descending" : "ascending") : "none"}>
                <button className="font-semibold" onClick={() => setSort((s) => ({key: c.key, desc: s.key === c.key ? !s.desc : true}))}>
                  {c.label}
                  {sort.key === c.key ? (sort.desc ? " ↓" : " ↑") : ""}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((m) => (
            <tr key={m.symbol} className="border-b border-[var(--color-line)] last:border-0">
              <th scope="row" className="px-3 py-3 text-left font-semibold">
                <Link href={`/market/${m.symbol}`} className="underline-offset-2 hover:underline">
                  {m.symbol}
                </Link>
              </th>
              {COLS.map((c) => (
                <td key={c.key} className="num px-3 py-3 text-right">
                  {c.show(m)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="px-3 py-2 text-xs text-[var(--color-muted)]">
        As of block {q.data.asOfBlock}
        {q.data.confirmed ? " (final)" : " (not yet final)"}.
      </p>
    </div>
  );
}
