import type {api} from "@stockline/sdk";
import {num} from "@/lib/format";

/**
 * FE-R5 on the short-interest dashboard: protocol revenue (the 10% performance fee) per stock over the last 90 days,
 * in Stock Token units and USD at the oracle price of each accrual, plus what was distributed and converted to
 * USDG. Historical and variable (CP-R7): past fees are not a forecast.
 */
export function RevenuePanel({revenue}: {revenue: api.RevenueResponse | undefined}) {
  const r = revenue?.data;
  return (
    <section className="card space-y-3 p-4" aria-labelledby="revenue-h" data-testid="revenue">
      <h2 id="revenue-h" className="font-semibold">
        Protocol revenue (historical, last 90 days)
      </h2>
      <p className="text-sm text-[var(--color-muted)]">
        Lenders keep 90% of borrow interest; 10% is the protocol fee, split between the backstop reserve and the treasury and converted to USDG. Amounts are variable and past fees do not predict future ones.
      </p>
      {!r ? (
        <p className="text-sm">Revenue data is not available right now.</p>
      ) : r.totals.bySymbol.length === 0 ? (
        <p className="text-sm">No fees accrued in this period yet.</p>
      ) : (
        <>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-[var(--color-muted)]">
                <th scope="col">Stock</th>
                <th scope="col" className="text-right">
                  Fees (stock)
                </th>
                <th scope="col" className="text-right">
                  Fees (USD)
                </th>
              </tr>
            </thead>
            <tbody>
              {r.totals.bySymbol.map((b) => (
                <tr key={b.symbol}>
                  <td>{b.symbol}</td>
                  <td className="num text-right">{num(Number(b.fee), 6)}</td>
                  <td className="num text-right">${num(Number(b.feeUsd))}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <dl className="grid grid-cols-3 gap-3 text-sm">
            <div>
              <dt className="text-xs text-[var(--color-muted)]">Total (USD)</dt>
              <dd className="num font-semibold" data-testid="revenue-total">
                ${num(Number(r.totals.feeUsd))}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-[var(--color-muted)]">Distributed</dt>
              <dd className="num font-semibold">${num(Number(r.distributed.usd))}</dd>
            </div>
            <div>
              <dt className="text-xs text-[var(--color-muted)]">Converted to USDG</dt>
              <dd className="num font-semibold">{num(Number(r.converted.usdg))} USDG</dd>
            </div>
          </dl>
        </>
      )}
    </section>
  );
}
