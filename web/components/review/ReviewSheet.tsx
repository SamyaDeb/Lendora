"use client";
import {useEffect, useState, type ReactNode} from "react";
import {formatUnits} from "viem";
import type {Preview} from "@/lib/preview";
import type {StepState} from "@/lib/tx";
import {et, num, pct} from "@/lib/format";
import {Button, ButtonLink, HealthMeter, Icon, Notice, NumberTicker, Row, Sheet, StepList} from "@/components/ui";

export interface ReviewRisk {
  /** Preview from @stockline/sdk (borrow, short, add collateral, close). */
  pv: Preview;
  hfBefore?: bigint;
  /** Collateral the router requires to open, and the weekend part of it (USDG, 6 dp). */
  requirement?: {required: bigint; buffer: bigint};
  symbol: string;
}

const liq = (x?: bigint) => (x === undefined || x === 0n ? undefined : Number(formatUnits(x, 8)));

/**
 * The review step every action goes through: amounts in token and USD, the risk block (health meter, liquidation
 * price now and during the next closure, collateral required including the weekend buffer, borrow rate) and the
 * transaction stepper. Borrow and short cannot be confirmed unless the liquidation price is shown.
 */
export function ReviewSheet({
  open,
  onOpenChange,
  title,
  confirmLabel,
  summary,
  risk,
  requireLiquidationPrice,
  plan,
  steps,
  busy,
  error,
  onConfirm,
  blocker,
  successTitle,
  successBody,
  notes,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  confirmLabel: string;
  summary: ReactNode;
  risk?: ReviewRisk;
  requireLiquidationPrice?: boolean;
  plan: StepState[];
  steps: StepState[];
  busy: boolean;
  error?: string;
  onConfirm: () => Promise<boolean>;
  blocker?: string;
  successTitle: string;
  successBody?: ReactNode;
  notes?: ReactNode;
}) {
  const [done, setDone] = useState(false);
  const [started, setStarted] = useState(false);
  // The flow clears its inputs on success, so the success copy is captured when Confirm is pressed.
  const [snap, setSnap] = useState<{title: string; body?: ReactNode}>({title: successTitle});
  useEffect(() => {
    if (open) {
      setDone(false);
      setStarted(false);
    }
  }, [open]);
  const liqNow = risk ? liq(risk.pv.liqPriceNow) : undefined;
  const liqClose = risk ? liq(risk.pv.liqPriceAtClose) : undefined;
  const missingLiq = requireLiquidationPrice && liqNow === undefined;
  const shown = started && steps.length ? steps : plan;
  const canConfirm = !busy && !done && !missingLiq && !blocker;

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => !busy && onOpenChange(o)}
      dismissable={!busy}
      title={done ? snap.title : title}
      description={done ? undefined : "Check the details, then confirm each step in your wallet."}
      footer={
        done ? (
          <div className="flex gap-2">
            <Button variant="secondary" className="flex-1" onClick={() => onOpenChange(false)}>
              Done
            </Button>
            <ButtonLink href="/portfolio" className="flex-1">
              View portfolio
            </ButtonLink>
          </div>
        ) : (
          <div className="space-y-2">
            {missingLiq && <p className="text-[13px] text-caution">The liquidation price isn&apos;t available yet, so this can&apos;t be confirmed. Wait for the preview to load.</p>}
            {blocker && !busy && <p className="text-[13px] text-caution">{blocker}</p>}
            <Button
              size="lg"
              className="w-full"
              disabled={!canConfirm}
              onClick={async () => {
                setStarted(true);
                setSnap({title: successTitle, body: successBody});
                if (await onConfirm()) setDone(true);
              }}
              data-testid="confirm"
            >
              {busy ? "Confirm in your wallet…" : error ? `Try again: ${confirmLabel}` : confirmLabel}
            </Button>
          </div>
        )
      }
    >
      <div className="space-y-5">
        {done ? (
          <Notice tone="safe" title={snap.title}>
            {snap.body}
          </Notice>
        ) : (
          <dl className="divide-y divide-line">{summary}</dl>
        )}

        {risk && !done && (
          <section aria-label="Risk" className="space-y-3 rounded-sm bg-sunken p-4 shadow-[inset_0_0_0_1px_var(--border)]">
            <HealthMeter hf={risk.hfBefore} next={risk.pv.hfNow} />
            <dl className="divide-y divide-line">
              <Row
                label={
                  <span className="inline-flex items-center gap-1.5 text-fg">
                    <Icon name="alert" size={14} className="text-caution" /> Liquidation price
                  </span>
                }
                value={liqNow !== undefined ? <span className="text-[16px] text-fg">${num(liqNow)}</span> : "Not available"}
                testId="rv-liq-now"
                emphasis
              />
              {risk.pv.closure && (
                <Row
                  label={
                    <span className="inline-flex items-center gap-1.5">
                      <Icon name="moon" size={14} className="text-weekend" /> During the next closure
                    </span>
                  }
                  value={liqClose !== undefined ? `$${num(liqClose)}` : "–"}
                />
              )}
              {risk.requirement && (
                <Row
                  label="Collateral required to open"
                  value={
                    <span className="flex flex-col items-end">
                      <NumberTicker value={Number(formatUnits(risk.requirement.required, 6))} format="num" suffix=" USDG" />
                      {risk.requirement.buffer > 0n && <span className="text-[12px] text-weekend">incl. {num(Number(formatUnits(risk.requirement.buffer, 6)))} USDG weekend buffer</span>}
                    </span>
                  }
                />
              )}
              <Row label="Borrow rate (variable)" value={`${pct(risk.pv.borrowAprNow, 2, true)} APR · ${pct(risk.pv.borrowAprPlus10, 2, true)} at +10% utilization`} />
            </dl>
            {risk.pv.closure && (
              <p className="flex gap-2 text-[12.5px] text-muted">
                <Icon name="moon" size={14} className="mt-0.5 shrink-0 text-weekend" />
                {risk.pv.closure.open
                  ? `Weekend mode starts ramping ${et(risk.pv.closure.rampStartTs)}. At the close the oracle adds a ${pct(risk.pv.closure.bufferAtClose, 1, true)} safety buffer, so your liquidation price moves closer.`
                  : `Weekend mode is on until the first price after ${et(risk.pv.closure.reopenTs || risk.pv.closure.closeTs)}: the oracle's safety buffer is already included above.`}
              </p>
            )}
            <p className="text-[12.5px] text-muted">Liquidation happens when the health factor falls below 1.00. You owe {risk.symbol} itself, including any dividends (through the token&apos;s multiplier).</p>
          </section>
        )}

        {notes && !done && <div className="text-[13px] text-muted">{notes}</div>}

        {shown.length > 0 && (
          <section aria-label="Steps" className="space-y-3">
            <h3 className="text-[13px] font-medium text-dim">{done ? "Completed" : "Steps"}</h3>
            <StepList steps={shown} />
          </section>
        )}
        {error && !busy && <Notice tone="danger" title="That didn't go through">{error}</Notice>}
      </div>
    </Sheet>
  );
}
