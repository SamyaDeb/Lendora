import {cn} from "@/lib/cn";

/**
 * Asset icon: the landing page's glass tile with the ticker set in type. No company logos (none are licensed in the
 * repo). Receipt tokens (rNVDA) and USDG get the same tile with their own ring color.
 */
export function AssetIcon({ticker, size = "md", kind = "stock", className}: {ticker: string; size?: "sm" | "md" | "lg"; kind?: "stock" | "receipt" | "usd"; className?: string}) {
  const box = {sm: "size-7 text-[10px] rounded-[7px]", md: "size-9 text-[11px] rounded-[8px]", lg: "size-12 text-[14px] rounded-[10px]"}[size];
  const ring = kind === "receipt" ? "shadow-[inset_0_0_0_1px_rgba(89,217,122,0.45)]" : kind === "usd" ? "shadow-[inset_0_0_0_1px_rgba(169,156,246,0.5)]" : "shadow-[inset_0_0_0_1px_rgba(255,255,255,0.2)]";
  const label = ticker.length > 4 ? ticker.slice(0, 4) : ticker;
  return (
    <span aria-hidden className={cn("inline-grid shrink-0 place-items-center bg-white/[0.09] font-semibold tracking-[-0.02em] text-fg", box, ring, className)}>
      {label}
    </span>
  );
}
