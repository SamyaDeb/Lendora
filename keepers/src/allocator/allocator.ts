import {encodeFunctionData, type PublicClient} from "viem";
import {
  erc20Abi,
  marketAdapterAbi,
  marketHoursAbi,
  morphoAbi,
  planAllocation,
  stocklineOracleAbi,
  vaultV2Abi,
  type AllocatorAction,
  type AllocatorParams,
  type AllocatorState,
  type ChainDeployment,
} from "@stockline/sdk";
import type {TxSender} from "../common/signer.js";
import type {Health} from "../common/health.js";
import {capIds, encodeMarketParams, marketParams} from "../common/market.js";

export interface AllocatorOptions {
  params: AllocatorParams;
  /** D5: start pulling liquidity this long before an event window's `startTs` (NVDA, AAPL). */
  eventPullLeadSec: bigint;
}

export const defaultAllocatorOptions: AllocatorOptions = {
  params: {uMax: 9n * 10n ** 17n, minMove: 10n ** 15n},
  eventPullLeadSec: 6n * 3600n,
};

/** Vault V2 allocator keeper (LM-R30…R34, D5, D6). Stateless between ticks: idempotent and restart-safe. */
export class Allocator {
  constructor(
    private readonly client: PublicClient,
    private readonly sender: TxSender,
    private readonly d: ChainDeployment,
    private readonly opts: AllocatorOptions = defaultAllocatorOptions,
    private readonly health?: Health,
    private readonly log: (m: string) => void = console.log,
  ) {}

  async readState(ticker: string, now: bigint): Promise<AllocatorState> {
    const s = this.d.stocks[ticker];
    const p = marketParams(this.d, s);
    const ids = capIds(s.adapter, p);
    const c = this.client;
    const [totalAssets, idle, adapterAssets, market, guardTripped, stockAnswer, events] = await Promise.all([
      c.readContract({address: s.vault, abi: vaultV2Abi, functionName: "totalAssets"}),
      c.readContract({address: s.wrapper, abi: erc20Abi, functionName: "balanceOf", args: [s.vault]}),
      c.readContract({address: s.adapter, abi: marketAdapterAbi, functionName: "expectedSupplyAssets", args: [s.marketId]}),
      c.readContract({address: this.d.morpho, abi: morphoAbi, functionName: "market", args: [s.marketId]}),
      c.readContract({address: s.oracle, abi: stocklineOracleAbi, functionName: "guardTripped"}),
      c.readContract({address: s.oracle, abi: stocklineOracleAbi, functionName: "stockAnswer"}),
      c.readContract({
        address: this.d.marketHours,
        abi: marketHoursAbi,
        functionName: "eventWindows",
        args: [s.stockToken, now + this.opts.eventPullLeadSec],
      }),
    ]);
    const caps = await Promise.all(
      ids.flatMap((id) => [
        c.readContract({address: s.vault, abi: vaultV2Abi, functionName: "absoluteCap", args: [id]}),
        c.readContract({address: s.vault, abi: vaultV2Abi, functionName: "relativeCap", args: [id]}),
      ]),
    );
    const allocation = await c.readContract({address: s.vault, abi: vaultV2Abi, functionName: "allocation", args: [ids[2]]});
    const absoluteCap = [caps[0], caps[2], caps[4]].reduce((a, b) => (a < b ? a : b));
    const relativeCap = [caps[1], caps[3], caps[5]].reduce((a, b) => (a < b ? a : b));
    // D5: pull from `lead` before the latest event window starts until a good feed round at/after its endTs.
    const latest = events[0];
    const eventPull = latest.startTs !== 0n && stockAnswer[1] < latest.endTs;
    return {
      totalAssets,
      idle,
      allocation,
      absoluteCap,
      relativeCap,
      adapterAssets,
      marketSupply: market.totalSupplyAssets,
      marketBorrow: market.totalBorrowAssets,
      pull: guardTripped || eventPull,
    };
  }

  /** One pass over every market. Returns the actions taken (or planned, in dry run). */
  async tick(): Promise<Record<string, AllocatorAction>> {
    const block = await this.client.getBlock();
    const out: Record<string, AllocatorAction> = {};
    for (const ticker of Object.keys(this.d.stocks)) {
      try {
        const state = await this.readState(ticker, block.timestamp);
        const action = planAllocation(state, this.opts.params);
        out[ticker] = action;
        if (action.kind !== "none") {
          const s = this.d.stocks[ticker];
          const data = encodeFunctionData({
            abi: vaultV2Abi,
            functionName: action.kind,
            args: [s.adapter, encodeMarketParams(marketParams(this.d, s)), action.assets],
          });
          this.log(`[allocator] ${ticker} ${action.kind} ${action.assets} (${action.reason})`);
          await this.sender.send(s.vault, data, `${ticker} ${action.kind}`);
        }
        this.health?.ok(ticker, block.number);
      } catch (e) {
        this.health?.fail(ticker, e);
        this.log(`[allocator] ${ticker} error: ${String(e)}`);
      }
    }
    return out;
  }
}
