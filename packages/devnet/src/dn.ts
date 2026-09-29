import {encodeFunctionData, maxUint256, type Hex, type TransactionReceipt} from "viem";
import {deltaNeutralVaultAbi, erc20Abi, mockPerpVenueAbi, navOracleAbi, navReportTypedData, perpAdapterAbi, strategyManagerAbi, type NavReport} from "@stockline/sdk";
import type {ChainDriver} from "./driver.js";

/** DeployLocal's Phase 4 roles on anvil (dev accounts; the node holds the keys, none in the repo). */
export const DN_OPERATOR = "0x976EA74026E726554dB657fA54763abd0C3a0aa9" as const; // anvil #6
export const NAV_SIGNERS = ["0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f", "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720"] as const; // #8, #9

const UNIT = 10n ** 18n;

/**
 * Drives the delta-neutral vault (Phase 4) on anvil for tests and the dev stack: deposits with a real attestation,
 * NAV reports signed by both dev signers (so any move is accepted), the operator's trades through the strategy,
 * venue funding, withdrawal requests, settlement and claims. The rebalancer keeper does the same with its own logic
 * (keepers/src/dnRebalancer); this is the scripted version.
 */
export class DnDriver {
  /** The strategy operator (anvil #6 on the local fixture; the deployer on testnet, A27). */
  readonly operator: `0x${string}`;
  constructor(
    private readonly drv: ChainDriver,
    opts: {operator?: `0x${string}`} = {},
  ) {
    this.operator = opts.operator ?? DN_OPERATOR;
  }

  private get a() {
    return this.drv.a;
  }
  private get dn() {
    const v = this.drv.d.dnVault;
    if (!v) throw new Error("no dnVault in this deployment");
    return v;
  }
  private call(abi: readonly unknown[], functionName: string, args: readonly unknown[] = []): Hex {
    return (encodeFunctionData as (p: unknown) => Hex)({abi, functionName, args});
  }
  private rd<T>(address: `0x${string}`, abi: readonly unknown[], functionName: string, args: readonly unknown[] = []): Promise<T> {
    return (this.a.client.readContract as (p: unknown) => Promise<T>)({address, abi, functionName, args});
  }

  /** Deposit `amount` USDG raw for `user` (minted), with the router's attestation. */
  async deposit(user: `0x${string}`, amount: bigint): Promise<TransactionReceipt> {
    await this.drv.mintUsdg(user, amount);
    const att = await this.drv.attest(user);
    await this.a.send(user, this.drv.d.usdg, this.call(erc20Abi, "approve", [this.dn.vault, maxUint256]));
    return this.a.send(user, this.dn.vault, this.call(deltaNeutralVaultAbi, "deposit", [amount, user, att]));
  }

  /** A NAV report of the mock venue at the head, signed by both dev signers; one second after the last one. */
  async report(): Promise<void> {
    const last = await this.rd<{timestamp: bigint}>(this.dn.navOracle, navOracleAbi, "lastReport");
    const head = await this.a.client.getBlock();
    if (head.timestamp <= last.timestamp) await this.a.setTime(last.timestamp + 1n);
    const b = await this.a.client.getBlock();
    const n = await this.rd<bigint>(this.dn.strategy, strategyManagerAbi, "sleeveCount");
    const sizes: bigint[] = [];
    for (let i = 0n; i < n; i++) {
      const sl = await this.rd<{perpMarket: Hex}>(this.dn.strategy, strategyManagerAbi, "sleeve", [i]);
      sizes.push((await this.rd<readonly [boolean, bigint]>(this.dn.perpAdapter, perpAdapterAbi, "shortSize", [sl.perpMarket]))[1]);
    }
    const [, equity] = await this.rd<readonly [boolean, bigint]>(this.dn.perpAdapter, perpAdapterAbi, "onchainEquity");
    const r: NavReport = {
      equity,
      deposited: await this.rd<bigint>(this.dn.perpAdapter, perpAdapterAbi, "totalDeposited"),
      requested: await this.rd<bigint>(this.dn.perpAdapter, perpAdapterAbi, "totalRequested"),
      tradeNonce: BigInt(await this.rd<bigint>(this.dn.strategy, strategyManagerAbi, "tradeNonce")),
      timestamp: b.timestamp,
      shortSizes: sizes,
    };
    const td = navReportTypedData(await this.a.client.getChainId(), this.dn.navOracle, r);
    const sigs = await Promise.all(
      [...NAV_SIGNERS].sort((x, y) => (x.toLowerCase() < y.toLowerCase() ? -1 : 1)).map((account) => (this.a.wallet.signTypedData as (p: unknown) => Promise<Hex>)({account, ...(td as object)})),
    );
    await this.a.send(this.operator, this.dn.navOracle, this.call(navOracleAbi, "submit", [r, sigs]));
  }

  /** The 08 structure for sleeve `i` with `usdg` raw of capital: 3/4 spot (90% lent), 1/4 margin, short = spot. */
  async build(i: number, usdg: bigint, lendBps = 9000n): Promise<void> {
    const s = (usdg * 3n) / 4n;
    const m = usdg - s;
    const sl = await this.rd<{stockToken: `0x${string}`}>(this.dn.strategy, strategyManagerAbi, "sleeve", [BigInt(i)]);
    const op = (fn: string, args: readonly unknown[]) => this.a.send(this.operator, this.dn.strategy, this.call(strategyManagerAbi, fn, args));
    await op("pullFromVault", [usdg]);
    const unit = await this.rd<bigint>(this.dn.strategy, strategyManagerAbi, "quote", [BigInt(i), UNIT]);
    const minOut = ((s * UNIT) / unit) * 995n / 1000n;
    const data = this.call([{type: "function", name: "swap", stateMutability: "nonpayable", inputs: [{name: "tokenIn", type: "address"}, {name: "tokenOut", type: "address"}, {name: "amountIn", type: "uint256"}, {name: "minOut", type: "uint256"}, {name: "to", type: "address"}], outputs: [{type: "uint256"}]}], "swap", [this.drv.d.usdg, sl.stockToken, s, 0n, this.dn.strategy]);
    await op("buySpot", [BigInt(i), s, minOut, {target: this.drv.d.mocks!.swapAggregator, data}]);
    const spot = await this.rd<bigint>(this.dn.strategy, strategyManagerAbi, "spotUnits", [BigInt(i)]);
    if (lendBps > 0n) await op("lend", [BigInt(i), (spot * lendBps) / 10_000n]).catch(() => undefined); // DN-R8 may refuse
    await op("depositMargin", [m]);
    await op("adjustShort", [BigInt(i), -spot, 0n]);
  }

  /** One funding period on sleeve `i`'s market (the mock venue; + = shorts receive). */
  async funding(i: number, rateWad: bigint): Promise<void> {
    const sl = await this.rd<{perpMarket: Hex}>(this.dn.strategy, strategyManagerAbi, "sleeve", [BigInt(i)]);
    await this.a.send(this.drv.op, this.dn.perpAdapter, this.call(mockPerpVenueAbi, "applyFunding", [sl.perpMarket, rateWad]));
  }

  async requestRedeem(user: `0x${string}`, shares: bigint): Promise<bigint> {
    await this.a.send(user, this.dn.vault, this.call(deltaNeutralVaultAbi, "requestRedeem", [shares, user, user]));
    return (await this.rd<readonly [bigint, bigint]>(this.dn.vault, deltaNeutralVaultAbi, "queueBounds"))[1] - 1n;
  }

  async withdraw(user: `0x${string}`, assets: bigint): Promise<TransactionReceipt> {
    return this.a.send(user, this.dn.vault, this.call(deltaNeutralVaultAbi, "withdraw", [assets, user, user]));
  }

  async settle(n = 20n): Promise<TransactionReceipt> {
    return this.a.send(this.operator, this.dn.vault, this.call(deltaNeutralVaultAbi, "settle", [n]));
  }

  async claim(id: bigint): Promise<TransactionReceipt> {
    return this.a.send(this.operator, this.dn.vault, this.call(deltaNeutralVaultAbi, "claim", [id]));
  }

  async shares(user: `0x${string}`): Promise<bigint> {
    return this.rd<bigint>(this.dn.vault, erc20Abi, "balanceOf", [user]);
  }
}
