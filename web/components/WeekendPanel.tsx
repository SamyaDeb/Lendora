"use client";
import {useQuery} from "@tanstack/react-query";
import {usePublicClient} from "wagmi";
import {getExternal, priceFromTick, twapTick, uniswapV3PoolAbi} from "@stockline/sdk";
import {deployment} from "@/lib/env";
import type {Market} from "@/lib/api";
import {num, pct} from "@/lib/format";
import {StatusBadge} from "./ui";

/** 07 §4 weekend panel: the Stock Token's DEX price (30-min TWAP, the guard keeper's view) vs the Chainlink reference,
 * the premium, and the buffer in force. */
export function WeekendPanel({markets}: {markets: Market[]}) {
  const pc = usePublicClient();
  const d = deployment();
  const q = useQuery({
    queryKey: ["dex", markets.map((m) => m.symbol).join()],
    enabled: Boolean(pc),
    refetchInterval: 15_000,
    queryFn: async () => {
      const out: Record<string, number | null> = {};
      for (const m of markets) {
        const pool = d.mocks?.[`${m.symbol}_USDG_pool`] ?? getExternal(4663)?.uniswapV3Pools[`${m.symbol}_USDG_500`];
        if (!pool || !pc) {
          out[m.symbol] = null;
          continue;
        }
        try {
          const [token0, cums] = await Promise.all([
            pc.readContract({address: pool, abi: uniswapV3PoolAbi, functionName: "token0"}),
            pc.readContract({address: pool, abi: uniswapV3PoolAbi, functionName: "observe", args: [[1800, 0]]}),
          ]);
          const tick = twapTick(cums[0][1], cums[0][0], 1800);
          out[m.symbol] = priceFromTick(tick, token0.toLowerCase() === d.stocks[m.symbol].stockToken.toLowerCase(), 18, 6);
        } catch {
          out[m.symbol] = null;
        }
      }
      return out;
    },
  });
  return (
    <section className="card p-4" aria-labelledby="wk">
      <h2 id="wk" className="mb-2 font-semibold">
        Weekend panel
      </h2>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm">
          <thead className="text-xs text-[var(--color-muted)]">
            <tr>
              <th scope="col" className="py-2 text-left">
                Stock
              </th>
              <th scope="col" className="py-2 text-right">
                DEX (30m TWAP)
              </th>
              <th scope="col" className="py-2 text-right">
                Chainlink
              </th>
              <th scope="col" className="py-2 text-right">
                Premium
              </th>
              <th scope="col" className="py-2 text-right">
                Buffer in force
              </th>
              <th scope="col" className="py-2 text-left pl-3">
                Status
              </th>
            </tr>
          </thead>
          <tbody>
            {markets.map((m) => {
              const feed = Number(m.price.usdPerToken);
              const dex = q.data?.[m.symbol] ?? null;
              return (
                <tr key={m.symbol} className="border-t border-[var(--color-line)]">
                  <th scope="row" className="py-2 text-left">
                    {m.symbol}
                  </th>
                  <td className="num py-2 text-right">{dex === null ? "–" : `$${num(dex)}`}</td>
                  <td className="num py-2 text-right">${num(feed)}</td>
                  <td className="num py-2 text-right">{dex === null ? "–" : pct(dex / feed - 1)}</td>
                  <td className="num py-2 text-right">{pct(m.buffer)}</td>
                  <td className="py-2 pl-3">
                    <StatusBadge status={m.marketStatus} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
