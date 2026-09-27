import {encodeFunctionData, type PublicClient} from "viem";
import {aggregatorV3Abi, mockAggregatorAbi, mockSwapAggregatorAbi, mockUniswapV3PoolAbi, tickForAnswer, type ChainDeployment, type ExternalChain} from "@stockline/sdk";
import type {TxSender} from "../common/signer.js";
import type {Health} from "../common/health.js";

/**
 * Testnet feed mirror (Phase 2 task 7). Robinhood Chain testnet has no Stock Token feeds, so the testnet deployment
 * uses gated mock feeds; this keeper copies every new round of the real mainnet Chainlink feeds (read-only on 4663)
 * to them and moves the mock DEX (swap rates, pool tick) to the same price. Testnet therefore sees real prices, the
 * real 24/5 sessions and real weekend freezes (no rounds while the feed is closed). Restart-safe: it pushes only when
 * the source round differs from what the target shows. Dry run by default.
 */
export interface Round {
  answer: bigint;
  updatedAt: bigint;
}

export interface PriceSource {
  latest(symbol: string): Promise<Round | undefined>;
}

/** The mainnet Chainlink proxies from external-addresses.json (read-only). */
export class ChainlinkSource implements PriceSource {
  constructor(
    private readonly mainnet: PublicClient,
    private readonly ext: ExternalChain,
  ) {}
  async latest(symbol: string): Promise<Round | undefined> {
    const feed = this.ext.chainlink[symbol]?.proxy;
    if (!feed) return undefined;
    const r = await this.mainnet.readContract({address: feed, abi: aggregatorV3Abi, functionName: "latestRoundData"});
    return {answer: BigInt(r[1]), updatedAt: BigInt(r[3])};
  }
}

export class FeedMirror {
  /** Source round last pushed per symbol (memory; after a restart the target answer is compared instead). */
  private readonly pushed = new Map<string, bigint>();

  constructor(
    private readonly client: PublicClient,
    private readonly sender: TxSender,
    private readonly d: ChainDeployment,
    private readonly source: PriceSource,
    private readonly health?: Health,
    private readonly log: (m: string) => void = console.log,
  ) {
    if (!d.mocks?.swapAggregator) throw new Error("the feed mirror runs only on deployments with mock feeds (anvil, testnet)");
  }

  async tick(): Promise<string[]> {
    const m = this.d.mocks!;
    const actions: string[] = [];
    const block = await this.client.getBlockNumber();
    for (const symbol of [...Object.keys(this.d.stocks), "USDG"]) {
      const src = await this.source.latest(symbol);
      if (!src || src.answer <= 0n) continue;
      if (this.pushed.get(symbol) === src.updatedAt) continue;
      const feed = symbol === "USDG" ? m.usdgFeed : m[`${symbol}_feed`];
      const target = await this.client.readContract({address: feed, abi: aggregatorV3Abi, functionName: "latestRoundData"});
      // After a restart: an identical answer means this round (or an equal one) is already there.
      if (!this.pushed.has(symbol) && BigInt(target[1]) === src.answer) {
        this.pushed.set(symbol, src.updatedAt);
        continue;
      }
      await this.sender.send(feed, encodeFunctionData({abi: mockAggregatorAbi, functionName: "setAnswer", args: [src.answer]}), `${symbol} round`);
      actions.push(`${symbol} ${src.answer}`);
      if (symbol !== "USDG") {
        const s = this.d.stocks[symbol];
        const toUsdg = (src.answer * 10n ** 6n) / 10n ** 8n;
        await this.sender.send(m.swapAggregator, encodeFunctionData({abi: mockSwapAggregatorAbi, functionName: "setRate", args: [s.stockToken, this.d.usdg, toUsdg]}), `${symbol} dex rate`);
        await this.sender.send(m.swapAggregator, encodeFunctionData({abi: mockSwapAggregatorAbi, functionName: "setRate", args: [this.d.usdg, s.stockToken, (10n ** 8n * 10n ** 36n) / (src.answer * 10n ** 6n)]}), `${symbol} dex rate back`);
        await this.sender.send(m[`${symbol}_USDG_pool`], encodeFunctionData({abi: mockUniswapV3PoolAbi, functionName: "setTick", args: [tickForAnswer(src.answer)]}), `${symbol} pool tick`);
      }
      this.pushed.set(symbol, src.updatedAt);
      this.log(`[feed-mirror] ${symbol} ${src.answer} (source updatedAt ${src.updatedAt})`);
    }
    this.health?.ok("feeds", block);
    return actions;
  }
}
