"use client";
import type {ClaimFlow} from "@/lib/vault/useWithdrawFlow";
import {et} from "@/lib/format";
import {usdgAmt} from "@/lib/vault";
import {Row} from "@/components/ui";
import {ReviewSheet} from "@/components/review/ReviewSheet";

/** The claim review, owned by the page (not the card), so it stays open after the request disappears. */
export function ClaimSheet({f, stale}: {f: ClaimFlow; stale?: boolean}) {
  const r = f.target;
  if (!r) return null;
  return (
    <ReviewSheet
      open={f.open}
      onOpenChange={f.setOpen}
      title="Claim your withdrawal"
      confirmLabel={`Claim ${usdgAmt(r.assets)} USDG`}
      successTitle={`Claimed ${usdgAmt(r.assets)} USDG`}
      successBody="The USDG is in your wallet."
      summary={
        <>
          <Row label="You claim" value={`${usdgAmt(r.assets)} USDG`} emphasis />
          <Row label="Requested" value={et(Date.parse(r.requestedAt) / 1000)} />
          <Row label="Settled" value={et(Date.parse(r.settlesAt) / 1000)} />
        </>
      }
      notes={stale ? "The vault's price data is stale right now. That doesn't affect this claim: the amount was fixed when the request settled." : undefined}
      plan={f.plan}
      steps={f.steps.states}
      busy={f.steps.busy}
      error={f.steps.error}
      onConfirm={f.confirm}
    />
  );
}
