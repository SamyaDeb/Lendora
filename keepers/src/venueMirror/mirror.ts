import {encodeFunctionData, keccak256, parseAbiItem, toBytes, type Hex, type PublicClient} from "viem";
import {mockPerpVenueAbi, type ChainDeployment, type DeploymentKey} from "@stockline/sdk";
import type {TxSender} from "../common/signer.js";
import type {Health} from "../common/health.js";

/**
 * Testnet venue mirror (Part C, A49). Lighter has no Robinhood Chain testnet, so the testnet DN vault hedges on the
 * gated `MockPerpVenue`; this keeper applies **Lighter's real hourly funding** (Robinhood Chain instance, public API,
 * read-only) to it, one `applyFunding` per Lighter period, so the vault's funding yield and the rebalancer's kill
 * switch (DN-R7, DN-R13) run on real data. Marks stay at the mirrored Chainlink feeds (feed mirror), which keeps the
 * closed-session rules (DN-R12, DN-R14) as designed. Restart-safe: a period is applied only when it is newer than the
 * venue's last `FundingApplied` for that market. Dry run by default.
 */
export interface FundingPeriod {
  /** Period timestamp, unix seconds. */
  timestamp: number;
  /** Signed rate per period, WAD (1e18 = 100%); positive = longs pay shorts (the vault's shorts receive). */
  rateWad: bigint;
}

export interface FundingFeed {
  /** Periods after `since` (unix seconds), oldest first. */
  since(lighterMarketId: number, since: number): Promise<FundingPeriod[]>;
}

/** Lighter's Robinhood Chain perp market ids (task 12, `orderBookDetails` 2026-09-29). */
export const LIGHTER_MARKETS: Record<string, number> = {SPY: 26, NVDA: 15, AAPL: 10};
/** Never apply more than a day of catch-up in one tick (a long outage is logged, not replayed wholesale). */
export const MAX_CATCH_UP = 24;

/** `GET /api/v1/fundings`: `rate` is percent per hour, `direction` "long" = longs pay shorts (task 13 finding). */
export class LighterFundingFeed implements FundingFeed {
  constructor(
    private readonly apiUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  async since(id: number, since: number): Promise<FundingPeriod[]> {
    const end = Math.floor(Date.now() / 1000);
    // Always a full 24h window: Lighter rounds start_timestamp up to the period and answers 400 when that passes
    // end_timestamp (a caught-up mirror), and it returns the last `count_back` periods anyway. `since` filters below.
    const start = end - MAX_CATCH_UP * 3600;
    const url = `${this.apiUrl}/api/v1/fundings?market_id=${id}&resolution=1h&start_timestamp=${start}&end_timestamp=${end}&count_back=${MAX_CATCH_UP}`;
    const r = await this.fetchImpl(url, {signal: AbortSignal.timeout(10_000)});
    if (!r.ok) throw new Error(`lighter fundings ${r.status}`);
    const j = (await r.json()) as {fundings?: {timestamp: number; rate: string; direction: string}[]};
    return (j.fundings ?? [])
      .filter((f) => f.timestamp > since && /^\d+(\.\d+)?$/.test(f.rate))
      .sort((a, b) => a.timestamp - b.timestamp)
      .map((f) => ({timestamp: f.timestamp, rateWad: (f.direction === "long" ? 1n : -1n) * percentToWad(f.rate)}));
  }
}

const applied = parseAbiItem("event FundingApplied(bytes32 indexed market, int256 rateWad, int256 payment)");

/** An unsigned percent decimal string ("0.0012") → WAD, exact to 1e-16 % (truncated beyond). */
export function percentToWad(pct: string): bigint {
  const [w, f = ""] = pct.split(".");
  return BigInt(w) * 10n ** 16n + BigInt((f + "0".repeat(16)).slice(0, 16));
}

export class VenueMirror {
  /** Last applied Lighter period per ticker (memory; seeded from the venue's last `FundingApplied` block time). */
  private readonly last = new Map<string, number>();

  constructor(
    private readonly client: PublicClient,
    private readonly sender: TxSender,
    private readonly d: ChainDeployment,
    private readonly feed: FundingFeed,
    private readonly health?: Health,
    private readonly log: (m: string) => void = console.log,
    private readonly markets: Record<string, number> = LIGHTER_MARKETS,
  ) {
    if (!d.dnVault || !d.mocks) throw new Error("the venue mirror runs only on deployments with the DN vault on the mock venue (anvil, testnet)");
  }

  private get venue(): `0x${string}` {
    return this.d.dnVault!.perpAdapter;
  }

  /** Restart safety: the venue's last funding for `market` happened at that block's time, so every Lighter period up
   * to it is already applied. */
  private async seed(ticker: string, market: Hex): Promise<number> {
    const logs = await this.client.getLogs({address: this.venue, event: applied, args: {market}, fromBlock: BigInt(this.d.startBlock ?? 0), toBlock: "latest"});
    const lastLog = logs.at(-1);
    if (!lastLog) return 0;
    const b = await this.client.getBlock({blockNumber: lastLog.blockNumber!});
    this.log(`[venue-mirror] ${ticker}: resuming after the venue's last funding at ${b.timestamp}`);
    return Number(b.timestamp);
  }

  async tick(): Promise<string[]> {
    const actions: string[] = [];
    const block = await this.client.getBlockNumber();
    for (const [ticker, id] of Object.entries(this.markets)) {
      if (!this.d.stocks[ticker]) continue;
      const market = keccak256(toBytes(ticker)); // DnVaultDeploy._perpMarket
      if (!this.last.has(ticker)) this.last.set(ticker, await this.seed(ticker, market));
      const periods = await this.feed.since(id, this.last.get(ticker)!);
      for (const p of periods.slice(-MAX_CATCH_UP)) {
        const w = p.rateWad;
        await this.sender.send(this.venue, encodeFunctionData({abi: mockPerpVenueAbi, functionName: "applyFunding", args: [market, w]}), `${ticker} funding ${p.timestamp}`);
        this.last.set(ticker, p.timestamp);
        actions.push(`${ticker} ${p.timestamp} ${w}`);
        this.log(`[venue-mirror] ${ticker} funding ${w} wad (Lighter ${id}, period ${p.timestamp})`);
      }
    }
    this.health?.ok("funding", block);
    return actions;
  }
}

/** MN-R6: the mirror writes the mock venue, so it never runs on Robinhood Chain mainnet (4663) or its fork. */
export function assertVenueMirrorAllowed(key: DeploymentKey, d: ChainDeployment): void {
  if (key === 4663 || key === "fork-4663") throw new Error("the venue mirror never runs on Robinhood Chain mainnet (4663): it is for the mock venue (46630, 31337)");
  if (!d.dnVault || !d.mocks) throw new Error(`the venue mirror needs the DN vault on the mock venue; deployment ${String(key)} has none`);
}
