import type {api} from "@lendora/sdk";
import {num} from "@/lib/format";
import {AssetIcon, Stat} from "@/components/ui";

/**
 * FE-R5 on the short-interest dashboard: protocol revenue (the 10% performance fee) per stock over the last 90 days,
 * in Stock Token units and USD at the oracle price of each accrual, plus what was distributed and converted to
 * USDG. Historical and variable (CP-R7): past fees are not a forecast.
 */
export function RevenuePanel({revenue}: {revenue: api.RevenueResponse | undefined}) {
  const r = revenue?.data;
  return (
    <section className="space-y-3" aria-labelledby="revenue-h" data-testid="revenue">
      <div>
        <h2 id="revenue-h" className="t-title">
          Protocol revenue (historical, last 90 days)
        </h2>
        <p className="mt-1 max-w-3xl text-[13.5px] text-muted">
          Lenders keep 90% of borrow interest; 10% is the protocol fee, split between the backstop reserve and the treasury and converted to USDG. Amounts are variable and past fees do not predict future ones.
        </p>
      </div>
      <div className="panel p-5">
        {!r ? (
          <p className="text-[14px] text-muted">Revenue data is not available right now. The data API didn&apos;t respond.</p>
        ) : r.totals.bySymbol.length === 0 ? (
          <p className="text-[14px] text-muted">No fees accrued in this period yet.</p>
        ) : (
          <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <table className="w-full text-[14px]">
              <thead>
                <tr className="text-left text-[13px] text-muted [&>th]:pb-2 [&>th]:font-normal">
                  <th scope="col">Stock</th>
                  <th scope="col" className="text-right">
                    Fees (stock)
                  </th>
                  <th scope="col" className="text-right">
                    Fees (USD)
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {r.totals.bySymbol.map((b) => (
                  <tr key={b.symbol} className="[&>*]:py-2.5">
                    <td>
                      <span className="inline-flex items-center gap-2.5">
                        <AssetIcon ticker={b.symbol} size="sm" />
                        {b.symbol}
                      </span>
                    </td>
                    <td className="num text-right">{num(Number(b.fee), 6)}</td>
                    <td className="num text-right">${num(Number(b.feeUsd))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <dl className="grid grid-cols-3 content-start gap-4 md:border-l md:border-line md:pl-6">
              <Stat label="Total (USD)" size="lg" tone="supply" value={`$${num(Number(r.totals.feeUsd))}`} testId="revenue-total" />
              <Stat label="Distributed" value={`$${num(Number(r.distributed.usd))}`} />
              <Stat label="Converted to USDG" value={`${num(Number(r.converted.usdg))} USDG`} />
            </dl>
          </div>
        )}
      </div>
    </section>
  );
}
