import {num} from "@/lib/format";

/**
 * The only yield estimate allowed (CP-R7): what the typed amount earns in a year at today's variable rate, always
 * with "(variable, not a forecast)". Hidden while the amount is empty.
 */
export function EarnEstimate({amount, apy, unit = "USDG"}: {amount?: number; apy?: number; unit?: string}) {
  if (!amount || !(amount > 0) || apy === undefined || !Number.isFinite(apy)) return null;
  return (
    <p className="num text-[13px] text-dim" data-testid="earn-estimate">
      At today&apos;s rate ≈ {num(amount * apy)} {unit} a year <span className="text-muted">(variable, not a forecast)</span>
    </p>
  );
}
