import {encodeAbiParameters, encodeFunctionData, parseAbiItem, type Hex, type PublicClient} from "viem";
import {
  morphoAbi,
  lendoraLiquidatorAbi,
  lendoraOracleAbi,
  type ChainDeployment,
  type Address,
  type DeploymentKey,
  type StockDeployment, safeErrorLine} from "@lendora/sdk";
import type {TxSender} from "../common/signer.js";
import type {Health} from "../common/health.js";
import {marketParams, type MarketParams} from "../common/market.js";

const WAD = 10n ** 18n;
/** Morpho Blue `EventsLib.Borrow` (not part of the IMorpho ABI). */
const borrowEvent = parseAbiItem(
  "event Borrow(bytes32 indexed id, address caller, address indexed onBehalf, address indexed receiver, uint256 assets, uint256 shares)",
);
const ORACLE_PRICE_SCALE = 10n ** 36n;

/** Morpho liquidation incentive factor: min(1.15, 1 / (1 − 0.3·(1 − LLTV))). */
export function liquidationIncentiveFactor(lltv: bigint): bigint {
  const lif = (WAD * WAD) / (WAD - (3n * 10n ** 17n * (WAD - lltv)) / WAD);
  return lif > 115n * 10n ** 16n ? 115n * 10n ** 16n : lif;
}

export interface PositionView {
  borrower: `0x${string}`;
  collateral: bigint; // clUSDG raw
  borrowShares: bigint;
  borrowed: bigint; // wSTOCK raw, rounded up
}

export interface LiquidationPlan {
  borrower: `0x${string}`;
  seizedAssets: bigint;
  repaidShares: bigint;
  /** clUSDG seized (= USDG received). */
  expectedSeized: bigint;
  /** wSTOCK Morpho will pull. */
  expectedRepaid: bigint;
  usdgIn: bigint;
  expectedProfit: bigint;
  badDebt: boolean;
}

/**
 * Pure planner (Morpho liquidation math, rounding in the protocol's favor). Liquidates the whole position; if the
 * collateral cannot cover debt × LIF (bad debt), seizes all collateral instead. `usdgIn` buys the needed stock at the
 * feed price plus `slippageBps` of headroom; excess stock is refunded to the recipient by the contract.
 */
export function planLiquidation(
  p: PositionView,
  price: bigint,
  lltv: bigint,
  stockAnswer: bigint,
  feedDecimals: number,
  slippageBps: bigint,
): LiquidationPlan | undefined {
  if (p.borrowShares === 0n) return undefined;
  const maxBorrow = (((p.collateral * price) / ORACLE_PRICE_SCALE) * lltv) / WAD;
  if (maxBorrow >= p.borrowed) return undefined; // healthy
  const lif = liquidationIncentiveFactor(lltv);
  const seizeForAll = (((p.borrowed * lif) / WAD) * ORACLE_PRICE_SCALE) / price;
  const badDebt = seizeForAll > p.collateral;
  const expectedSeized = badDebt ? p.collateral : seizeForAll;
  const expectedRepaid = badDebt ? (((p.collateral * price) / ORACLE_PRICE_SCALE) * WAD) / lif + 1n : p.borrowed;
  // USDG (6 dp) for `expectedRepaid` wSTOCK (18 dp) at the feed price, plus headroom.
  const usdgAtFeed = (expectedRepaid * stockAnswer) / 10n ** BigInt(18 - 6 + feedDecimals);
  let usdgIn = (usdgAtFeed * (10_000n + slippageBps)) / 10_000n + 1n;
  if (usdgIn > expectedSeized) usdgIn = expectedSeized;
  return {
    borrower: p.borrower,
    seizedAssets: badDebt ? p.collateral : 0n,
    repaidShares: badDebt ? 0n : p.borrowShares,
    expectedSeized,
    expectedRepaid,
    usdgIn,
    expectedProfit: expectedSeized - usdgIn,
    badDebt,
  };
}

/** Builds swap calldata for buying the Stock Token with USDG, delivered to the liquidator contract. */
export interface SwapBuilder {
  target: `0x${string}`;
  buy(stock: `0x${string}`, usdg: `0x${string}`, usdgIn: bigint, recipient: `0x${string}`): Hex;
}

export const mockDexBuilder = (target: `0x${string}`): SwapBuilder => ({
  target,
  buy: (stock, usdg, usdgIn, recipient) =>
    encodeFunctionData({
      abi: [
        {
          type: "function",
          name: "swap",
          stateMutability: "nonpayable",
          inputs: [
            {name: "tokenIn", type: "address"},
            {name: "tokenOut", type: "address"},
            {name: "amountIn", type: "uint256"},
            {name: "minOut", type: "uint256"},
            {name: "to", type: "address"},
          ],
          outputs: [{type: "uint256"}],
        },
      ] as const,
      functionName: "swap",
      args: [usdg, stock, usdgIn, 0n, recipient],
    }),
});

/** Uniswap UniversalRouter V3_SWAP_EXACT_IN (the deployed version takes a trailing `uint256[] minHopPriceX36`). */
export const universalRouterBuilder = (target: `0x${string}`, fee = 500): SwapBuilder => ({
  target,
  buy: (stock, usdg, usdgIn, recipient) => {
    const path = (usdg + fee.toString(16).padStart(6, "0") + stock.slice(2)) as Hex;
    const input = encodeAbiParameters(
      [{type: "address"}, {type: "uint256"}, {type: "uint256"}, {type: "bytes"}, {type: "bool"}, {type: "uint256[]"}],
      [recipient, usdgIn, 0n, path, false, []],
    );
    return encodeFunctionData({
      abi: [
        {
          type: "function",
          name: "execute",
          stateMutability: "payable",
          inputs: [
            {name: "commands", type: "bytes"},
            {name: "inputs", type: "bytes[]"},
            {name: "deadline", type: "uint256"},
          ],
          outputs: [],
        },
      ] as const,
      functionName: "execute",
      args: ["0x00", [input], 2n ** 64n],
    });
  },
});

export interface LiquidatorOptions {
  slippageBps: bigint;
  minProfit: bigint; // USDG raw
  fromBlock: bigint;
}

/** Fallback liquidation bot: discovers borrowers from Morpho `Borrow` events, reads positions, liquidates unhealthy
 * ones through `LendoraLiquidator`. Stateless apart from a borrower cache that is rebuilt from logs on restart. */
export class LiquidatorBot {
  private borrowers = new Map<string, Set<`0x${string}`>>();
  private scannedTo = new Map<string, bigint>();

  constructor(
    private readonly client: PublicClient,
    private readonly sender: TxSender,
    private readonly d: ChainDeployment,
    private readonly swap: SwapBuilder,
    private readonly recipient: `0x${string}`,
    private readonly opts: LiquidatorOptions,
    private readonly health?: Health,
    private readonly log: (m: string) => void = console.log,
  ) {}

  async discover(ticker: string, toBlock: bigint): Promise<Set<`0x${string}`>> {
    const s = this.d.stocks[ticker];
    const set = this.borrowers.get(ticker) ?? new Set();
    const from = this.scannedTo.get(ticker) ?? this.opts.fromBlock;
    if (toBlock >= from) {
      const logs = await this.client.getLogs({
        address: this.d.morpho,
        event: borrowEvent,
        args: {id: s.marketId},
        fromBlock: from,
        toBlock,
      });
      for (const l of logs) set.add(l.args.onBehalf as `0x${string}`);
      this.scannedTo.set(ticker, toBlock + 1n);
    }
    this.borrowers.set(ticker, set);
    return set;
  }

  async positions(s: StockDeployment, who: `0x${string}`[]): Promise<PositionView[]> {
    const market = await this.client.readContract({address: this.d.morpho, abi: morphoAbi, functionName: "market", args: [s.marketId]});
    const raw = await Promise.all(
      who.map((b) => this.client.readContract({address: this.d.morpho, abi: morphoAbi, functionName: "position", args: [s.marketId, b]})),
    );
    return raw.map((p, i) => {
      const shares = p.borrowShares;
      // toAssetsUp with Morpho's virtual shares/assets (1e6 / 1).
      const borrowed =
        (BigInt(shares) * (market.totalBorrowAssets + 1n) + (market.totalBorrowShares + 10n ** 6n) - 1n) /
        (market.totalBorrowShares + 10n ** 6n);
      return {borrower: who[i], collateral: p.collateral, borrowShares: BigInt(shares), borrowed};
    });
  }

  async tick(): Promise<LiquidationPlan[]> {
    const block = await this.client.getBlock();
    const done: LiquidationPlan[] = [];
    for (const ticker of Object.keys(this.d.stocks)) {
      const s = this.d.stocks[ticker];
      try {
        const who = [...(await this.discover(ticker, block.number))];
        if (who.length > 0) {
          const [price, answer] = await Promise.all([
            this.client.readContract({address: s.oracle, abi: lendoraOracleAbi, functionName: "price"}),
            this.client.readContract({address: s.oracle, abi: lendoraOracleAbi, functionName: "stockAnswer"}),
          ]);
          for (const p of await this.positions(s, who)) {
            const plan = planLiquidation(p, price, BigInt(s.lltv), answer[0], 8, this.opts.slippageBps);
            if (!plan) continue;
            if (plan.expectedProfit < this.opts.minProfit && !plan.badDebt) {
              this.log(`[liquidator] ${ticker} ${p.borrower} unprofitable (${plan.expectedProfit})`);
              continue;
            }
            await this.execute(s, marketParams(this.d, s), plan, block.timestamp);
            done.push(plan);
          }
        }
        this.health?.ok(ticker, block.number);
      } catch (e) {
        this.health?.fail(ticker, e);
        this.log(`[liquidator] ${ticker} error: ${safeErrorLine(e, process.env)}`);
      }
    }
    return done;
  }

  private async execute(s: StockDeployment, m: MarketParams, plan: LiquidationPlan, now: bigint): Promise<void> {
    const liquidator = this.d.liquidator!;
    const data = encodeFunctionData({
      abi: lendoraLiquidatorAbi,
      functionName: "liquidate",
      args: [
        {
          market: m,
          borrower: plan.borrower,
          seizedAssets: plan.seizedAssets,
          repaidShares: plan.repaidShares,
          swap: {
            target: this.swap.target,
            data: this.swap.buy(s.stockToken, this.d.usdg, plan.usdgIn, liquidator),
            amountIn: plan.usdgIn,
            minOut: plan.expectedRepaid,
          },
          minProfit: plan.badDebt ? 0n : this.opts.minProfit,
          recipient: this.recipient,
          deadline: now + 600n,
        },
      ],
    });
    this.log(`[liquidator] liquidate ${plan.borrower} repaid~${plan.expectedRepaid} seized~${plan.expectedSeized} usdgIn=${plan.usdgIn}`);
    await this.sender.send(liquidator, data, `liquidate ${plan.borrower}`);
  }
}

/**
 * Where liquidation profit goes. MN-R6: on mainnet (4663) `LIQUIDATOR_RECIPIENT` must be set explicitly (the treasury
 * Safe or the keeper's sweep address); elsewhere it defaults to the signer, then the owner.
 */
export function liquidatorRecipient(key: DeploymentKey, configured: string | undefined, signer: Address | undefined, owner: Address): Address {
  if (configured) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(configured)) throw new Error("LIQUIDATOR_RECIPIENT must be an address");
    return configured as Address;
  }
  if (key === 4663) throw new Error("mainnet (4663) needs LIQUIDATOR_RECIPIENT (MN-R6)");
  return signer ?? owner;
}
