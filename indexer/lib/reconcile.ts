import type {Pool} from "pg";
import type {PublicClient} from "viem";
import {adaptiveCurveIrmAbi, erc20Abi, morphoAbi, type ChainDeployment} from "@stockline/sdk";

/**
 * SI-R5 reconciliation: indexed totals vs onchain reads at the indexed head block. Raw Morpho `market()` fields,
 * the IRM's `rateAtTarget`, the vault's idle balance and every indexed position are compared exactly; interest-accrued
 * totals (SDK `expectedMarketBalances`) are compared with `ShortInterestLens` once it is deployed (task 2). Any
 * difference above `toleranceWei` pages through the `Pager` interface.
 */
export interface Alert {
  severity: "P0" | "P1" | "P2";
  title: string;
  details: Record<string, unknown>;
}

/** Paging integration point (PagerDuty/Opsgenie are wired by env later; this is the interface + stubs). */
export interface Pager {
  page(alert: Alert): Promise<void>;
}

export class ConsolePager implements Pager {
  readonly sent: Alert[] = [];
  async page(alert: Alert): Promise<void> {
    this.sent.push(alert);
    console.error(`[page ${alert.severity}] ${alert.title} ${JSON.stringify(alert.details, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
  }
}

/** POSTs the alert as JSON to a webhook (e.g. a PagerDuty Events v2 bridge). URL from env, never in the repo. */
export class WebhookPager implements Pager {
  constructor(private readonly url: string) {}
  async page(alert: Alert): Promise<void> {
    const body = JSON.stringify(alert, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    const r = await fetch(this.url, {method: "POST", headers: {"content-type": "application/json"}, body});
    if (!r.ok) throw new Error(`pager webhook ${r.status}`);
  }
}

export interface Diff {
  ticker: string;
  field: string;
  account?: string;
  indexed: bigint;
  onchain: bigint;
}

export interface ReconcileReport {
  block: bigint;
  checked: number;
  diffs: Diff[];
}

export interface ReconcileOptions {
  pool: Pool;
  /** Schema with the indexer tables or views (`--views-schema`, default "stockline"). */
  schema: string;
  client: PublicClient;
  d: ChainDeployment;
  pager: Pager;
  toleranceWei?: bigint;
}

const q = (s: string) => `"${s.replace(/"/g, "")}"`;

export async function reconcile(o: ReconcileOptions): Promise<ReconcileReport> {
  const tol = o.toleranceWei ?? 1n;
  const {rows: heads} = await o.pool.query(`select head_block from ${q(o.schema)}.chain_head limit 1`);
  if (!heads.length) throw new Error("indexer has no head yet");
  const block = BigInt(heads[0].head_block);
  const diffs: Diff[] = [];
  let checked = 0;
  const cmp = (ticker: string, field: string, indexed: bigint, onchain: bigint, account?: string) => {
    checked++;
    const d = indexed > onchain ? indexed - onchain : onchain - indexed;
    if (d > tol) diffs.push({ticker, field, indexed, onchain, ...(account ? {account} : {})});
  };

  const {rows: markets} = await o.pool.query(`select * from ${q(o.schema)}.market order by ticker`);
  for (const m of markets) {
    const s = o.d.stocks[m.ticker];
    const [mk, rat, idle] = await Promise.all([
      o.client.readContract({address: o.d.morpho, abi: morphoAbi, functionName: "market", args: [s.marketId], blockNumber: block}),
      o.client.readContract({address: o.d.adaptiveCurveIrm, abi: adaptiveCurveIrmAbi, functionName: "rateAtTarget", args: [s.marketId], blockNumber: block}),
      o.client.readContract({address: s.wrapper, abi: erc20Abi, functionName: "balanceOf", args: [s.vault], blockNumber: block}),
    ]);
    cmp(m.ticker, "totalSupplyAssets", BigInt(m.total_supply_assets), mk.totalSupplyAssets);
    cmp(m.ticker, "totalSupplyShares", BigInt(m.total_supply_shares), mk.totalSupplyShares);
    cmp(m.ticker, "totalBorrowAssets", BigInt(m.total_borrow_assets), mk.totalBorrowAssets);
    cmp(m.ticker, "totalBorrowShares", BigInt(m.total_borrow_shares), mk.totalBorrowShares);
    cmp(m.ticker, "lastUpdate", BigInt(m.last_update), mk.lastUpdate);
    cmp(m.ticker, "fee", BigInt(m.fee), mk.fee);
    cmp(m.ticker, "rateAtTarget", BigInt(m.rate_at_target), BigInt(rat));
    cmp(m.ticker, "vaultIdle", BigInt(m.vault_idle), idle);

    const {rows: positions} = await o.pool.query(`select * from ${q(o.schema)}.position where ticker = $1`, [m.ticker]);
    let borrowers = 0;
    for (const p of positions) {
      const pos = await o.client.readContract({address: o.d.morpho, abi: morphoAbi, functionName: "position", args: [s.marketId, p.account], blockNumber: block});
      cmp(m.ticker, "supplyShares", BigInt(p.supply_shares), pos.supplyShares, p.account);
      cmp(m.ticker, "borrowShares", BigInt(p.borrow_shares), pos.borrowShares, p.account);
      cmp(m.ticker, "collateral", BigInt(p.collateral), pos.collateral, p.account);
      if (pos.borrowShares > 0n) borrowers++;
    }
    cmp(m.ticker, "borrowers", BigInt(m.borrowers), BigInt(borrowers));
  }

  if (diffs.length) {
    await o.pager.page({severity: "P2", title: `Indexer reconciliation: ${diffs.length} diff(s) at block ${block}`, details: {block, diffs}});
  }
  return {block, checked, diffs};
}
