"use client";
import {useState} from "react";
import Link from "next/link";
import {formatUnits} from "viem";
import {underlyingEquivalent, withdrawableAssets} from "@stockline/sdk";
import type {PositionAction, PositionFlow} from "@/lib/flows/usePositionFlow";
import {preview} from "@/lib/preview";
import {hfTone, num, wad} from "@/lib/format";
import {cn} from "@/lib/cn";
import {AmountInput, AssetIcon, Badge, Button, HealthFactor, HealthMeter, Icon, Notice, Row, Stat} from "@/components/ui";
import {ReviewSheet} from "@/components/review/ReviewSheet";

const usdg = (x: bigint) => num(Number(formatUnits(x, 6)));
const liq = (x?: bigint) => (x === undefined || x === 0n ? "–" : `$${num(Number(formatUnits(x, 8)))}`);

/** Borrow / short position: health meter, liquidation price now and during the next closure, and the exits. */
export function BorrowCard({f, restricted, active = true}: {f: PositionFlow; restricted: boolean; active?: boolean}) {
  const [action, setAction] = useState<PositionAction | null>(null);
  const {st, u, symbol, debt} = f;
  // Closed positions stay mounted only while their review sheet shows the result.
  if (!st || !u || (!active && action === null)) return null;
  const pv = preview(st, {collateralIn: 0n, borrowAmount: 0n});
  const tone = debt > 0n ? hfTone(pv.hfNow) : "none";
  const addPv = f.addAmt > 0n ? preview(st, {collateralIn: f.addAmt, borrowAmount: 0n}) : undefined;
  const state = tone === "danger" ? {label: "Can be liquidated", tone: "danger" as const, icon: "alert" as const} : tone === "warn" ? {label: "At risk", tone: "caution" as const, icon: "alert" as const} : debt > 0n ? {label: "Healthy", tone: "success" as const, icon: "check" as const} : {label: "Repaid", tone: "neutral" as const, icon: "check" as const};
  const borrowUsd = Number(formatUnits(debt, 18)) * f.price;

  const REVIEW: Record<PositionAction, {title: string; confirm: string; success: string; body?: string}> = {
    close: {title: `Close your ${symbol} position`, confirm: `Close ${symbol} position`, success: `Closed your ${symbol} position`, body: "Your USDG collateral, minus the buy-back cost, is back in your wallet."},
    repay: {title: `Repay ${symbol}`, confirm: `Repay ${wad(debt, 4)} ${symbol}`, success: `Repaid ${wad(debt, 4)} ${symbol}`, body: "Your collateral stays in place until you withdraw it."},
    add: {title: "Add collateral", confirm: `Add ${f.add} USDG`, success: `Added ${f.add} USDG collateral`},
    withdrawCollateral: {title: "Withdraw collateral", confirm: "Withdraw collateral", success: "Withdrew your collateral"},
    withdrawLend: {title: "", confirm: "", success: ""},
  };
  const r = action ? REVIEW[action] : undefined;

  return (
    <article
      className={cn("panel space-y-5 p-5", tone === "danger" && "shadow-[inset_0_0_0_1px_rgba(255,122,134,0.55)]", tone === "warn" && "shadow-[inset_0_0_0_1px_rgba(242,193,78,0.45)]")}
      aria-labelledby={`pos-${symbol}`}
      data-testid={`position-${symbol}`}
    >
      <header className="flex flex-wrap items-center gap-3">
        <AssetIcon ticker={symbol} />
        <div className="min-w-0 flex-1">
          <h2 id={`pos-${symbol}`} className="text-[17px] font-medium">
            Borrowed {symbol}
          </h2>
          <p className="text-[13px] text-muted">Borrow or short · USDG collateral</p>
        </div>
        <Badge tone={state.tone} icon={state.icon}>
          {state.label}
        </Badge>
      </header>
      {st.guardReasons !== 0n && <Notice tone="warn" title="New borrowing is paused here">Guard tripped: {f.guard.join(", ")}. Repay, close and withdraw still work.</Notice>}
      {f.paused && <Notice tone="warn">The issuer has paused {symbol}. Repaying or closing needs {symbol} transfers and waits for the issuer; USDG collateral can still be withdrawn once your debt allows it.</Notice>}
      {tone === "danger" && <Notice tone="danger" title="This position can be liquidated soon">Add collateral or repay now. Liquidation happens when the health factor falls below 1.00.</Notice>}
      {tone === "warn" && <Notice tone="warn" title="Add collateral before the weekend">Your health factor is below 1.5. Weekend mode adds a safety buffer that lowers it further.</Notice>}

      {debt > 0n && <HealthMeter hf={pv.hfNow} />}
      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
        <Stat size="sm" label="Debt" tone="borrow" value={`${wad(debt, 4)} ${symbol}`} hint={`$${num(borrowUsd)} at $${num(f.price)}`} />
        <Stat size="sm" label="Collateral" value={`${usdg(u.collateral)} USDG`} />
        <Stat size="sm" label="Health factor now" value={<HealthFactor hf={debt > 0n ? pv.hfNow : undefined} />} hint="Liquidation at 1.00" />
        <Stat size="sm" label="…at the next close" value={<HealthFactor hf={debt > 0n ? pv.hfAtClose : undefined} />} hint="With the full weekend buffer" />
        <Stat size="sm" label="Liquidation price" value={debt > 0n ? liq(pv.liqPriceNow) : "–"} />
        <Stat size="sm" label="…during the next closure" value={debt > 0n ? liq(pv.liqPriceAtClose) : "–"} tone="weekend" />
        <Stat size="sm" label="Interest accrued" value={f.accrued !== undefined ? `${num(f.accrued, 6)} ${symbol}` : "–"} />
        <Stat size="sm" label="Borrow APR (variable)" value={`${num(Number(formatUnits(pv.borrowAprNow, 18)) * 100)}%`} />
      </dl>

      <div className="flex flex-col gap-3 border-t border-line pt-4 md:flex-row md:items-end">
        {u.borrowShares > 0n && (
          <div className="flex flex-1 items-end gap-2">
            <div className="flex-1">
              <AmountInput label="Add collateral" value={f.add} onChange={f.setAdd} decimals={6} unit="USDG" max={u.usdgBalance} maxLabel="Wallet balance" usdPrice={1} testId={`add-amount-${symbol}`} />
            </div>
            <Button variant="secondary" className="mb-[22px] h-[62px]" disabled={f.steps.busy || f.addAmt === 0n} onClick={() => setAction("add")} data-testid={`add-${symbol}`}>
              Add collateral
            </Button>
          </div>
        )}
        <div className="flex flex-wrap gap-2 md:mb-[22px]">
          {debt > 0n && (
            <>
              <Button variant="secondary" disabled={f.steps.busy} onClick={() => setAction("repay")} data-testid={`repay-${symbol}`}>
                Repay with {symbol}
              </Button>
              <Button variant="borrow" disabled={f.steps.busy} onClick={() => setAction("close")} data-testid={`close-${symbol}`}>
                Close (buy back with USDG)
              </Button>
            </>
          )}
          {debt === 0n && u.collateral > 0n && (
            <Button disabled={f.steps.busy} onClick={() => setAction("withdrawCollateral")} data-testid={`withdraw-collateral-${symbol}`}>
              Withdraw collateral
            </Button>
          )}
        </div>
      </div>
      {!restricted && (
        <Link href={`/stock/${symbol}?tab=borrow`} className="inline-flex items-center gap-1 text-[13.5px] text-accent-text hover:underline">
          Borrow more {symbol} <Icon name="chevronRight" size={13} />
        </Link>
      )}

      {r && action && (
        <ReviewSheet
          open={action !== null}
          onOpenChange={(o) => !o && setAction(null)}
          title={r.title}
          confirmLabel={r.confirm}
          successTitle={r.success}
          successBody={r.body}
          summary={
            action === "add" ? (
              <>
                <Row label="You add" value={`${f.add} USDG`} emphasis />
                <Row label="Collateral after" value={`${usdg(u.collateral + f.addAmt)} USDG`} />
              </>
            ) : action === "close" ? (
              <>
                <Row label="You buy back" value={`${wad(debt, 4)} ${symbol} ($${num(borrowUsd)})`} emphasis />
                <Row label="Paid from" value="Your USDG (up to 2% above the oracle price)" />
                <Row label="Then" value="Repay and withdraw all collateral" />
              </>
            ) : action === "repay" ? (
              <>
                <Row label="You repay" value={`${wad(debt, 4)} ${symbol} ($${num(borrowUsd)})`} emphasis />
                <Row label="From your wallet" value={`${wad(u.stockBalance, 4)} ${symbol} available`} />
              </>
            ) : (
              <Row label="You withdraw" value={`${usdg(u.collateral)} USDG`} emphasis />
            )
          }
          risk={action === "add" && addPv ? {pv: addPv, hfBefore: pv.hfNow, symbol} : undefined}
          plan={f.plan(action)}
          steps={f.steps.states}
          busy={f.steps.busy}
          error={f.steps.error}
          onConfirm={() => f.confirm(action)}
        />
      )}
    </article>
  );
}

/** Lending receipt (rSTOCK): value, fees earned, what can be withdrawn now vs what is lent out. */
export function LendCard({f, active = true}: {f: PositionFlow; active?: boolean}) {
  const [open, setOpen] = useState(false);
  const {st, u, symbol} = f;
  if (!st || !u || ((!active || u.vaultShares === 0n) && !open)) return null;
  const withdrawable = withdrawableAssets(u.vaultAssets, st.vaultIdle, st.adapterAssets, st.market.totalSupplyAssets, st.market.totalBorrowAssets);
  const lentOut = u.vaultAssets > withdrawable ? u.vaultAssets - withdrawable : 0n;
  const value = Number(formatUnits(u.vaultAssets, 18)) * f.price;
  return (
    <article className="panel space-y-5 p-5" aria-labelledby={`lend-${symbol}`} data-testid={`lend-${symbol}`}>
      <header className="flex flex-wrap items-center gap-3">
        <AssetIcon ticker={`r${symbol}`} kind="receipt" />
        <div className="min-w-0 flex-1">
          <h2 id={`lend-${symbol}`} className="text-[17px] font-medium">
            Lending {symbol}
          </h2>
          <p className="text-[13px] text-muted">r{symbol} receipt · earns what borrowers pay</p>
        </div>
        <Badge tone="supply" icon="trendUp">
          Earning
        </Badge>
      </header>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
        <Stat size="sm" label="Lent" value={`${wad(u.vaultAssets, 4)} ${symbol}`} hint={`$${num(value)}`} />
        <Stat size="sm" label="Fees earned" tone="supply" value={f.fees !== undefined ? `${num(f.fees, 6)} ${symbol}` : "–"} hint={f.fees !== undefined ? `$${num(f.fees * f.price)}` : "Needs the data API"} />
        <Stat size="sm" label="Shares of stock" value={wad(underlyingEquivalent(u.vaultAssets, st.multiplier), 4)} />
        <Stat size="sm" label={`r${symbol} balance`} value={wad(u.vaultShares, 4)} />
      </dl>
      <div className="flex flex-col gap-3 border-t border-line pt-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-[14px]" data-testid={`withdrawable-${symbol}`}>
          <span className="num font-medium text-fg">{wad(withdrawable, 4)} {symbol}</span> <span className="text-muted">ready now</span>
          {lentOut > 0n && (
            <>
              <span className="text-muted"> · </span>
              <span className="num font-medium text-caution">{wad(lentOut, 4)} {symbol}</span> <span className="text-muted">lent out, frees up as borrowers repay</span>
            </>
          )}
        </p>
        <Button variant="secondary" disabled={f.steps.busy} onClick={() => setOpen(true)} data-testid={`withdraw-lend-${symbol}`}>
          Withdraw
        </Button>
      </div>
      <ReviewSheet
        open={open}
        onOpenChange={setOpen}
        title={`Withdraw ${symbol}`}
        confirmLabel={`Withdraw all ${symbol}`}
        successTitle={`Withdrew your ${symbol}`}
        successBody={`${symbol} is back in your wallet.`}
        summary={
          <>
            <Row label="You withdraw" value={`${wad(u.vaultAssets, 4)} ${symbol} ($${num(value)})`} emphasis />
            <Row label="Ready now" value={`${wad(withdrawable, 4)} ${symbol}`} />
            {lentOut > 0n && <Row label="Lent out" value={`${wad(lentOut, 4)} ${symbol}`} />}
          </>
        }
        notes={lentOut > 0n ? `Only ${wad(withdrawable, 4)} ${symbol} can leave now; the transaction fails if more is requested. Withdraw the ready amount from the stock page instead.` : undefined}
        plan={f.plan("withdrawLend")}
        steps={f.steps.states}
        busy={f.steps.busy}
        error={f.steps.error}
        onConfirm={() => f.confirm("withdrawLend")}
      />
    </article>
  );
}
