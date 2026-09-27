"use client";
import {useState} from "react";
import Link from "next/link";
import {useQuery} from "@tanstack/react-query";
import {maxUint256} from "viem";
import {erc20Abi, stocklineRouterAbi, underlyingEquivalent, vaultV2FullAbi, withdrawableAssets} from "@stockline/sdk";
import {deployment} from "@/lib/env";
import {browserApi} from "@/lib/api";
import {deadline, useChainMarket, useWriter} from "@/lib/hooks";
import {useSteps, type Step} from "@/lib/tx";
import {num, pct, wad} from "@/lib/format";
import {tokenPaused} from "@/lib/guard";
import {AmountInput, parseAmount} from "./AmountInput";
import {Notice, Skeleton, Stat, StepList} from "./ui";

/** 06 `/lend/[symbol]`: deposit / withdraw through the router into `rSTOCK` (US-L1, US-L3, LM-R22). */
export function LendPanel({symbol}: {symbol: string}) {
  const d = deployment();
  const s = d.stocks[symbol];
  const [tab, setTab] = useState<"deposit" | "withdraw">("deposit");
  const [amount, setAmount] = useState("");
  const chainQ = useChainMarket(symbol);
  const apiQ = useQuery({queryKey: ["market", symbol], queryFn: () => browserApi().market(symbol), refetchInterval: 10_000});
  const w = useWriter();
  const steps = useSteps(`lend:${tab}`);
  const flows = useQuery({
    queryKey: ["lendFlows", symbol, w.address],
    enabled: Boolean(w.address),
    queryFn: async () => {
      const c = browserApi();
      const [l, wl] = await Promise.all([c.events(symbol, {type: "lend", account: w.address, limit: 500}), c.events(symbol, {type: "withdrawLend", account: w.address, limit: 500})]);
      const sum = (xs: {assets: string | null}[]) => xs.reduce((a, e) => a + Number(e.assets ?? 0), 0);
      return sum(l.data) - sum(wl.data);
    },
  });
  const st = chainQ.data;
  const u = st?.user;
  const parsed = parseAmount(amount, 18);
  const cap = BigInt(s.capAssets);
  const atCap = st ? st.adapterAssets >= (cap * 999n) / 1000n : false;
  const withdrawable = st && u ? withdrawableAssets(u.vaultAssets, st.vaultIdle, st.adapterAssets, st.market.totalSupplyAssets, st.market.totalBorrowAssets) : 0n;
  const price = apiQ.data ? Number(apiQ.data.data.price.usdPerToken) : 0;
  const value = u ? Number(u.vaultAssets) / 1e18 : 0;
  const earnings = flows.data !== undefined && u ? value - flows.data : undefined;

  async function submit() {
    if (!st || !u || !parsed || parsed === 0n) return;
    const dl = deadline(st.now);
    let list: Step[];
    if (tab === "deposit") {
      const minShares = ((await w.pc.readContract({address: s.vault, abi: vaultV2FullAbi, functionName: "previewDeposit", args: [parsed]})) * 999n) / 1000n;
      list = [
        {id: "approve", label: `Approve ${symbol}`, kind: "approve", skip: u.stockAllowance >= parsed, run: async () => void (await w.send({address: s.stockToken, abi: erc20Abi, functionName: "approve", args: [d.router!, maxUint256]}))},
        {id: "lend", label: `Deposit ${amount} ${symbol} into r${symbol}`, kind: "execute", run: async () => void (await w.send({address: d.router!, abi: stocklineRouterAbi, functionName: "lend", args: [s.stockToken, parsed, minShares, w.address, dl]}))},
      ];
    } else {
      const all = parsed >= u.vaultAssets;
      const shares = all ? u.vaultShares : (parsed * u.vaultShares + u.vaultAssets - 1n) / u.vaultAssets;
      const minAssets = (parsed * 999n) / 1000n;
      list = [
        {id: "approve", label: `Approve r${symbol}`, kind: "approve", skip: u.vaultAllowance >= shares, run: async () => void (await w.send({address: s.vault, abi: erc20Abi, functionName: "approve", args: [d.router!, maxUint256]}))},
        {id: "withdraw", label: `Withdraw ${amount} ${symbol}`, kind: "execute", run: async () => void (await w.send({address: d.router!, abi: stocklineRouterAbi, functionName: "withdrawLend", args: [s.stockToken, shares, minAssets, w.address, dl]}))},
      ];
    }
    if (await steps.run(list)) setAmount("");
  }

  const max = tab === "deposit" ? u?.stockBalance : withdrawable;
  const invalid = !parsed || parsed === 0n || (max !== undefined && parsed > max);
  return (
    <div className="grid gap-6 md:grid-cols-[1fr_320px]">
      <section className="card space-y-4 p-4" aria-labelledby="lend-h">
        <h1 id="lend-h" className="text-2xl font-bold">
          Lend {symbol}
        </h1>
        <div role="tablist" aria-label="Deposit or withdraw" className="flex gap-2">
          {(["deposit", "withdraw"] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={`btn ${tab === t ? "" : "btn-ghost"}`} onClick={() => (setTab(t), setAmount(""), steps.reset())} data-testid={`tab-${t}`}>
              {t === "deposit" ? "Deposit" : "Withdraw"}
            </button>
          ))}
        </div>
        {!w.address && <Notice>Connect a wallet to lend.</Notice>}
        {st && tokenPaused(st.guardReasons) && <Notice tone="warn">The issuer has paused {symbol} transfers. Deposits and withdrawals wait for the issuer to unpause.</Notice>}
        {tab === "deposit" && atCap && <Notice tone="warn" title="Market at its supply cap">New deposits stay idle in the vault and earn nothing until the cap rises. You can still withdraw.</Notice>}
        {tab === "withdraw" && u && withdrawable < u.vaultAssets && (
          <Notice tone="warn" title="Withdrawals limited by liquidity">
            {wad(withdrawable, 4)} of your {wad(u.vaultAssets, 4)} {symbol} can be withdrawn now; the rest is lent out. It frees up as borrowers repay (utilization above the cap also raises their rate).
          </Notice>
        )}
        <AmountInput label={tab === "deposit" ? "Amount to deposit" : "Amount to withdraw"} value={amount} onChange={setAmount} decimals={18} unit={symbol} max={max} testId="amount" />
        <button className="btn w-full" disabled={!w.ready || invalid || steps.busy} onClick={submit} data-testid="submit">
          {steps.busy ? "Working…" : tab === "deposit" ? "Deposit" : "Withdraw"}
        </button>
        <StepList steps={steps.states} />
        {steps.error && <Notice tone="danger">{steps.error}</Notice>}
      </section>
      <aside className="card space-y-3 p-4" aria-label="Your lending">
        <dl className="grid grid-cols-2 gap-3">
          <Stat label="Supply APY (variable)" value={apiQ.data ? pct(apiQ.data.data.supplyApy) : <Skeleton />} />
          <Stat label="Utilization" value={apiQ.data ? pct(apiQ.data.data.utilization) : <Skeleton />} />
          <Stat label={`r${symbol} balance`} value={u ? wad(u.vaultShares, 4) : "–"} />
          <Stat label="Value" value={u ? `${wad(u.vaultAssets, 4)} ${symbol}` : "–"} hint="Wrapped units; one unit is one raw Stock Token" />
          <Stat label="Value (shares of stock)" value={u && st ? wad(underlyingEquivalent(u.vaultAssets, st.multiplier), 4) : "–"} />
          <Stat label="Value (USD)" value={u && price ? `$${num(value * price)}` : "–"} />
          <Stat label="Earnings" value={earnings !== undefined ? `${num(earnings, 6)} ${symbol} ($${num(earnings * price)})` : "–"} hint="Current value minus net deposits through the router" />
          <Stat label="Withdrawable now" value={u ? wad(withdrawable, 4) : "–"} />
        </dl>
        <p className="text-xs text-[var(--color-muted)]">Yields are variable and not guaranteed. Dividends reach lenders through the Stock Token multiplier.</p>
        <button className="btn btn-ghost w-full" disabled title="Receipt-as-collateral markets open 30 days after mainnet launch (CL-R10)">
          Use r{symbol} as collateral (coming later)
        </button>
        <Link href={`/market/${symbol}`} className="block text-sm underline">
          Market details
        </Link>
      </aside>
    </div>
  );
}
