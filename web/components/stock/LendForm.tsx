"use client";
import {useState} from "react";
import {underlyingEquivalent} from "@stockline/sdk";
import type {LendFlow} from "@/lib/flows/useLendFlow";
import {num, pct, wad} from "@/lib/format";
import {AmountInput, Button, Icon, Notice, NumberTicker, Row, Segmented, Stat} from "@/components/ui";
import {ReviewSheet} from "@/components/review/ReviewSheet";
import {WalletGate} from "./WalletGate";

/** Lend tab: deposit Stock Tokens into rSTOCK, or withdraw. The yield source is always spelled out. */
export function LendForm({f}: {f: LendFlow}) {
  const [review, setReview] = useState(false);
  const {symbol, market, u, st} = f;
  const apy = market?.supplyApy;
  const amountNum = f.parsed ? Number(f.parsed) / 1e18 : 0;
  const lentOut = u && f.withdrawable < u.vaultAssets ? u.vaultAssets - f.withdrawable : 0n;
  return (
    <div className="space-y-4">
      <Segmented
        label="Lend or withdraw"
        value={f.mode}
        onChange={f.setMode}
        testIdPrefix="tab-"
        options={[
          {value: "deposit", label: "Lend"},
          {value: "withdraw", label: "Withdraw"},
        ]}
      />
      {f.paused && <Notice tone="warn" title={`The issuer has paused ${symbol} transfers`}>Lending and withdrawals wait until the issuer unpauses.</Notice>}
      {f.mode === "deposit" && f.atCap && (
        <Notice tone="warn" title="Market at its supply cap">
          New deposits stay idle in the vault and earn nothing until the cap rises. You can still withdraw.
        </Notice>
      )}
      {f.mode === "withdraw" && u && lentOut > 0n && (
        <Notice tone="warn" title="Some of your stock is lent out">
          {wad(f.withdrawable, 4)} {symbol} ready now, {wad(lentOut, 4)} {symbol} lent out. It frees up as borrowers repay; high utilization also raises their rate to speed that up.
        </Notice>
      )}

      <AmountInput
        label={f.mode === "deposit" ? `Amount to lend` : "Amount to withdraw"}
        value={f.amount}
        onChange={f.setAmount}
        decimals={18}
        unit={symbol}
        max={f.max}
        maxLabel={f.mode === "deposit" ? "Wallet balance" : "Withdrawable now"}
        usdPrice={f.price || undefined}
        testId="amount"
        disabled={!f.address}
      />

      {f.mode === "deposit" && (
        <div className="rounded-sm bg-supply-soft p-3.5 shadow-[inset_0_0_0_1px_rgba(89,217,122,0.22)]">
          <div className="flex items-baseline justify-between">
            <span className="inline-flex items-center gap-1.5 text-[13.5px] text-dim">
              <Icon name="trendUp" size={15} className="text-supply" /> Lend APY (variable)
            </span>
            <NumberTicker value={apy} format="pct" className="text-[18px] font-medium text-supply" />
          </div>
          <p className="mt-1.5 text-[12.5px] leading-snug text-muted">
            Paid by {symbol} borrowers as interest, net of the 10% protocol fee. You earn it in {symbol}, so its USD value moves with the stock. Dividends reach you through the token&apos;s multiplier.
          </p>
          {amountNum > 0 && apy !== undefined && (
            <p className="num mt-2 text-[13px] text-dim">
              At today&apos;s rate: ≈ {num(amountNum * apy, 4)} {symbol} a year{f.price ? ` ($${num(amountNum * apy * f.price)})` : ""}
            </p>
          )}
        </div>
      )}

      <WalletGate>
        <Button
          size="lg"
          variant={f.mode === "deposit" ? "supply" : "secondary"}
          className="w-full"
          disabled={!f.ready || f.invalid || f.steps.busy || f.paused}
          onClick={() => setReview(true)}
          data-testid="submit"
        >
          {f.mode === "deposit" ? `Review lend` : "Review withdrawal"}
        </Button>
      </WalletGate>

      {u && (
        <section aria-label="Your lending" className="space-y-3 border-t border-line pt-4">
          <h3 className="text-[13px] font-medium text-dim">Your lending</h3>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
            <Stat size="sm" label={`r${symbol} balance`} value={wad(u.vaultShares, 4)} />
            <Stat size="sm" label="Value" value={f.price ? `$${num(f.value * f.price)}` : `${wad(u.vaultAssets, 4)} ${symbol}`} hint={st ? `${wad(underlyingEquivalent(u.vaultAssets, st.multiplier), 4)} shares of stock` : undefined} />
            <Stat size="sm" label="Fees earned" tone="supply" value={f.earnings !== undefined ? `${num(f.earnings, 6)} ${symbol}` : "–"} hint={f.earnings !== undefined && f.price ? `$${num(f.earnings * f.price)} · value minus net deposits` : undefined} />
            <Stat size="sm" label="Withdrawable now" value={`${wad(f.withdrawable, 4)} ${symbol}`} />
            <Stat
              size="sm"
              label="Yield at the current rate"
              testId="yield-now"
              value={apy !== undefined ? `${num(f.value * apy, 6)} ${symbol}/yr` : "–"}
              hint={apy !== undefined && f.price ? `$${num(f.value * apy * f.price)}/yr at today's price. Variable; not a forecast` : undefined}
              className="col-span-2"
            />
          </dl>
          <Button variant="ghost" size="sm" disabled className="w-full" title="Receipt-as-collateral markets open 30 days after mainnet launch (CL-R10)">
            Use r{symbol} as collateral (coming later)
          </Button>
        </section>
      )}

      <ReviewSheet
        open={review}
        onOpenChange={setReview}
        title={f.mode === "deposit" ? `Review lend` : "Review withdrawal"}
        confirmLabel={f.mode === "deposit" ? `Lend ${f.amount} ${symbol}` : `Withdraw ${f.amount} ${symbol}`}
        successTitle={f.mode === "deposit" ? `Lent ${f.amount} ${symbol}` : `Withdrew ${f.amount} ${symbol}`}
        successBody={f.mode === "deposit" ? `It now earns the lend APY as r${symbol}.` : `${symbol} is back in your wallet.`}
        summary={
          <>
            <Row label={f.mode === "deposit" ? "You lend" : "You withdraw"} value={`${f.amount || "0"} ${symbol}${f.price ? ` ($${num(amountNum * f.price)})` : ""}`} emphasis />
            <Row label={f.mode === "deposit" ? "You receive" : "You return"} value={`≈ ${num(amountNum, 4)} r${symbol}`} />
            {apy !== undefined && <Row label="Lend APY (variable)" value={<span className="text-supply">{pct(apy)}</span>} />}
            {f.mode === "withdraw" && <Row label="Withdrawable now" value={`${wad(f.withdrawable, 4)} ${symbol}`} />}
          </>
        }
        notes={f.mode === "deposit" ? "The APY is paid by borrowers and changes with utilization. Lending isn't insured." : undefined}
        plan={f.plan}
        steps={f.steps.states}
        busy={f.steps.busy}
        error={f.steps.error}
        onConfirm={f.confirm}
      />
    </div>
  );
}
