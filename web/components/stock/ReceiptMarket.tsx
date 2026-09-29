"use client";
import {useQuery} from "@tanstack/react-query";
import {browserApi} from "@/lib/api";
import {deployment} from "@/lib/env";
import {num, pct} from "@/lib/format";
import {Badge, Notice, Row} from "@/components/ui";

/**
 * G5 receipt market for `symbol` (A3; 05 §3): borrow USDG against rSTOCK at LLTV 62.5%, behind
 * `NEXT_PUBLIC_FEATURE_RECEIPT_MARKET`. Shows the market and the recursion risk (CL-R12); until the curator's
 * timelocked listing (≥ 30 days after launch, CL-R10) it says so instead of offering anything.
 */
export function ReceiptMarketPanel({symbol}: {symbol: string}) {
  const has = Boolean(deployment().stocks[symbol]?.receipt);
  const q = useQuery({queryKey: ["receipt-markets"], queryFn: () => browserApi().receiptMarkets(), enabled: has, refetchInterval: 15_000});
  if (!has) return null;
  const m = q.data?.data.find((x) => x.symbol === symbol);
  return (
    <section className="space-y-3 rounded-sm bg-sunken p-4 shadow-[inset_0_0_0_1px_var(--border)]" data-testid="receipt-market">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[14px] font-medium text-fg">Borrow USDG against r{symbol}</h3>
        <Badge tone={m?.listed ? "success" : "neutral"}>{m?.listed ? "Listed" : "Not listed yet"}</Badge>
      </div>
      <dl className="space-y-1.5">
        <Row label="Max loan-to-value (LLTV)" value={m ? pct(Number(m.lltv), 1) : "–"} />
        <Row label="USDG lent in the market" value={m ? `${num(Number(m.supplied))} USDG` : "–"} />
        <Row label="Borrowed" value={m ? `${num(Number(m.borrowed))} USDG` : "–"} />
        <Row label="Utilization (variable)" value={m ? pct(Number(m.utilization), 1) : "–"} />
      </dl>
      <Notice tone="warn" title="Two risks stack here">
        r{symbol} is worth less if {symbol} falls <em>and</em> if the {symbol} lending vault can&apos;t return liquidity. Both can lower
        your collateral at once, and a liquidator may take your r{symbol} (CL-R12).
      </Notice>
      {!m?.listed && (
        <p className="text-[13px] text-muted" data-testid="receipt-not-listed">
          This market opens through a 48-hour curator timelock, at least 30 days after the {symbol} market launched with no guard
          incident.
        </p>
      )}
    </section>
  );
}
