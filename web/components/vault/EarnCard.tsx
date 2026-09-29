"use client";
import Link from "next/link";
import {pct} from "@/lib/format";
import {useVaultOverview} from "@/lib/vault/hooks";
import {AssetIcon, Icon, Skeleton} from "@/components/ui";

/** Markets board entry to USDG Earn: the net APY with its window and "variable" (CP-R7), and where it comes from. */
export function EarnCard({apy}: {apy?: number | null}) {
  return (
    <Link
      href="/vault"
      className="pressable panel flex min-h-[64px] items-center gap-3.5 px-4 py-3 hover:shadow-[var(--ring-hover)] sm:px-5"
      data-testid="earn-card"
    >
      <AssetIcon ticker="USDG" kind="usd" />
      <span className="min-w-0 flex-1 text-[14.5px] leading-snug">
        <span className="font-medium text-fg">USDG Earn</span>
        <span className="text-muted"> · </span>
        {apy === null ? <span className="num text-dim">–</span> : apy !== undefined ? <span className="num font-medium text-supply">{pct(apy)}</span> : <Skeleton className="h-4 w-12 align-middle" />}
        <span className="text-dim"> net APY (30d, variable)</span>
        <span className="text-muted"> · lending fees + perp funding</span>
      </span>
      <Icon name="chevronRight" size={16} className="shrink-0 text-muted" />
    </Link>
  );
}

/** EarnCard on the vault source's overview. */
export function EarnCardLive() {
  const o = useVaultOverview();
  return <EarnCard apy={o.data?.apy.d30} />;
}
