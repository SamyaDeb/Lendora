import {encodeFunctionData, maxUint256, type Hex, type TransactionReceipt} from "viem";
import {generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount} from "viem/accounts";
import {
  ATTESTATION_TTL_SEC,
  attestationDomain,
  attestationTypes,
  capIds,
  encodeMarketParams,
  erc20Abi,
  marketAdapterAbi,
  marketHoursAbi,
  marketParamsOf,
  mockAggregatorAbi,
  mockAggregatorSwap,
  mockStockTokenAbi,
  mockSwapAggregatorAbi,
  mockUniswapV3PoolAbi,
  mockUsdgAbi,
  morphoAbi,
  planAllocation,
  tickForAnswer,
  stocklineOracleAbi,
  stocklineRouterAbi,
  stockWrapperAbi,
  vaultV2Abi,
  type AllocatorAction,
  type ChainDeployment,
  type StockDeployment,
} from "@stockline/sdk";
import {DEPLOYER, type Anvil} from "./anvil.js";

const WAD = 10n ** 18n;
/** Feed answers (8 dp) of the mocks at deployment (contracts/script/LocalMocks.sol, 01-chain-facts §4). */
export const INITIAL_PRICES: Record<string, bigint> = {SPY: 772_33000000n, NVDA: 225_66000000n, AAPL: 341_45000000n};
/** Oracle guard reason bits (StocklineOracleBase). */
export const GUARD = {MANUAL: 1n, DEVIATION: 2n, L2_GAP: 4n, STALE: 8n, TOKEN_PAUSED: 128n} as const;

export interface DriverEvent {
  kind: string;
  ticker?: string;
  user?: `0x${string}`;
  block: bigint;
  timestamp: bigint;
  hash?: Hex;
  detail?: Record<string, string>;
}

export interface DriverOptions {
  /** Compliance signer key for attestations (RT-R2). Default: a fresh random key, installed on the router through the
   * timelock (impersonated on anvil). Never a committed key. */
  attestationKey?: Hex;
  /** Get attestations elsewhere (e.g. the compliance service on testnet) instead of signing them here. */
  attestationProvider?: (user: `0x${string}`) => Promise<{expiry: bigint; signature: Hex}>;
  log?: (m: string) => void;
  /** Mock operator and owner-side sender (anvil: the DeployLocal deployer; a 46630 fork: the testnet deployer, which
   * gates every mock and holds the testnet roles). */
  operator?: `0x${string}`;
}

/** Uniswap v3 tick of a stock(18 dp)/USDG(6 dp) pool (stock = token0) at a feed answer with 8 dp. */
export const tickForPrice = tickForAnswer;

/**
 * Seeds realistic Stockline activity on anvil (Phase 2 task 0): lends, borrows, shorts, repays, closes, liquidations,
 * feed rounds across weekends, issuer pauses and guard trips. Drives the mocks exactly like the real world would
 * (feed rounds, DEX rates and pool ticks move together) and calls the real contracts through the router. Every action
 * is recorded in `events` so tests of the indexer, API, web app and alerts can assert against it.
 */
export class ChainDriver {
  readonly d: ChainDeployment;
  readonly events: DriverEvent[] = [];
  readonly prices: Record<string, bigint> = {...INITIAL_PRICES};
  private signer?: PrivateKeyAccount;
  private readonly log: (m: string) => void;
  /** See `DriverOptions.operator`. */
  readonly op: `0x${string}`;

  constructor(
    readonly a: Anvil,
    private readonly opts: DriverOptions = {},
  ) {
    this.d = a.d;
    this.log = opts.log ?? (() => {});
    this.op = opts.operator ?? DEPLOYER;
  }

  get tickers(): string[] {
    return Object.keys(this.d.stocks);
  }

  stock(ticker: string): StockDeployment {
    const s = this.d.stocks[ticker];
    if (!s) throw new Error(`unknown ticker ${ticker}`);
    return s;
  }

  async now(): Promise<bigint> {
    return (await this.a.client.getBlock()).timestamp;
  }

  private async record(kind: string, r: TransactionReceipt | undefined, e: Omit<DriverEvent, "kind" | "block" | "timestamp"> = {}) {
    const block = r ? await this.a.client.getBlock({blockNumber: r.blockNumber}) : await this.a.client.getBlock();
    const ev: DriverEvent = {kind, block: block.number, timestamp: block.timestamp, hash: r?.transactionHash, ...e};
    this.events.push(ev);
    this.log(`[driver] #${ev.block} t=${ev.timestamp} ${kind}${e.ticker ? ` ${e.ticker}` : ""}${e.user ? ` ${e.user.slice(0, 8)}` : ""}`);
    return ev;
  }

  private call(abi: readonly unknown[], functionName: string, args: readonly unknown[] = []): Hex {
    return (encodeFunctionData as (p: unknown) => Hex)({abi, functionName, args});
  }

  // ------------------------------------------------------------------ time and prices

  /** Mine a block at `ts` without feed rounds (e.g. while the feed is frozen). */
  async warp(ts: bigint): Promise<void> {
    await this.a.setTime(ts);
  }

  /** Walk to `to` in `step`-second blocks without feed rounds (keeps L2 block gaps small). */
  async walk(to: bigint, step = 1800n): Promise<void> {
    for (let t = (await this.now()) + step; t < to; t += step) await this.a.setTime(t);
    await this.a.setTime(to);
  }

  /** Publish a feed round for every stock (and USDG) at the current block time, and move the mock DEX (swap rates,
   * pool tick) to the same prices so router swaps and the guard keeper see a consistent market. */
  async rounds(prices: Partial<Record<string, bigint>> = {}): Promise<void> {
    const m = this.d.mocks!;
    for (const t of this.tickers) {
      const p = prices[t] ?? this.prices[t];
      this.prices[t] = p;
      await this.a.send(this.op, m[`${t}_feed`], this.call(mockAggregatorAbi, "setAnswer", [p]));
      await this.setDex(t, p);
    }
    const r = await this.a.send(this.op, m.usdgFeed, this.call(mockAggregatorAbi, "setAnswer", [100_000_000n]));
    await this.record("rounds", r, {detail: Object.fromEntries(this.tickers.map((t) => [t, this.prices[t].toString()]))});
  }

  /** Move to `ts` and publish fresh rounds. */
  async freshRounds(ts: bigint, prices: Partial<Record<string, bigint>> = {}): Promise<void> {
    await this.a.setTime(ts);
    await this.rounds(prices);
  }

  /** Mock DEX at `answer8` (USD per stock, 8 dp) both ways, and the TWAP pool tick. */
  async setDex(ticker: string, answer8: bigint): Promise<void> {
    const m = this.d.mocks!;
    const s = this.stock(ticker);
    await this.a.send(this.op, m.swapAggregator, this.call(mockSwapAggregatorAbi, "setRate", [s.stockToken, this.d.usdg, (answer8 * 10n ** 6n) / 10n ** 8n]));
    await this.a.send(this.op, m.swapAggregator, this.call(mockSwapAggregatorAbi, "setRate", [this.d.usdg, s.stockToken, (10n ** 8n * 10n ** 36n) / (answer8 * 10n ** 6n)]));
    await this.a.send(this.op, m[`${ticker}_USDG_pool`], this.call(mockUniswapV3PoolAbi, "setTick", [tickForPrice(answer8)]));
  }

  // ------------------------------------------------------------------ balances

  async mintStock(ticker: string, to: `0x${string}`, amount: bigint): Promise<void> {
    await this.a.send(this.op, this.stock(ticker).stockToken, this.call(mockStockTokenAbi, "mint", [to, amount]));
  }

  async mintUsdg(to: `0x${string}`, amount: bigint): Promise<void> {
    await this.a.send(this.op, this.d.usdg, this.call(mockUsdgAbi, "mint", [to, amount]));
  }

  private async approve(token: `0x${string}`, owner: `0x${string}`, spender: `0x${string}`): Promise<void> {
    const allowance = await this.a.client.readContract({address: token, abi: erc20Abi, functionName: "allowance", args: [owner, spender]});
    if (allowance < maxUint256 / 2n) await this.a.send(owner, token, this.call(erc20Abi, "approve", [spender, maxUint256]));
  }

  private async deadline(): Promise<bigint> {
    return (await this.now()) + 3600n;
  }

  // ------------------------------------------------------------------ lenders (US-L1, US-L3)

  async lend(ticker: string, user: `0x${string}`, amount: bigint): Promise<TransactionReceipt> {
    const s = this.stock(ticker);
    await this.mintStock(ticker, user, amount);
    await this.approve(s.stockToken, user, this.d.router!);
    const r = await this.a.send(user, this.d.router!, this.call(stocklineRouterAbi, "lend", [s.stockToken, amount, 0n, user, await this.deadline()]));
    await this.record("lend", r, {ticker, user, detail: {amount: amount.toString()}});
    return r;
  }

  /** Redeem `shares` of `rSTOCK` (all if omitted) through the router (LM-R22 forceDeallocate when idle is short). */
  async withdrawLend(ticker: string, user: `0x${string}`, shares?: bigint): Promise<TransactionReceipt> {
    const s = this.stock(ticker);
    const sh = shares ?? (await this.a.client.readContract({address: s.vault, abi: erc20Abi, functionName: "balanceOf", args: [user]}));
    await this.approve(s.vault, user, this.d.router!);
    const r = await this.a.send(user, this.d.router!, this.call(stocklineRouterAbi, "withdrawLend", [s.stockToken, sh, 0n, user, await this.deadline()]));
    await this.record("withdrawLend", r, {ticker, user, detail: {shares: sh.toString()}});
    return r;
  }

  // ------------------------------------------------------------------ allocator (LM-R30, LM-R31)

  /** One allocator pass per market with the SDK rule (what the allocator keeper does), sent as the allocator role. */
  async allocate(tickers = this.tickers): Promise<Record<string, AllocatorAction>> {
    const out: Record<string, AllocatorAction> = {};
    for (const t of tickers) {
      const s = this.stock(t);
      const p = marketParamsOf(this.d, s);
      const ids = capIds(s.adapter, p);
      const c = this.a.client;
      const [totalAssets, idle, adapterAssets, market, pull, allocation, absoluteCap, relativeCap] = await Promise.all([
        c.readContract({address: s.vault, abi: vaultV2Abi, functionName: "totalAssets"}),
        c.readContract({address: s.wrapper, abi: erc20Abi, functionName: "balanceOf", args: [s.vault]}),
        c.readContract({address: s.adapter, abi: marketAdapterAbi, functionName: "expectedSupplyAssets", args: [s.marketId]}),
        c.readContract({address: this.d.morpho, abi: morphoAbi, functionName: "market", args: [s.marketId]}),
        c.readContract({address: s.oracle, abi: stocklineOracleAbi, functionName: "guardTripped"}),
        c.readContract({address: s.vault, abi: vaultV2Abi, functionName: "allocation", args: [ids[2]]}),
        c.readContract({address: s.vault, abi: vaultV2Abi, functionName: "absoluteCap", args: [ids[2]]}),
        c.readContract({address: s.vault, abi: vaultV2Abi, functionName: "relativeCap", args: [ids[2]]}),
      ]);
      const action = planAllocation(
        {totalAssets, idle, allocation, absoluteCap, relativeCap, adapterAssets, marketSupply: market.totalSupplyAssets, marketBorrow: market.totalBorrowAssets, pull},
        {uMax: 9n * 10n ** 17n, minMove: 10n ** 15n},
      );
      out[t] = action;
      if (action.kind === "none") continue;
      const r = await this.a.send(this.d.roles.allocator, s.vault, this.call(vaultV2Abi, action.kind, [s.adapter, encodeMarketParams(p), action.assets]));
      await this.record(action.kind, r, {ticker: t, detail: {assets: action.assets.toString(), reason: action.reason}});
    }
    return out;
  }

  // ------------------------------------------------------------------ compliance (RT-R2)

  /** Install the driver's compliance signer on the router (owner = timelock, impersonated on anvil). */
  async useAttestationSigner(): Promise<`0x${string}`> {
    this.signer = privateKeyToAccount(this.opts.attestationKey ?? generatePrivateKey());
    // Live chains (testnet): the deployment already installed the compliance key; the owner (a timelock) cannot be
    // impersonated there, so only anvil needs the owner call below.
    const current = await this.a.client.readContract({address: this.d.router!, abi: stocklineRouterAbi, functionName: "attestationSigner"});
    if (current.toLowerCase() === this.signer.address.toLowerCase()) return this.signer.address;
    const owner = await this.a.client.readContract({address: this.d.router!, abi: stocklineRouterAbi, functionName: "owner"});
    await this.a.send(owner, this.d.router!, this.call(stocklineRouterAbi, "setAttestationSigner", [this.signer.address]));
    return this.signer.address;
  }

  /** An EIP-712 attestation for `user`, valid 24h (CP-R3). */
  async attest(user: `0x${string}`, ttl = ATTESTATION_TTL_SEC): Promise<{expiry: bigint; signature: Hex}> {
    if (this.opts.attestationProvider) return this.opts.attestationProvider(user);
    if (!this.signer) await this.useAttestationSigner();
    const expiry = (await this.now()) + ttl;
    const signature = await this.signer!.signTypedData({
      domain: attestationDomain(await this.a.client.getChainId(), this.d.router!), // 31337 on anvil, 46630 on testnet
      types: attestationTypes,
      primaryType: "Attestation",
      message: {user, expiry},
    });
    return {expiry, signature};
  }

  // ------------------------------------------------------------------ borrowers (US-B1…B5)

  private async borrowerSetup(user: `0x${string}`, collateral: bigint): Promise<void> {
    const authorized = await this.a.client.readContract({address: this.d.morpho, abi: morphoAbi, functionName: "isAuthorized", args: [user, this.d.router!]});
    if (!authorized) await this.a.send(user, this.d.morpho, this.call(morphoAbi, "setAuthorization", [this.d.router!, true]));
    if (collateral > 0n) await this.mintUsdg(user, collateral);
    await this.approve(this.d.usdg, user, this.d.router!);
  }

  /** US-B1: USDG collateral → borrow `amount` raw stock → Stock Token to the user. */
  async borrow(ticker: string, user: `0x${string}`, collateral: bigint, amount: bigint): Promise<TransactionReceipt> {
    await this.borrowerSetup(user, collateral);
    const att = await this.attest(user);
    const r = await this.a.send(user, this.d.router!, this.call(stocklineRouterAbi, "borrow", [this.stock(ticker).stockToken, collateral, amount, user, att, await this.deadline()]));
    await this.record("borrow", r, {ticker, user, detail: {collateral: collateral.toString(), amount: amount.toString()}});
    return r;
  }

  /** US-B2: borrow and sell for USDG on the mock DEX (1% slippage bound). */
  async openShort(ticker: string, user: `0x${string}`, collateral: bigint, amount: bigint, compound = false): Promise<TransactionReceipt> {
    const s = this.stock(ticker);
    await this.borrowerSetup(user, collateral);
    const att = await this.attest(user);
    const expected = (amount * this.prices[ticker] * 10n ** 6n) / (10n ** 8n * WAD);
    const swap = mockAggregatorSwap(this.d.mocks!.swapAggregator, s.stockToken, this.d.usdg, amount, (expected * 99n) / 100n, this.d.router!);
    const r = await this.a.send(user, this.d.router!, this.call(stocklineRouterAbi, "openShort", [s.stockToken, collateral, amount, swap, compound, user, att, await this.deadline()]));
    await this.record("openShort", r, {ticker, user, detail: {collateral: collateral.toString(), amount: amount.toString(), compound: String(compound)}});
    return r;
  }

  /** US-B4: buy back the whole debt with USDG (2% headroom, leftovers refunded), repay by shares, withdraw collateral. */
  async closeShort(ticker: string, user: `0x${string}`): Promise<TransactionReceipt> {
    const s = this.stock(ticker);
    const debt = await this.debtOf(ticker, user);
    const usdgIn = (debt * this.prices[ticker] * 10n ** 6n * 102n) / (10n ** 8n * WAD * 100n) + 1n;
    await this.mintUsdg(user, usdgIn);
    await this.approve(this.d.usdg, user, this.d.router!);
    const swap = mockAggregatorSwap(this.d.mocks!.swapAggregator, this.d.usdg, s.stockToken, usdgIn, debt, this.d.router!);
    const r = await this.a.send(user, this.d.router!, this.call(stocklineRouterAbi, "closeShort", [s.stockToken, usdgIn, swap, user, await this.deadline()]));
    await this.record("closeShort", r, {ticker, user, detail: {usdgIn: usdgIn.toString(), debt: debt.toString()}});
    return r;
  }

  /** US-B5: repay `assets` raw stock, or everything (by shares, RT-R4) if omitted. */
  async repay(ticker: string, user: `0x${string}`, assets?: bigint): Promise<TransactionReceipt> {
    const s = this.stock(ticker);
    const pull = assets ?? ((await this.debtOf(ticker, user)) * 1001n) / 1000n + 1n;
    await this.mintStock(ticker, user, pull);
    await this.approve(s.stockToken, user, this.d.router!);
    const args = assets !== undefined ? [s.stockToken, assets, 0n, user, await this.deadline()] : [s.stockToken, 0n, maxUint256, user, await this.deadline()];
    const r = await this.a.send(user, this.d.router!, this.call(stocklineRouterAbi, "repay", args));
    await this.record("repay", r, {ticker, user, detail: {assets: String(assets ?? "all")}});
    return r;
  }

  /** US-B5 rescue top-up (RT-R8): only for a position with debt; the router reverts `NoDebtPosition` otherwise. */
  async addCollateral(ticker: string, user: `0x${string}`, amount: bigint): Promise<TransactionReceipt> {
    await this.borrowerSetup(user, amount);
    const r = await this.a.send(user, this.d.router!, this.call(stocklineRouterAbi, "addCollateral", [this.stock(ticker).stockToken, amount, user, await this.deadline()]));
    await this.record("addCollateral", r, {ticker, user, detail: {amount: amount.toString()}});
    return r;
  }

  async withdrawCollateral(ticker: string, user: `0x${string}`, amount: bigint): Promise<TransactionReceipt> {
    const r = await this.a.send(user, this.d.router!, this.call(stocklineRouterAbi, "withdrawCollateral", [this.stock(ticker).stockToken, amount, user, await this.deadline()]));
    await this.record("withdrawCollateral", r, {ticker, user, detail: {amount: amount.toString()}});
    return r;
  }

  // ------------------------------------------------------------------ liquidations

  /** A standard Morpho liquidation (no Stockline helper): the liquidator wraps Stock Tokens and repays `fraction` of
   * the borrower's shares, seizing `clUSDG`. */
  async liquidate(ticker: string, borrower: `0x${string}`, liquidator: `0x${string}`, fractionBps = 5000n): Promise<TransactionReceipt> {
    const s = this.stock(ticker);
    const p = marketParamsOf(this.d, s);
    const pos = await this.a.client.readContract({address: this.d.morpho, abi: morphoAbi, functionName: "position", args: [s.marketId, borrower]});
    const shares = (pos.borrowShares * fractionBps) / 10_000n;
    const need = ((await this.debtOf(ticker, borrower)) * fractionBps * 101n) / (10_000n * 100n); // +1% for accrual
    await this.mintStock(ticker, liquidator, need);
    await this.approve(s.stockToken, liquidator, s.wrapper);
    await this.a.send(liquidator, s.wrapper, this.call(stockWrapperAbi, "wrap", [need, liquidator]));
    await this.approve(s.wrapper, liquidator, this.d.morpho);
    const r = await this.a.send(liquidator, this.d.morpho, this.call(morphoAbi, "liquidate", [p, borrower, 0n, shares, "0x"]));
    await this.record("liquidate", r, {ticker, user: borrower, detail: {repaidShares: shares.toString(), liquidator}});
    return r;
  }

  // ------------------------------------------------------------------ guard (OR-R30…R32, D4)

  async poke(tickers = this.tickers): Promise<void> {
    for (const t of tickers) {
      const r = await this.a.send(this.op, this.stock(t).oracle, this.call(stocklineOracleAbi, "poke"));
      await this.record("poke", r, {ticker: t});
    }
  }

  /** D4: the issuer pauses the Stock Token → the oracle's TOKEN_PAUSED reason; `poke()` latches and emits it. */
  async issuerPause(ticker: string, paused: boolean): Promise<void> {
    const r = await this.a.send(this.op, this.stock(ticker).stockToken, this.call(mockStockTokenAbi, paused ? "pause" : "unpause"));
    await this.record(paused ? "issuerPause" : "issuerUnpause", r, {ticker});
    await this.poke([ticker]);
  }

  /** Guardian `trip` / `clear` of an offchain reason (MANUAL by default). */
  async guardian(ticker: string, action: "trip" | "clear", reason: bigint = GUARD.MANUAL): Promise<void> {
    const r = await this.a.send(this.d.roles.guardian, this.stock(ticker).oracle, this.call(stocklineOracleAbi, action, [reason]));
    await this.record(`guardian:${action}`, r, {ticker, detail: {reason: reason.toString()}});
  }

  /** A dividend-style multiplier change inside an `oraclePaused()` window (OR-R3 accepted path): pause the oracle
   * flag, poke, update the multiplier, unpause, fresh round, poke. */
  async multiplierChange(ticker: string, multiplierWad: bigint): Promise<void> {
    const token = this.stock(ticker).stockToken;
    await this.a.send(this.op, token, this.call(mockStockTokenAbi, "pauseOracle"));
    await this.poke([ticker]);
    const r = await this.a.send(this.op, token, this.call(mockStockTokenAbi, "setUIMultiplier", [multiplierWad]));
    await this.record("multiplier", r, {ticker, detail: {multiplier: multiplierWad.toString()}});
    await this.a.send(this.op, token, this.call(mockStockTokenAbi, "unpauseOracle"));
    await this.poke([ticker]);
    await this.a.setTime((await this.now()) + 60n);
    await this.rounds();
    await this.poke([ticker]);
  }

  // ------------------------------------------------------------------ reads

  /** Current debt of `user` in raw stock units (Morpho `expectedBorrowAssets` via the router's accrued view). */
  async debtOf(ticker: string, user: `0x${string}`): Promise<bigint> {
    const s = this.stock(ticker);
    const [pos, market] = await Promise.all([
      this.a.client.readContract({address: this.d.morpho, abi: morphoAbi, functionName: "position", args: [s.marketId, user]}),
      this.a.client.readContract({address: this.d.morpho, abi: morphoAbi, functionName: "market", args: [s.marketId]}),
    ]);
    // Shares → assets, rounded up (Morpho SharesMathLib, virtual shares 1e6 / virtual assets 1); the accrual since
    // the last update is covered by the callers' headroom.
    const shares = pos.borrowShares;
    if (shares === 0n) return 0n;
    const num = shares * (market.totalBorrowAssets + 1n);
    const den = market.totalBorrowShares + 10n ** 6n;
    return (num + den - 1n) / den;
  }

  async healthFactor(ticker: string, user: `0x${string}`, at?: bigint): Promise<bigint> {
    return this.a.client.readContract({address: this.d.router!, abi: stocklineRouterAbi, functionName: "healthFactorAt", args: [this.stock(ticker).stockToken, user, at ?? (await this.now())]});
  }

  async isOpen(t?: bigint): Promise<boolean> {
    return this.a.client.readContract({address: this.d.marketHours, abi: marketHoursAbi, functionName: "isOpen", args: [t ?? (await this.now())]});
  }
}
