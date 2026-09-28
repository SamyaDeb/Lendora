"use client";
import {useState} from "react";
import type {DepositFlow} from "@/lib/vault/useDepositFlow";
import {num, pct} from "@/lib/format";
import {amt} from "@/lib/flows/common";
import {AmountInput, Button, EarnEstimate, Icon, Row} from "@/components/ui";
import {ReviewSheet} from "@/components/review/ReviewSheet";
import {NeedFunds, VaultGate, VaultRiskBlock} from "./VaultGate";

export const FEE_LINE = "10% of gains above your previous high. No management fee.";
export const WITHDRAW_RULE = "Instant up to the vault's cash buffer; larger amounts are paid within 72 hours or at the next US market open, whichever is later.";
const TOP_RISKS = [
  "The yield is variable and can fall to zero or below; you can lose money.",
  "The perp venue is a single point of failure for the hedge margin.",
  "Large withdrawals are queued, not instant.",
];

/** Deposit USDG (an entry). The yield sources, fee and withdrawal rule sit next to the button; every block says why. */
export function DepositForm({f}: {f: DepositFlow}) {
  const [review, setReview] = useState(false);
  const {o, u} = f;
  const apy = o?.apy.d30;
  // "Enter an amount" is obvious from the empty field; every other reason is spelled out under the button.
  const showBlocker = Boolean(f.blocker) && !(f.amount === "" && f.blocker!.startsWith("Enter how much"));
  return (
    <div className="space-y-4" data-testid="deposit-form">
      <AmountInput
        label="Amount to deposit"
        value={f.amount}
        onChange={f.setAmount}
        decimals={6}
        unit="USDG"
        usdPrice={1}
        max={u ? BigInt(Math.floor(u.usdgBalance * 1e6)) : undefined}
        maxLabel="Wallet balance"
        testId="deposit-amount"
        disabled={!f.address}
      />
      <div className="space-y-1.5 rounded-sm bg-supply-soft p-3.5 shadow-[inset_0_0_0_1px_rgba(89,217,122,0.22)]">
        <div className="flex items-baseline justify-between gap-3">
          <span className="inline-flex items-center gap-1.5 text-[13.5px] text-dim">
            <Icon name="trendUp" size={15} className="text-supply" /> Net APY (30d, variable)
          </span>
          <span className="num text-[18px] font-medium text-supply">{apy !== undefined ? pct(apy) : "–"}</span>
        </div>
        <p className="text-[12.5px] leading-snug text-muted">Lending fees plus perp funding, in USDG, after costs. Historical; it changes every day.</p>
        <EarnEstimate amount={f.assets} apy={apy} />
        {f.preview && f.assets > 0 && (
          <p className="num text-[13px] text-dim" data-testid="deposit-shares">
            You get ≈ {num(f.preview.shares, 4)} shares at {num(f.preview.sharePrice, 4)}
          </p>
        )}
      </div>
      <p className="text-[12.5px] leading-snug text-muted">
        <span className="text-dim">Fee:</span> {FEE_LINE} <span className="text-dim">Withdrawals:</span> {WITHDRAW_RULE}
      </p>
      <NeedFunds token="USDG" show={Boolean(u && u.usdgBalance === 0)} />
      <VaultGate pinned={f.pinned}>
        <div className="space-y-2">
          <Button size="lg" variant="supply" className="w-full" disabled={Boolean(f.blocker) || f.steps.busy} onClick={() => setReview(true)} data-testid="deposit-submit">
            Review deposit
          </Button>
          {showBlocker && (
            <p className="text-[13px] text-caution" data-testid="deposit-blocker">
              {f.blocker}
            </p>
          )}
        </div>
      </VaultGate>
      <ReviewSheet
        open={review}
        onOpenChange={setReview}
        title="Review deposit"
        confirmLabel={`Deposit ${amt(f.amount)} USDG`}
        successTitle={`Deposited ${amt(f.amount)} USDG`}
        successBody="Your shares are in your position. Withdraw any time: instantly up to the cash buffer, the rest through the queue."
        summary={
          <>
            <Row label="You deposit" value={`${f.amount ? amt(f.amount) : "0"} USDG`} emphasis />
            <Row label="You get" value={f.preview ? `≈ ${num(f.preview.shares, 4)} shares` : "–"} />
            <Row label="Share price" value={f.preview ? `${num(f.preview.sharePrice, 4)} USDG` : "–"} />
            {apy !== undefined && <Row label="Net APY (30d, variable)" value={<span className="text-supply">{pct(apy)}</span>} />}
            <Row label="Fee" value={<span className="block max-w-[240px] text-[13px]">{FEE_LINE}</span>} />
            <Row label="Withdrawals" value={<span className="block max-w-[240px] text-[13px]">{WITHDRAW_RULE}</span>} />
          </>
        }
        notes={<VaultRiskBlock items={TOP_RISKS} />}
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
