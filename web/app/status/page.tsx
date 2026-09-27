import {safe, serverApi} from "@/lib/api";
import {Notice, StatusBadge} from "@/components/ui";

export const metadata = {title: "Status"};

/** APP-R4 link target: oracle freshness, guard state and indexer lag (API /v1/status). */
export default async function StatusPage() {
  const s = await safe(serverApi().status());
  if (!s) return <Notice tone="warn" title="Status is unavailable">The data API did not respond. The contracts keep working; exits never depend on it.</Notice>;
  const d = s.data;
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Status</h1>
      <p className="text-sm text-[var(--color-muted)]">
        Chain {d.chainId}. Indexer at block {d.indexer.headBlock}
        {d.indexer.lagBlocks !== null ? `, ${d.indexer.lagBlocks} blocks behind the chain` : ""}. Final up to block {d.indexer.finalizedBlock}.
      </p>
      <div className="card overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm">
          <thead className="text-xs text-[var(--color-muted)]">
            <tr>
              <th scope="col" className="px-3 py-2 text-left">
                Stock
              </th>
              <th scope="col" className="px-3 py-2 text-left">
                Market
              </th>
              <th scope="col" className="px-3 py-2 text-right">
                Price
              </th>
              <th scope="col" className="px-3 py-2 text-right">
                Price age
              </th>
              <th scope="col" className="px-3 py-2 text-left">
                Guard
              </th>
            </tr>
          </thead>
          <tbody>
            {d.markets.map((m) => (
              <tr key={m.symbol} className="border-t border-[var(--color-line)]">
                <th scope="row" className="px-3 py-2 text-left">
                  {m.symbol}
                </th>
                <td className="px-3 py-2">
                  <StatusBadge status={m.marketStatus} />
                </td>
                <td className="num px-3 py-2 text-right">${Number(m.oracle.usdPerToken).toFixed(2)}</td>
                <td className="num px-3 py-2 text-right">
                  {Math.round(m.oracle.ageSec / 60)} min{m.oracle.stale ? " (stale)" : m.oracle.sessionOpen ? "" : " (feed closed)"}
                </td>
                <td className="px-3 py-2">{m.guard.tripped ? `Tripped: ${m.guard.reasons.join(", ")}` : "OK"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
