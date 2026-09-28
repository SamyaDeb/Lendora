import type {ReactNode} from "react";
import {cn} from "@/lib/cn";

/** Label / value pair inside a <dl>. `hint` is a visible sub-line (never tooltip-only). */
export function Stat({label, value, hint, testId, size = "md", tone, className}: {label: ReactNode; value: ReactNode; hint?: ReactNode; testId?: string; size?: "sm" | "md" | "lg"; tone?: "supply" | "borrow" | "weekend" | "caution" | "danger"; className?: string}) {
  const toneCls = tone ? {supply: "text-supply", borrow: "text-borrow", weekend: "text-weekend", caution: "text-caution", danger: "text-danger"}[tone] : "text-fg";
  return (
    <div className={cn("min-w-0", className)}>
      <dt className="t-label">{label}</dt>
      <dd className={cn("num mt-1 font-medium", {sm: "text-[14px]", md: "text-[17px]", lg: "text-[26px] leading-tight tracking-[-0.02em]"}[size], toneCls)} data-testid={testId}>
        {value}
      </dd>
      {hint && <dd className="mt-0.5 text-[12px] leading-snug text-muted">{hint}</dd>}
    </div>
  );
}

/** Two-column row used in summaries and the review sheet. */
export function Row({label, value, testId, raw, emphasis}: {label: ReactNode; value: ReactNode; testId?: string; raw?: bigint; emphasis?: boolean}) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2" data-testid={testId} data-wad={raw?.toString()}>
      <dt className="text-[13.5px] text-muted">{label}</dt>
      <dd className={cn("num text-right text-[14px]", emphasis ? "font-semibold text-fg" : "font-medium text-dim")}>{value}</dd>
    </div>
  );
}
