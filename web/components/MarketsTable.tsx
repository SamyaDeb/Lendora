"use client";
import {useMemo, useState} from "react";
import Link from "next/link";
import {useQuery} from "@tanstack/react-query";
import {browserApi, type Market} from "@/lib/api";
import {num, pct, usd} from "@/lib/format";
import {Empty, StatusBadge} from "./ui";

type Key = "utilization" | "borrowApr" | "supplyApy" | "borrowedUsd";
type MarketsResponse = Awaited<ReturnType<ReturnType<typeof browserApi>["markets"]>>;

/** 06 `/`: table per stock, sortable (default: utilization). Refreshes every 5 s. */
export function MarketsTable({initial}: {initial?: MarketsResponse}) {
  const q = useQuery({queryKey: ["markets"], queryFn: () => browserApi().markets(), initialData: initial, refetchInterval: 5000});
  const [sort, setSort] = useState<{key: Key; desc: boolean}>({key: "utilization", desc: true});
  const rows = useMemo(() => {
    const data = [...(q.data?.data ?? [])];
    const val = (m: Market) => Number(m[sort.key]);
    return data.sort((a, b) => (sort.desc ? val(b) - val(a) : val(a) - val(b)));
  }, [q.data, sort]);
  if (!q.data) return q.isError ? <Empty title="Market data is temporarily unavailable">The API did not respond. Positions still work from the chain.</Empty> : <Empty title="Loading markets…" />;
  const th = (key: Key, label: string) => (
    <th scope="col" className="px-3 py-2 text-right" aria-sort={sort.key === key ? (sort.desc ? "descending" : "ascending") : "none"}>
      <button className="font-semibold underline-offset-2 hover:underline" onClick={() => setSort((s) => ({key, desc: s.key === key ? !s.desc : true}))}>
        {label}
        {sort.key === key ? (sort.desc ? " ↓" : " ↑") : ""}
      </button>
    </th>
  );
  return (
    <div className="card overflow-x-auto">
      <table className="w-full min-w-[720px] text-sm" data-testid="markets">
        <caption className="sr-only">Stockline markets</caption>
        <thead className="border-b border-[var(--color-line)] text-xs text-[var(--color-muted)]">
          <tr>
            <th scope="col" className="px-3 py-2 text-left">
              Stock
            </th>
            <th scope="col" className="px-3 py-2 text-right">
              Price
            </th>
            <th scope="col" className="px-3 py-2 text-right">
              Supplied
            </th>
            {th("borrowedUsd", "Borrowed")}
            {th("utilization", "Utilization")}
            {th("supplyApy", "Supply APY (variable)")}
            {th("borrowApr", "Borrow APR (variable)")}
            <th scope="col" className="px-3 py-2 text-left">
              Status
            </th>
            <th scope="col" className="px-3 py-2">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((m) => (
            <tr key={m.symbol} className="border-b border-[var(--color-line)] last:border-0" data-symbol={m.symbol}>
              <th scope="row" className="px-3 py-3 text-left font-semibold">
                <Link href={`/market/${m.symbol}`} className="underline-offset-2 hover:underline">
                  {m.symbol}
                </Link>
              </th>
              <td className="num px-3 py-3 text-right">{usd(m.price.usdPerShare)}</td>
              <td className="num px-3 py-3 text-right">{num(Number(m.supplied), 2)}</td>
              <td className="num px-3 py-3 text-right">
                {num(Number(m.borrowed), 2)} <span className="text-[var(--color-muted)]">({usd(m.borrowedUsd, 0)})</span>
              </td>
              <td className="num px-3 py-3 text-right" data-col="utilization">
                {pct(m.utilization)}
              </td>
              <td className="num px-3 py-3 text-right">{pct(m.supplyApy)}</td>
              <td className="num px-3 py-3 text-right">{pct(m.borrowApr)}</td>
              <td className="px-3 py-3">
                <StatusBadge status={m.marketStatus} />
              </td>
              <td className="px-3 py-3 text-right whitespace-nowrap">
                <Link href={`/lend/${m.symbol}`} className="btn btn-ghost mr-2">
                  Lend
                </Link>
                <Link href={`/short/${m.symbol}`} className="btn">
                  Borrow
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="px-3 py-2 text-xs text-[var(--color-muted)]">
        As of block {q.data.asOfBlock} ({new Date(q.data.asOfTime).toUTCString()}){q.data.confirmed ? " · final" : " · not yet final"}. Scope: Stockline markets only.
      </p>
    </div>
  );
}
