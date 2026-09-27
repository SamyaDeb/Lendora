import {MarketsTable} from "@/components/MarketsTable";
import {safe, serverApi} from "@/lib/api";

export default async function MarketsPage() {
  const initial = await safe(serverApi().markets());
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Markets</h1>
        <p className="text-sm text-[var(--color-muted)]">Lend Stock Tokens to earn a variable yield, or borrow them to short or hedge. Rates move with utilization.</p>
      </div>
      <MarketsTable initial={initial} />
    </div>
  );
}
