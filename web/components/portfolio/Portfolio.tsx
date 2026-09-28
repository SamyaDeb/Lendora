"use client";
import {useEffect, useState} from "react";
import {useQuery} from "@tanstack/react-query";
import {formatUnits} from "viem";
import {useAccount} from "wagmi";
import {browserApi} from "@/lib/api";
import {TICKERS, explorer} from "@/lib/env";
import {positionSummary, useAllPositions, usePositionFlow} from "@/lib/flows/usePositionFlow";
import {num} from "@/lib/format";
import {FEATURES} from "@/lib/features";
import {useRestricted} from "@/app/providers";
import {Badge, ButtonLink, EmptyState, HealthFactor, Icon, Notice, NumberTicker, Skeleton, Stat} from "@/components/ui";
import {ConnectButton} from "@/components/shell/ConnectButton";
import {BorrowCard, LendCard} from "./PositionCards";
import {FaucetButton} from "./FaucetButton";

/**
 * 06 `/portfolio`: every Lendora position of the wallet, from the chain (APP-R5), refreshed every 5 s and after
 * every transaction (APP-R7), riskiest first. Exits are always available (APP-R2, APP-R4, CP-R4).
 */
export function Portfolio() {
  const {address} = useAccount();
  const restricted = useRestricted();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return (
    <div className="space-y-6">
      <div>
        <h1 className="t-display">Portfolio</h1>
        <p className="mt-2 text-[15px] text-muted">Your lending, borrows and shorts, straight from the chain. Riskiest first.</p>
      </div>
      {restricted && <Notice tone="warn" title="Lendora isn't available in your region">You can still repay, close and withdraw your existing positions.</Notice>}
      {!mounted ? (
        <PortfolioSkeleton />
      ) : !address ? (
        <EmptyState title="Connect a wallet to see your positions" icon="wallet" action={<ConnectButton />}>
          Positions are read from the chain, so they show up in any app. Nothing is stored about you.
        </EmptyState>
      ) : (
        <Positions address={address} restricted={restricted} />
      )}
    </div>
  );
}

function Positions({address, restricted}: {address: `0x${string}`; restricted: boolean}) {
  const all = useAllPositions();
  const loading = all.some((p) => !p.st && !p.error);
  const rows = all.filter((p) => p.st).map((p) => ({...p, ...positionSummary(p.st!)}));
  const borrows = rows.filter((r) => r.hasBorrow).sort((a, b) => (a.hf === undefined ? 1 : b.hf === undefined ? -1 : a.hf < b.hf ? -1 : 1));
  const lends = rows.filter((r) => r.hasLend);
  const lentUsd = lends.reduce((a, r) => a + (Number(formatUnits(r.st!.user!.vaultAssets, 18)) * Number(r.st!.stockAnswer)) / 1e8, 0);
  const borrowedUsd = borrows.reduce((a, r) => a + (Number(formatUnits(r.debt, 18)) * Number(r.st!.stockAnswer)) / 1e8, 0);
  const collateral = borrows.reduce((a, r) => a + Number(formatUnits(r.st!.user!.collateral, 6)), 0);
  const lowest = borrows.find((r) => r.hf !== undefined)?.hf;
  const errors = all.filter((p) => p.error).map((p) => p.symbol);

  return (
    <div className="space-y-8">
      <dl className="panel grid grid-cols-2 gap-5 p-5 sm:grid-cols-4">
        <Stat label="Lent" size="lg" tone="supply" value={loading ? <Skeleton className="h-7 w-20" /> : <NumberTicker value={lentUsd} format="usd" />} />
        <Stat label="Borrowed" size="lg" tone="borrow" value={loading ? <Skeleton className="h-7 w-20" /> : <NumberTicker value={borrowedUsd} format="usd" />} />
        <Stat label="Collateral" size="lg" value={loading ? <Skeleton className="h-7 w-20" /> : <NumberTicker value={collateral} format="num" suffix=" USDG" />} />
        <Stat label="Lowest health factor" size="lg" value={loading ? <Skeleton className="h-7 w-14" /> : lowest !== undefined ? <HealthFactor hf={lowest} /> : "–"} hint="Liquidation at 1.00" />
      </dl>

      {errors.length > 0 && (
        <Notice tone="danger" title={`Couldn't read ${errors.join(", ")} from the chain`}>
          The network didn&apos;t respond. Positions reappear when it does; nothing about them has changed.
        </Notice>
      )}

      {!restricted && <FaucetButton />}

      <div className="space-y-4" data-testid="positions">
        {loading && borrows.length + lends.length === 0 ? (
          <PortfolioSkeleton />
        ) : borrows.length + lends.length === 0 ? (
          <EmptyState title="You're not lending or borrowing anything yet" icon="layers" action={!restricted && <ButtonLink href="/" variant="secondary">Pick a stock from the board</ButtonLink>}>
            Lend a Stock Token to earn what borrowers pay, or borrow one to short or hedge.
          </EmptyState>
        ) : (
          <>
            {borrows.length > 0 && (
              <section className="space-y-3" aria-label="Borrows and shorts">
                <h2 className="t-label flex items-center gap-2">
                  <span className="size-2 rounded-full bg-borrow" aria-hidden /> Borrows and shorts
                </h2>
                {borrows.map((r) => (
                  <BorrowSlot key={r.symbol} symbol={r.symbol} restricted={restricted} />
                ))}
              </section>
            )}
            {lends.length > 0 && (
              <section className="space-y-3" aria-label="Lending">
                <h2 className="t-label flex items-center gap-2">
                  <span className="size-2 rounded-full bg-supply" aria-hidden /> Lending
                </h2>
                {lends.map((r) => (
                  <LendSlot key={r.symbol} symbol={r.symbol} />
                ))}
              </section>
            )}
          </>
        )}
        {FEATURES.vault && (
          <EmptyState title="No USDG vault shares" icon="layers" action={<ButtonLink href="/vault" variant="secondary">See the vault</ButtonLink>}>
            Vault positions appear here once the delta-neutral vault launches.
          </EmptyState>
        )}
      </div>

      <History address={address} />
    </div>
  );
}

function BorrowSlot({symbol, restricted}: {symbol: string; restricted: boolean}) {
  const f = usePositionFlow(symbol);
  return <BorrowCard f={f} restricted={restricted} />;
}
function LendSlot({symbol}: {symbol: string}) {
  const f = usePositionFlow(symbol);
  return <LendCard f={f} />;
}

const EVENT: Record<string, {label: string; tone: "supply" | "borrow" | "danger" | "neutral"}> = {
  lend: {label: "Lent", tone: "supply"},
  withdrawLend: {label: "Withdrew", tone: "neutral"},
  borrow: {label: "Borrowed", tone: "borrow"},
  repay: {label: "Repaid", tone: "neutral"},
  liquidate: {label: "Liquidated", tone: "danger"},
};

/** Your last actions across markets (public API; the chain is the record). */
function History({address}: {address: `0x${string}`}) {
  const q = useQuery({
    queryKey: ["history", address],
    queryFn: async () => {
      const c = browserApi();
      const lists = await Promise.all(TICKERS.map((t) => c.events(t, {type: "all", account: address, limit: 20})));
      return lists.flatMap((l) => l.data).sort((a, b) => Date.parse(b.time) - Date.parse(a.time)).slice(0, 25);
    },
    refetchInterval: 15_000,
  });
  return (
    <section className="space-y-3" aria-labelledby="hist">
      <h2 id="hist" className="t-title">
        History
      </h2>
      {q.isPending ? (
        <div className="panel space-y-3 p-5">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="block h-5 w-full" />
          ))}
        </div>
      ) : q.isError ? (
        <EmptyState title="History didn't load" tone="danger" icon="alert">
          The data API didn&apos;t respond. Your positions above read from the chain and are current.
        </EmptyState>
      ) : q.data.length === 0 ? (
        <EmptyState title="No activity yet" icon="clock">
          Lends, borrows, repays and withdrawals show up here.
        </EmptyState>
      ) : (
        <ol className="panel divide-y divide-line">
          {q.data.map((e) => {
            const k = EVENT[e.type] ?? {label: e.type, tone: "neutral" as const};
            return (
              <li key={e.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 text-[14px]">
                <Badge tone={k.tone}>{k.label}</Badge>
                <span className="num">
                  {e.assets ? `${num(Number(e.assets), 4)} ` : ""}
                  {e.symbol}
                </span>
                <span className="ml-auto text-[13px] text-muted">{new Date(e.time).toUTCString().slice(5, 22)} UTC</span>
                {explorer && (
                  <a href={`${explorer}/tx/${e.txHash}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[13px] text-accent-text hover:underline" aria-label={`View ${k.label} transaction on explorer`}>
                    Tx <Icon name="external" size={12} />
                  </a>
                )}
              </li>
            );
          })}
        </ol>
      )}
      <p className="text-[12.5px] text-muted">Amounts are in Stock Token units.</p>
    </section>
  );
}

function PortfolioSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading positions">
      {[0, 1].map((i) => (
        <div key={i} className="panel space-y-5 p-5">
          <div className="flex items-center gap-3">
            <Skeleton className="size-9 rounded-[8px]" />
            <span className="flex flex-1 flex-col gap-1.5">
              <Skeleton className="block h-4 w-32" />
              <Skeleton className="block h-3 w-40" />
            </span>
            <Skeleton className="h-6 w-20 rounded-full" />
          </div>
          <Skeleton className="block h-2 w-full" />
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {[0, 1, 2, 3].map((j) => (
              <span key={j} className="flex flex-col gap-1.5">
                <Skeleton className="block h-3 w-16" />
                <Skeleton className="block h-4 w-20" />
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
