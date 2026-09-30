import {encodeAbiParameters, encodeFunctionData, parseAbiItem, type Hex, type PublicClient} from "viem";
import {erc20Abi, feeConverterAbi, feeSplitterAbi, isUsRegularHours, marketHoursAbi, lendoraOracleAbi, vaultV2FullAbi, type ChainDeployment, safeErrorLine} from "@lendora/sdk";
import type {TxSender} from "../common/signer.js";
import type {Health} from "../common/health.js";

const convertedEvent = parseAbiItem("event Converted(address indexed vault, uint256 shares, uint256 stockIn, uint256 usdgOut, uint256 oracleValue, address destination)");
const distributedEvent = parseAbiItem("event Distributed(address indexed token, uint256 amount)");
/** UniversalRouter `ActionConstants.CONTRACT_BALANCE`: swap everything the router holds (SwapMode.Transfer). */
export const UR_CONTRACT_BALANCE = 1n << 255n;

/** Builds calldata that sells `stock` for USDG, delivered to `recipient` (the converter). */
export interface SellBuilder {
  target: `0x${string}`;
  sell(stock: `0x${string}`, usdg: `0x${string}`, amountIn: bigint, recipient: `0x${string}`): Hex;
}

/** Anvil / testnet mock aggregator (`SwapMode.Approve`: it pulls `amountIn`). */
export const mockDexSellBuilder = (target: `0x${string}`): SellBuilder => ({
  target,
  sell: (stock, usdg, amountIn, recipient) =>
    encodeFunctionData({
      abi: [{type: "function", name: "swap", stateMutability: "nonpayable", inputs: [{name: "tokenIn", type: "address"}, {name: "tokenOut", type: "address"}, {name: "amountIn", type: "uint256"}, {name: "minOut", type: "uint256"}, {name: "to", type: "address"}], outputs: [{type: "uint256"}]}] as const,
      functionName: "swap",
      args: [stock, usdg, amountIn, 0n, recipient],
    }),
});

/** Uniswap UniversalRouter V3_SWAP_EXACT_IN, `SwapMode.Transfer` (A15 layout): the converter transfers the stock
 * first, the router swaps its whole balance (`CONTRACT_BALANCE`); min-out is enforced by the converter onchain. */
export const universalRouterSellBuilder = (target: `0x${string}`, fee = 500): SellBuilder => ({
  target,
  sell: (stock, usdg, _amountIn, recipient) => {
    const path = (stock + fee.toString(16).padStart(6, "0") + usdg.slice(2)) as Hex;
    const input = encodeAbiParameters(
      [{type: "address"}, {type: "uint256"}, {type: "uint256"}, {type: "bytes"}, {type: "bool"}, {type: "uint256[]"}],
      [recipient, UR_CONTRACT_BALANCE, 0n, path, false, []],
    );
    return encodeFunctionData({
      abi: [{type: "function", name: "execute", stateMutability: "payable", inputs: [{name: "commands", type: "bytes"}, {name: "inputs", type: "bytes[]"}, {name: "deadline", type: "uint256"}], outputs: []}] as const,
      functionName: "execute",
      args: ["0x00", [input], 2n ** 64n],
    });
  },
});

export interface FeeConverterOptions {
  /** Convert as soon as a balance is worth this much (USDG raw; FE-R4: $1k). */
  thresholdUsdg: bigint;
  /** Otherwise convert at least this often (seconds; FE-R4: weekly). */
  periodSec: bigint;
  /** Never bother below this (USDG raw). */
  minUsdg: bigint;
  /** Keeper-side slippage (bps); the converter enforces 1% onchain whatever this is. */
  slippageBps: bigint;
  /** Only in the NYSE regular session (deepest liquidity); onchain the feed session (24/5) is the gate. */
  regularHoursOnly: boolean;
  /** First block to scan for past conversions and distributions. */
  fromBlock: bigint;
}

export const defaultFeeConverterOptions: FeeConverterOptions = {thresholdUsdg: 1_000_000_000n, periodSec: 7n * 86_400n, minUsdg: 10_000_000n, slippageBps: 100n, regularHoursOnly: true, fromBlock: 0n};

export interface FeePlan {
  kind: "distribute" | "convert";
  ticker: string;
  /** Converter name ("treasury" | "backstop") for conversions. */
  converter?: string;
  shares: bigint;
  valueUsdg: bigint;
  minUsdgOut?: bigint;
  reason: "threshold" | "period";
}

/**
 * FE-R4 keeper: calls `FeeSplitter.distribute(vault)` and `FeeConverter.convert` for each converter and stock when a
 * balance is worth ≥ `thresholdUsdg`, or ≥ `minUsdg` and the last one was ≥ `periodSec` ago. The schedule is read
 * from chain (last `Distributed` / `Converted` event), so it is restart-safe and replays are no-ops (the balance is
 * gone after a conversion). It can only trigger: USDG goes to each converter's owner-set destination.
 */
export class FeeConverterBot {
  private lastSeen = new Map<string, bigint>(); // key → unix time of the last event
  private scannedTo = new Map<string, bigint>();

  constructor(
    private readonly client: PublicClient,
    private readonly sender: TxSender,
    private readonly d: ChainDeployment,
    private readonly sell: SellBuilder,
    private readonly opts: FeeConverterOptions = defaultFeeConverterOptions,
    private readonly health?: Health,
    private readonly log: (m: string) => void = console.log,
  ) {}

  private converters(): [string, `0x${string}`][] {
    const out: [string, `0x${string}`][] = [];
    if (this.d.treasuryConverter) out.push(["treasury", this.d.treasuryConverter]);
    if (this.d.backstopConverter) out.push(["backstop", this.d.backstopConverter]);
    return out;
  }

  /** Unix time of the latest matching event since `fromBlock` (incremental scan; rebuilt from logs on restart). */
  private async lastEventAt(key: string, address: `0x${string}`, kind: "converted" | "distributed", vault: `0x${string}`, toBlock: bigint): Promise<bigint | undefined> {
    const from = this.scannedTo.get(key) ?? this.opts.fromBlock;
    if (toBlock >= from) {
      const logs =
        kind === "converted"
          ? await this.client.getLogs({address, event: convertedEvent, args: {vault}, fromBlock: from, toBlock})
          : await this.client.getLogs({address, event: distributedEvent, args: {token: vault}, fromBlock: from, toBlock});
      const last = logs.at(-1);
      if (last?.blockNumber !== undefined && last.blockNumber !== null) {
        const b = await this.client.getBlock({blockNumber: last.blockNumber});
        this.lastSeen.set(key, b.timestamp);
      }
      this.scannedTo.set(key, toBlock + 1n);
    }
    return this.lastSeen.get(key);
  }

  private due(value: bigint, last: bigint | undefined, now: bigint): FeePlan["reason"] | undefined {
    if (value >= this.opts.thresholdUsdg) return "threshold";
    if (value >= this.opts.minUsdg && (last === undefined || now - last >= this.opts.periodSec)) return "period";
    return undefined;
  }

  /** Oracle value (USDG raw) of `shares` of the vault, via the converter's onchain quote (feed price, no buffer). */
  private async valueOf(converter: `0x${string}`, vault: `0x${string}`, shares: bigint): Promise<{stockIn: bigint; value: bigint; floor: bigint}> {
    const stockIn = await this.client.readContract({address: vault, abi: vaultV2FullAbi, functionName: "previewRedeem", args: [shares]});
    const [value, floor] = await this.client.readContract({address: converter, abi: feeConverterAbi, functionName: "quote", args: [vault, stockIn]});
    return {stockIn, value, floor};
  }

  async tick(): Promise<FeePlan[]> {
    const block = await this.client.getBlock();
    const now = block.timestamp;
    const plans: FeePlan[] = [];
    const convs = this.converters();
    if (!this.d.feeSplitter || convs.length === 0) return plans;
    for (const ticker of Object.keys(this.d.stocks)) {
      const s = this.d.stocks[ticker];
      const key = `fees:${ticker}`;
      try {
        // 1. Split the splitter's fee shares (permissionless).
        const held = await this.client.readContract({address: s.vault, abi: erc20Abi, functionName: "balanceOf", args: [this.d.feeSplitter]});
        if (held > 0n) {
          const {value} = await this.valueOf(convs[0][1], s.vault, held);
          const reason = this.due(value, await this.lastEventAt(`d:${ticker}`, this.d.feeSplitter, "distributed", s.vault, block.number), now);
          if (reason) {
            this.log(`[fee-converter] distribute ${ticker} ${held} shares (~${value} USDG raw, ${reason})`);
            await this.sender.send(this.d.feeSplitter, encodeFunctionData({abi: feeSplitterAbi, functionName: "distribute", args: [s.vault]}), `distribute ${ticker}`);
            plans.push({kind: "distribute", ticker, shares: held, valueUsdg: value, reason});
          }
        }
        // 2. Convert each converter's shares, only when the conversion can succeed.
        for (const [name, conv] of convs) {
          const plan = await this.planConversion(ticker, name, conv, now, block.number);
          if (plan) {
            await this.execute(ticker, conv, plan);
            plans.push(plan);
          }
        }
        this.health?.ok(key, block.number);
      } catch (e) {
        this.health?.fail(key, e);
        this.log(`[fee-converter] ${ticker} error: ${safeErrorLine(e, process.env)}`);
      }
    }
    return plans;
  }

  private async planConversion(ticker: string, name: string, conv: `0x${string}`, now: bigint, blockNumber: bigint): Promise<FeePlan | undefined> {
    const s = this.d.stocks[ticker];
    let shares = await this.client.readContract({address: s.vault, abi: erc20Abi, functionName: "balanceOf", args: [conv]});
    if (shares === 0n) return undefined;
    const {value} = await this.valueOf(conv, s.vault, shares);
    const reason = this.due(value, await this.lastEventAt(`c:${name}:${ticker}`, conv, "converted", s.vault, blockNumber), now);
    if (!reason) return undefined;
    // Gates the contract enforces (checked first so nothing is sent that would revert) plus the keeper's own.
    const [open, reasons] = await Promise.all([
      this.client.readContract({address: this.d.marketHours, abi: marketHoursAbi, functionName: "isOpen", args: [now]}),
      this.client.readContract({address: s.oracle, abi: lendoraOracleAbi, functionName: "guardReasons"}),
    ]);
    if (!open || reasons !== 0n) {
      this.log(`[fee-converter] ${name} ${ticker} due (${reason}) but ${!open ? "feed session closed" : `guard tripped (${reasons})`}; waiting`);
      return undefined;
    }
    if (this.opts.regularHoursOnly && !isUsRegularHours(Number(now))) return undefined;
    // Redeem only what idle covers (no forceDeallocate: conversion must never pull borrowers' liquidity).
    const idle = await this.client.readContract({address: s.wrapper, abi: erc20Abi, functionName: "balanceOf", args: [s.vault]});
    const stockNeeded = await this.client.readContract({address: s.vault, abi: vaultV2FullAbi, functionName: "previewRedeem", args: [shares]});
    if (stockNeeded > idle) {
      shares = await this.client.readContract({address: s.vault, abi: vaultV2FullAbi, functionName: "convertToShares", args: [idle]});
      if (shares === 0n) {
        this.log(`[fee-converter] ${name} ${ticker} due but the vault has no idle liquidity; waiting`);
        return undefined;
      }
    }
    const q = await this.valueOf(conv, s.vault, shares);
    // 1 bp headroom: interest accrued between this read and execution can only raise the onchain floor slightly.
    const [, floorWithHeadroom] = await this.client.readContract({address: conv, abi: feeConverterAbi, functionName: "quote", args: [s.vault, (q.stockIn * 10_001n) / 10_000n]});
    const keeperMin = (q.value * (10_000n - this.opts.slippageBps)) / 10_000n;
    const minUsdgOut = keeperMin > floorWithHeadroom ? keeperMin : floorWithHeadroom;
    return {kind: "convert", ticker, converter: name, shares, valueUsdg: q.value, minUsdgOut, reason};
  }

  private async execute(ticker: string, conv: `0x${string}`, p: FeePlan): Promise<void> {
    const s = this.d.stocks[ticker];
    const stockIn = await this.client.readContract({address: s.vault, abi: vaultV2FullAbi, functionName: "previewRedeem", args: [p.shares]});
    const data = encodeFunctionData({
      abi: feeConverterAbi,
      functionName: "convert",
      args: [s.vault, p.shares, p.minUsdgOut!, {target: this.sell.target, data: this.sell.sell(s.stockToken, this.d.usdg, stockIn, conv)}],
    });
    this.log(`[fee-converter] convert ${p.converter} ${ticker} ${p.shares} shares (~${p.valueUsdg} USDG raw, min ${p.minUsdgOut}, ${p.reason})`);
    await this.sender.send(conv, data, `convert ${p.converter} ${ticker}`);
  }
}
