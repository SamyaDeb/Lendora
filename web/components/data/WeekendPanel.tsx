"use client";
import {useQuery} from "@tanstack/react-query";
import {usePublicClient} from "wagmi";
import {getExternal, priceFromTick, twapTick, uniswapV3PoolAbi} from "@stockline/sdk";
import {deployment} from "@/lib/env";
import type {Market} from "@/lib/api";
import {num, pct} from "@/lib/format";
import {StatusBadge} from "@/components/ui";

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
    <section className="space-y-3" aria-labelledby="wk">
      <div>
        <h2 id="wk" className="t-title">
          Weekend panel
        </h2>
        <p className="mt-1 text-[13.5px] text-muted">The Stock Token&apos;s DEX price (30-minute TWAP) vs the Chainlink reference, the premium, and the safety buffer the oracle adds while markets are closed.</p>
      </div>
      <div className="panel overflow-x-auto">
        <table className="w-full min-w-[620px] border-separate border-spacing-0 text-[14px]">
          <thead>
            <tr className="[&>th]:border-b [&>th]:border-line [&>th]:px-4 [&>th]:py-3 [&>th]:text-[13px] [&>th]:font-normal [&>th]:text-muted">
              <th scope="col" className="text-left">Stock</th>
              <th scope="col" className="text-right">DEX (30m TWAP)</th>
              <th scope="col" className="text-right">Chainlink</th>
              <th scope="col" className="text-right">Premium</th>
              <th scope="col" className="text-right">Buffer in force</th>
              <th scope="col" className="text-left">Status</th>
            </tr>
          </thead>
          <tbody>
            {markets.map((m) => {
              const feed = Number(m.price.usdPerToken);
              const dex = q.data?.[m.symbol] ?? null;
              return (
                <tr key={m.symbol} className="[&>*]:border-b [&>*]:border-line [&>*]:px-4 [&>*]:py-3 last:[&>*]:border-0">
                  <th scope="row" className="text-left font-medium">{m.symbol}</th>
                  <td className="num text-right">{dex === null ? "–" : `$${num(dex)}`}</td>
                  <td className="num text-right">${num(feed)}</td>
                  <td className="num text-right">{dex === null ? "–" : pct(dex / feed - 1)}</td>
                  <td className={`num text-right ${Number(m.buffer) > 0 ? "text-weekend" : ""}`}>{pct(m.buffer)}</td>
                  <td>
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
