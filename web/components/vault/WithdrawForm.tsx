"use client";
import {useState} from "react";
import type {WithdrawFlow} from "@/lib/vault/useWithdrawFlow";
import type {WithdrawPreview} from "@/lib/vault";
import {useChainNow} from "@/lib/chainNow";
import {countdown} from "@/lib/session";
import {et, num} from "@/lib/format";
import {usdgAmt} from "@/lib/vault";
import {AmountInput, Button, Notice, Row} from "@/components/ui";
import {ReviewSheet} from "@/components/review/ReviewSheet";
import {VaultGate} from "./VaultGate";

/** "3,000 USDG now · 2,000 USDG queued, paid by Mon 09:30 ET (2d 4h)", on chain time. */
export function WithdrawSplit({pv, asOf, fetchedAt}: {pv: WithdrawPreview; asOf?: string; fetchedAt?: number}) {
  const now = useChainNow(asOf, fetchedAt ?? 0);
  const ts = pv.settlesAt ? Math.floor(Date.parse(pv.settlesAt) / 1000) : undefined;
  return (
    <p className="num text-[13.5px] leading-snug text-dim" data-testid="withdraw-split" aria-live="polite">
      {pv.instant > 0 && <strong className="font-semibold text-fg">{usdgAmt(pv.instant)} USDG now</strong>}
      {pv.instant > 0 && pv.queued > 0 && " · "}
      {pv.queued > 0 && (
        <>
          <strong className="font-semibold text-fg">{usdgAmt(pv.queued)} USDG queued</strong>
          {ts && (
            <>
              , paid by {et(ts)} <span suppressHydrationWarning>({countdown(ts, now)})</span>
            </>
          )}
        </>
      )}
    </p>
  );
}

/** Withdraw (an exit): Max = your value; the live split says what arrives now and what is queued until when. */
export function WithdrawForm({f}: {f: WithdrawFlow}) {
  const [review, setReview] = useState(false);
  const {o, u, pv} = f;
  const settles = pv?.settlesAt ? et(Date.parse(pv.settlesAt) / 1000) : undefined;
  const showBlocker = Boolean(f.blocker) && !(f.amount === "" && f.blocker!.startsWith("Enter how much")) && !f.blocker!.startsWith("Loading");
  const body = !pv ? "" : pv.queued === 0 ? `${usdgAmt(pv.instant)} USDG is in your wallet.` : `${pv.instant > 0 ? `${usdgAmt(pv.instant)} USDG is in your wallet. ` : ""}${usdgAmt(pv.queued)} USDG is queued; claim it here or from your portfolio after ${settles}.`;
  return (
    <div className="space-y-4" data-testid="withdraw-form">
      {o?.nav.stale && (
        <Notice tone="warn" title="Instant withdrawals are paused">
          The vault&apos;s price data is stale, so anything you withdraw now joins the queue. Settled requests can still be claimed.
        </Notice>
      )}
      <AmountInput label="Amount to withdraw" value={f.amount} onChange={f.setAmount} decimals={6} unit="USDG" usdPrice={1} max={u ? BigInt(Math.floor(u.value * 1e6)) : undefined} maxLabel="Your balance" testId="withdraw-amount" disabled={!f.address} />
      {pv && f.assets > 0 ? <WithdrawSplit pv={pv} asOf={o?.asOf.time} fetchedAt={f.fetchedAt} /> : <p className="text-[13px] text-muted">Instant up to the cash buffer{o ? ` (${num(o.instantCapacity, 0)} USDG now)` : ""}; more is queued for up to 72 hours or until the next US market open.</p>}
      <VaultGate pinned={f.pinned}>
        <div className="space-y-2">
          <Button size="lg" variant="secondary" className="w-full" disabled={Boolean(f.blocker) || f.steps.busy} onClick={() => setReview(true)} data-testid="withdraw-submit">
            Review withdrawal
          </Button>
          {showBlocker && (
            <p className="text-[13px] text-caution" data-testid="withdraw-blocker">
              {f.blocker}
            </p>
          )}
        </div>
      </VaultGate>
      <ReviewSheet
        open={review}
        onOpenChange={setReview}
        title="Review withdrawal"
        confirmLabel={pv && pv.queued > 0 && pv.instant === 0 ? `Request ${usdgAmt(pv.queued)} USDG` : `Withdraw ${f.a} USDG`}
        successTitle={!pv ? "Done" : pv.queued === 0 ? `Withdrew ${usdgAmt(pv.instant)} USDG` : pv.instant === 0 ? `Requested ${usdgAmt(pv.queued)} USDG` : `Withdrew ${usdgAmt(pv.instant)} USDG · ${usdgAmt(pv.queued)} USDG queued`}
        successBody={body}
        summary={
          <>
            <Row label="You withdraw" value={`${f.a || "0"} USDG`} emphasis />
            <Row label="Paid now" value={pv ? `${usdgAmt(pv.instant)} USDG` : "–"} testId="rv-instant" />
            {pv && pv.queued > 0 && <Row label="Queued" value={`${usdgAmt(pv.queued)} USDG`} testId="rv-queued" />}
            {pv && pv.queued > 0 && <Row label="Paid by" value={settles} />}
            {u && <Row label="Left in the vault" value={`${num(Math.max(0, u.value - f.assets))} USDG`} />}
          </>
        }
        notes={
          pv && pv.queued > 0 ? (
            <p data-testid="rv-queue-note">
              {pv.instant > 0 ? `${usdgAmt(pv.instant)} USDG arrives as soon as you confirm. ` : ""}
              The queued {usdgAmt(pv.queued)} USDG is paid by {settles} (72 hours or the next US market open, whichever is later), then you claim it.
              {o?.nav.stale && " Instant withdrawals are paused while the vault's price data is stale, so the whole amount waits in the queue."}
              {o?.venue.status === "halted" && " The perp venue has halted withdrawals, so the queue may take longer."}
            </p>
          ) : undefined
        }
        plan={f.plan}
        steps={f.steps.states}
        busy={f.steps.busy}
        error={f.steps.error}
        blocker={f.blocker}
        onConfirm={f.confirm}
      />
    </div>
  );
}
