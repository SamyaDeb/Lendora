"use client";
import {useState} from "react";
import Link from "next/link";
import {earnings, usdgAmt} from "@/lib/vault";
import {useVaultOverview, useVaultUser} from "@/lib/vault/hooks";
import {useClaimFlow, useReadyToasts, useWithdrawFlow} from "@/lib/vault/useWithdrawFlow";
import {num} from "@/lib/format";
import {AssetIcon, Badge, Button, ButtonLink, EmptyState, Icon, Sheet, Skeleton, Stat} from "@/components/ui";
import {WithdrawRequestCard} from "./WithdrawRequestCard";
import {WithdrawForm} from "./WithdrawForm";
import {ClaimSheet} from "./ClaimSheet";

/**
 * Portfolio · USDG Earn: value, earnings, shares, open withdrawal requests with Claim, and Withdraw. Exits (CP-R4):
 * restricted visitors reach this page (proxy EXIT_OK) but not /vault, so the withdraw form lives here too.
 */
export function VaultPortfolioSection({restricted}: {restricted: boolean}) {
  const o = useVaultOverview();
  const uq = useVaultUser();
  const u = uq.data;
  const claim = useClaimFlow();
  const withdraw = useWithdrawFlow();
  const [sheet, setSheet] = useState(false);
  useReadyToasts(u);
  const open = u ? u.requests.filter((r) => r.status !== "claimed") : [];
  const active = Boolean(u && (u.shares > 0 || open.length > 0));
  const earned = u ? earnings(u) : undefined;

  return (
    <section className="space-y-3" aria-label="USDG Earn" data-testid="portfolio-vault">
      {active && (
        <h2 className="t-label flex items-center gap-2">
          <span className="size-2 rounded-full bg-supply" aria-hidden /> USDG Earn
        </h2>
      )}
      {!u && uq.isPending ? (
        <div className="panel space-y-4 p-5" aria-busy="true">
          <Skeleton className="block h-5 w-40" />
          <Skeleton className="block h-12 w-full" />
        </div>
      ) : !active ? (
        <EmptyState title="No USDG Earn position" icon="layers" action={!restricted && <ButtonLink href="/vault" variant="secondary">See USDG Earn</ButtonLink>}>
          Earn lending fees and perp funding on USDG, hedged against stock price moves. Variable; see the risks on its page.
        </EmptyState>
      ) : (
        u && (
          <article className="panel space-y-5 p-5" aria-labelledby="vault-pos-h" data-testid="vault-position">
            <header className="flex flex-wrap items-center gap-3">
              <AssetIcon ticker="USDG" kind="usd" />
              <div className="min-w-0 flex-1">
                <h3 id="vault-pos-h" className="text-[17px] font-medium">
                  USDG Earn
                </h3>
                <p className="text-[13px] text-muted">Delta-neutral USDG vault · lending fees + perp funding</p>
              </div>
              <Badge tone={u.shares > 0 ? "supply" : "neutral"} icon={u.shares > 0 ? "trendUp" : "clock"}>
                {u.shares > 0 ? "Earning" : "Withdrawing"}
              </Badge>
            </header>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
              <Stat size="sm" label="Value" value={`${num(u.value)} USDG`} testId="vault-value" />
              <Stat size="sm" label="Earned" tone={earned !== undefined ? "supply" : undefined} value={earned !== undefined ? `${earned < 0 ? "−" : "+"}${num(Math.abs(earned))} USDG` : "–"} hint={earned === undefined ? "Waiting for the indexer" : undefined} />
              <Stat size="sm" label="Shares" value={num(u.shares, 4)} hint={o.data ? `At ${num(o.data.sharePrice, 4)} USDG` : undefined} />
              <Stat size="sm" label="Net APY (30d, variable)" tone="supply" value={o.data && o.data.apy.d30 !== null ? `${num(o.data.apy.d30 * 100)}%` : "–"} hint="Historical" />
            </dl>
            {open.length > 0 && (
              <div className="grid gap-3 md:grid-cols-2">
                {open.map((r) => (
                  <WithdrawRequestCard key={r.id} r={r} asOf={o.data?.asOf.time} fetchedAt={o.dataUpdatedAt} onClaim={claim.start} busy={claim.steps.busy} />
                ))}
              </div>
            )}
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
              {!restricted ? (
                <Link href="/vault" className="inline-flex items-center gap-1 text-[13.5px] text-accent-text hover:underline">
                  Open USDG Earn <Icon name="chevronRight" size={13} />
                </Link>
              ) : (
                <span className="text-[13px] text-muted">Deposits aren&apos;t available in your region. Withdrawals and claims are.</span>
              )}
              {u.shares > 0 && (
                <Button variant="secondary" onClick={() => setSheet(true)} data-testid="vault-withdraw-open">
                  Withdraw
                </Button>
              )}
            </div>
          </article>
        )
      )}
      <Sheet open={sheet} onOpenChange={setSheet} title="Withdraw from USDG Earn" description={u ? `Your balance: ${usdgAmt(u.value)} USDG` : undefined}>
        <WithdrawForm f={withdraw} />
      </Sheet>
      <ClaimSheet f={claim} stale={o.data?.nav.stale} />
    </section>
  );
}
