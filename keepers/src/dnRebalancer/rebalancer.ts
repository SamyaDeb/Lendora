import {encodeFunctionData, type Hex, type PublicClient} from "viem";
import {
  deltaNeutralVaultAbi,
  erc20Abi,
  isUsRegularHours,
  marketHoursAbi,
  mockPerpVenueAbi,
  navOracleAbi,
  perpAdapterAbi,
  safeErrorLine,
  strategyManagerAbi,
  vaultV2FullAbi,
  type ChainDeployment,
} from "@lendora/sdk";
import type {TxSender} from "../common/signer.js";
import type {Health} from "../common/health.js";

const WAD = 10n ** 18n;
const BPS = 10_000n;
const UNIT = 10n ** 18n;

/** Builds swap calldata for the strategy's allowlisted target; the strategy measures output and enforces the floor. */
export interface DnSwapBuilder {
  target: `0x${string}`;
  swap(tokenIn: `0x${string}`, tokenOut: `0x${string}`, amountIn: bigint, recipient: `0x${string}`): Hex;
}

/** Anvil / testnet mock aggregator (`SwapMode.Approve`). */
export const mockDexSwapBuilder = (target: `0x${string}`): DnSwapBuilder => ({
  target,
  swap: (tokenIn, tokenOut, amountIn, recipient) =>
    encodeFunctionData({
      abi: [{type: "function", name: "swap", stateMutability: "nonpayable", inputs: [{name: "tokenIn", type: "address"}, {name: "tokenOut", type: "address"}, {name: "amountIn", type: "uint256"}, {name: "minOut", type: "uint256"}, {name: "to", type: "address"}], outputs: [{type: "uint256"}]}] as const,
      functionName: "swap",
      args: [tokenIn, tokenOut, amountIn, 0n, recipient],
    }),
});

/** Hourly funding, signed fraction per hour (+ = shorts receive), oldest first. */
export interface FundingSource {
  hourly(sleeve: number, hours: number): Promise<number[]>;
}

/** Venue margin: equity and maintenance requirement, USDG raw. */
export interface MarginSource {
  read(): Promise<{equity: bigint; maintenance: bigint}>;
}

/** The mock venue exposes both onchain. */
export class MockVenueMargin implements MarginSource {
  constructor(
    private readonly client: PublicClient,
    private readonly venue: `0x${string}`,
  ) {}
  async read() {
    const [eq, maintenance] = await Promise.all([
      this.client.readContract({address: this.venue, abi: mockPerpVenueAbi, functionName: "equityRaw"}),
      this.client.readContract({address: this.venue, abi: mockPerpVenueAbi, functionName: "maintenanceMargin"}),
    ]);
    return {equity: eq > 0n ? eq : 0n, maintenance};
  }
}

/** A venue without onchain equity (Lighter): the NAV oracle's marked perp value and the reported sizes × feed price
 * × the maintenance fraction per sleeve. */
export class ReportMargin implements MarginSource {
  constructor(
    private readonly client: PublicClient,
    private readonly d: ChainDeployment,
    private readonly mmfWad: bigint[],
  ) {}
  async read() {
    const dn = this.d.dnVault!;
    const [equity, last] = await Promise.all([
      this.client.readContract({address: dn.navOracle, abi: navOracleAbi, functionName: "perpValue"}),
      this.client.readContract({address: dn.navOracle, abi: navOracleAbi, functionName: "lastReport"}),
    ]);
    let maintenance = 0n;
    for (let i = 0; i < last.shortSizes.length; i++) {
      const q = await this.client.readContract({address: dn.strategy, abi: strategyManagerAbi, functionName: "quote", args: [BigInt(i), UNIT]});
      maintenance += (last.shortSizes[i] * q * (this.mmfWad[i] ?? 3n * 10n ** 16n)) / UNIT / WAD;
    }
    return {equity, maintenance};
  }
}

export interface DnParams {
  leverage: bigint;
  /** DN-R2 band, bps of the sleeve's spot. */
  bandBps: bigint;
  /** DN-R3 margin targets, × maintenance (WAD): 2× open, 3× closed, emergency spot sales below 1.5×. */
  marginOpenWad: bigint;
  marginClosedWad: bigint;
  marginEmergencyWad: bigint;
  /** Keeper-side slippage for swap floors (bps; the strategy enforces ≤ 1% onchain). */
  slippageBps: bigint;
  /** Smallest trade worth sending, USDG raw. */
  minTradeUsdg: bigint;
  /** Largest spot purchase per sleeve per tick, USDG raw (sim: ≤ 25% of the 2% depth). */
  entryChunkUsdg: bigint;
  /** Target sleeve weights, bps (strategy order). */
  weightsBps: bigint[];
  /** DN-R8: share of an rSTOCK vault that stays idle in the worst case (1 − U_MAX = 10%). */
  lendIdleShareBps: bigint;
  /** DN-R7 / DN-R13: kill when the `windowHours` average funding stays below −(lending APY) for `hours`. */
  kill: {windowHours: number; hours: number; lendingApy: number};
  /** Requests settled per call. */
  settleBatch: bigint;
}

export const defaultDnParams: DnParams = {
  leverage: 3n,
  bandBps: 200n,
  marginOpenWad: 2n * WAD,
  marginClosedWad: 3n * WAD,
  marginEmergencyWad: (3n * WAD) / 2n,
  slippageBps: 50n,
  minTradeUsdg: 100_000_000n,
  entryChunkUsdg: 50_000_000_000n,
  weightsBps: [5000n, 2500n, 2500n],
  lendIdleShareBps: 1000n,
  kill: {windowHours: 168, hours: 72, lendingApy: 0.02},
  settleBatch: 20n,
};

export interface SleeveState {
  id: number;
  active: boolean;
  capUsdg: bigint;
  maxLendBps: bigint;
  stockToken: `0x${string}`;
  wrapper: `0x${string}`;
  rVault: `0x${string}`;
  /** USDG raw per 1e18 units (feed price, no buffer). */
  unitValue: bigint;
  spot: bigint;
  lent: bigint;
  /** wSTOCK held unlent. */
  wrapped: bigint;
  /** Stock Token held loose. */
  loose: bigint;
  rShares: bigint;
  short: bigint;
  /** rSTOCK vault assets minus ours (the other lenders), wSTOCK. */
  others: bigint;
  /** wSTOCK the rSTOCK vault holds idle: all a redeem can return now (no liquidity adapter; T23). */
  rIdle: bigint;
  guardClear: boolean;
}

export interface DnState {
  now: bigint;
  open: boolean;
  regular: boolean;
  fresh: boolean;
  paused: boolean;
  nav: bigint;
  idle: bigint;
  bufferBps: bigint;
  stratUsdg: bigint;
  queuedAssets: bigint;
  headOverdue: boolean;
  headPayable: boolean;
  margin: {equity: bigint; maintenance: bigint};
  pending: bigint;
  sleeves: SleeveState[];
  kill: boolean[];
}

export type DnAction =
  | {kind: "kill"; sleeve: number}
  | {kind: "reduce"; sleeve: number; units: bigint; reason: string}
  | {kind: "alignShort"; sleeve: number; to: bigint; reason: string}
  | {kind: "topUpMargin"; usdg: bigint; reason: string}
  | {kind: "withdrawMargin"; usdg: bigint}
  | {kind: "build"; sleeve: number; usdg: bigint}
  | {kind: "lend"; sleeve: number; wrapped: bigint}
  | {kind: "unlend"; sleeve: number; units: bigint}
  | {kind: "returnAll"}
  | {kind: "settle"};

const abs = (x: bigint) => (x < 0n ? -x : x);
const min = (a: bigint, b: bigint) => (a < b ? a : b);
const max = (a: bigint, b: bigint) => (a > b ? a : b);
const value = (units: bigint, q: bigint) => (units * q) / UNIT;

/** DN-R7 / DN-R13: true when, at every one of the last `hours` points, the trailing `windowHours` average is below
 * −lending APY (hourly). Needs `windowHours + hours` points; fewer = never kill (insufficient history). */
export function killSwitch(hourly: number[], k: DnParams["kill"]): boolean {
  if (hourly.length < k.windowHours + k.hours) return false;
  const floor = -k.lendingApy / 8760;
  for (let end = hourly.length - k.hours; end < hourly.length; end++) {
    const w = hourly.slice(end + 1 - k.windowHours, end + 1);
    if (w.reduce((a, b) => a + b, 0) / w.length >= floor) return false;
  }
  return true;
}

/**
 * The rebalancer's decisions for one tick (pure). Order: kill switch → queue cash → margin → delta band → lending →
 * deployment → settlement. Rules: DN-R2 (band ±2% and an exact realignment once per US session), DN-R3 (margin ≥ 2×
 * maintenance, 3× while closed; top-ups from cash first, then by reducing spot and short together), DN-R7/R13 (kill),
 * DN-R8 (lend ≤ `maxLendBps` and ≤ the worst-case redeemable share of the rSTOCK vault), 08 weekend rules (no spot
 * trades while closed unless margin < 1.5×), DN-R1 (raise cash for the queue, settle when the head is payable).
 */
export function plan(s: DnState, p: DnParams, alignNow: boolean): DnAction[] {
  const out: DnAction[] = [];
  const mRatio = s.margin.maintenance === 0n ? 2n ** 128n : (s.margin.equity * WAD) / s.margin.maintenance;
  const emergency = mRatio < p.marginEmergencyWad;
  const spotTradesAllowed = (s.open && s.fresh) || emergency;

  // 1. Kill switch: stop new exposure, unwind the sleeve (spot trades wait for the session unless an emergency).
  s.sleeves.forEach((sl, i) => {
    if (sl.active && s.kill[i]) out.push({kind: "kill", sleeve: sl.id});
    if ((!sl.active || s.kill[i]) && sl.spot > 0n && spotTradesAllowed) out.push({kind: "reduce", sleeve: sl.id, units: sl.spot, reason: "kill switch (DN-R7)"});
    else if ((!sl.active || s.kill[i]) && sl.short > 0n) out.push({kind: "alignShort", sleeve: sl.id, to: 0n, reason: "kill switch (DN-R7)"});
  });

  // 2. Queue: raise cash by reducing every active sleeve pro rata (DN-R1).
  const cash = s.idle + s.stratUsdg + s.pending;
  const deployed = s.sleeves.reduce((a, sl) => a + value(sl.spot, sl.unitValue), 0n);
  if (s.queuedAssets > cash && spotTradesAllowed && deployed > 0n) {
    const need = ((s.queuedAssets - cash) * 11n) / 10n; // 10% cushion for costs and moves
    // Sized on spot proceeds alone: the margin released with the short is capped by the 2× floor (a bonus, not a
    // plan), so the queue is covered in one pass.
    const fracWad = min(WAD, (need * WAD) / max(deployed, 1n));
    for (const sl of s.sleeves) if (sl.spot > 0n && sl.active) out.push({kind: "reduce", sleeve: sl.id, units: (sl.spot * fracWad) / WAD + 1n, reason: "withdrawal queue (DN-R1)"});
    // Margin released with the short: never below the open target × maintenance of what stays (DN-R3).
    const keep = (p.marginOpenWad * ((s.margin.maintenance * (WAD - fracWad)) / WAD)) / WAD;
    const freed = min((deployed * fracWad) / WAD / p.leverage, s.margin.equity > keep ? s.margin.equity - keep : 0n);
    if (freed > 0n) out.push({kind: "withdrawMargin", usdg: freed});
  }

  // 3. Margin (DN-R3).
  const target = s.open ? p.marginOpenWad : p.marginClosedWad;
  if (mRatio < target && s.margin.maintenance > 0n) {
    const needed = ((target * 5n) / 4n) * s.margin.maintenance / WAD - s.margin.equity; // back to 125% of the target
    const excess = max(0n, s.idle - (s.nav * s.bufferBps) / BPS) + s.stratUsdg;
    if (excess >= needed) out.push({kind: "topUpMargin", usdg: needed, reason: `margin ${fmtWad(mRatio)}x < ${fmtWad(target)}x`});
    else if (spotTradesAllowed) {
      if (excess > 0n) out.push({kind: "topUpMargin", usdg: excess, reason: "margin: cash first"});
      // Reduce spot and short together; the proceeds go to margin.
      const gap = needed - excess;
      for (const sl of s.sleeves) {
        const v = value(sl.spot, sl.unitValue);
        if (v === 0n || deployed === 0n) continue;
        const units = min(sl.spot, (((gap * v) / deployed) * UNIT) / sl.unitValue + 1n);
        out.push({kind: "reduce", sleeve: sl.id, units, reason: "margin top-up by selling spot (DN-R3)"});
      }
      out.push({kind: "topUpMargin", usdg: gap, reason: "margin: from spot sales"});
    }
  }

  // 4. Delta band (DN-R2): the short tracks spot units; exact once per session.
  for (const sl of s.sleeves) {
    if (!sl.active) continue;
    const diff = abs(sl.spot - sl.short);
    const breached = sl.spot > 0n ? diff * BPS > sl.spot * p.bandBps : sl.short > 0n;
    if (breached || (alignNow && diff > 0n)) out.push({kind: "alignShort", sleeve: sl.id, to: sl.spot, reason: breached ? "band breached (DN-R2)" : "session alignment (DN-R2)"});
  }

  // 5. Lending (DN-R8); not for a sleeve reduced this tick (its state above is stale until the next read).
  const reduced = new Set(out.filter((x) => x.kind === "reduce").map((x) => (x as {sleeve: number}).sleeve));
  for (const sl of s.sleeves) {
    if (!sl.active || reduced.has(sl.id)) continue;
    const worst = (sl.others * p.lendIdleShareBps) / (BPS - p.lendIdleShareBps);
    const cap = min((sl.spot * sl.maxLendBps) / BPS, worst);
    // T23: a redeem beyond the rSTOCK vault's idle reverts (its liquidity sits in the market, no liquidity adapter):
    // unlend what it can pay now; the rest follows as idle returns. Unlending everything failed every tick.
    if (sl.lent > cap + cap / 100n + 1n) {
      const units = min(sl.lent - cap, sl.rIdle);
      if (units > 0n) out.push({kind: "unlend", sleeve: sl.id, units});
    }
    else if (!s.paused && cap > sl.lent && sl.wrapped > 0n && value(cap - sl.lent, sl.unitValue) >= p.minTradeUsdg) out.push({kind: "lend", sleeve: sl.id, wrapped: min(sl.wrapped, cap - sl.lent)});
  }

  // 6. Deploy idle cash into the 08 structure (session hours, fresh NAV, nothing queued).
  const reserve = (s.nav * s.bufferBps) / BPS + s.queuedAssets;
  let deployable = s.idle + s.stratUsdg > reserve ? s.idle + s.stratUsdg - reserve : 0n;
  if (s.open && s.regular && s.fresh && !s.paused && !s.headOverdue && deployable >= p.minTradeUsdg) {
    const capital = (s.nav * (BPS - s.bufferBps)) / BPS;
    s.sleeves.forEach((sl, i) => {
      if (!sl.active || s.kill[i] || !sl.guardClear) return;
      const targetSpot = min((capital * p.weightsBps[i] * p.leverage) / BPS / (p.leverage + 1n), sl.capUsdg);
      const have = value(sl.spot, sl.unitValue);
      if (targetSpot <= have + p.minTradeUsdg) return;
      const spotUsdg = min(targetSpot - have, p.entryChunkUsdg);
      const total = min((spotUsdg * (p.leverage + 1n)) / p.leverage, deployable);
      if (total < p.minTradeUsdg) return;
      out.push({kind: "build", sleeve: sl.id, usdg: total});
      deployable -= total;
    });
  }

  // 7. Queue settlement and leftover cash back to the vault.
  if (s.queuedAssets > 0n || s.stratUsdg > 0n) out.push({kind: "returnAll"});
  if (s.headPayable || s.queuedAssets > 0n) out.push({kind: "settle"});
  return out;
}

function fmtWad(x: bigint): string {
  return (Number((x * 100n) / WAD) / 100).toFixed(2);
}

export interface DnTickResult {
  actions: DnAction[];
  inBand: boolean[];
  errors: string[];
}

/** DN-R2…R8 rebalancer keeper: reads the state, plans, executes through the strategy (operator key). See `plan`. */
export class DnRebalancer {
  private lastAlignedSession = "";

  constructor(
    private readonly client: PublicClient,
    private readonly sender: TxSender,
    private readonly d: ChainDeployment,
    private readonly swap: DnSwapBuilder,
    private readonly margin: MarginSource,
    private readonly funding: FundingSource,
    private readonly p: DnParams = defaultDnParams,
    private readonly health?: Health,
    private readonly log: (m: string) => void = console.log,
  ) {}

  private get dn() {
    return this.d.dnVault!;
  }

  private rd<T>(address: `0x${string}`, abi: readonly unknown[], functionName: string, args: readonly unknown[] = []): Promise<T> {
    return (this.client.readContract as (p: unknown) => Promise<T>)({address, abi, functionName, args});
  }

  async read(): Promise<DnState> {
    const dn = this.dn;
    const block = await this.client.getBlock();
    const now = block.timestamp;
    const [open, fresh, paused, nav, idle, bufferBps, stratUsdg, n, bounds, escrow, margin, pending] = await Promise.all([
      this.rd<boolean>(this.d.marketHours, marketHoursAbi, "isOpen", [now]),
      this.rd<boolean>(dn.navOracle, navOracleAbi, "fresh"),
      this.rd<boolean>(dn.strategy, strategyManagerAbi, "paused"),
      this.rd<bigint>(dn.vault, deltaNeutralVaultAbi, "totalAssets"),
      this.rd<bigint>(dn.vault, deltaNeutralVaultAbi, "idleAssets"),
      this.rd<bigint>(dn.vault, deltaNeutralVaultAbi, "bufferBps"),
      this.rd<bigint>(this.d.usdg, erc20Abi, "balanceOf", [dn.strategy]),
      this.rd<bigint>(dn.strategy, strategyManagerAbi, "sleeveCount"),
      this.rd<readonly [bigint, bigint]>(dn.vault, deltaNeutralVaultAbi, "queueBounds"),
      this.rd<bigint>(dn.vault, deltaNeutralVaultAbi, "escrowedShares"),
      this.margin.read(),
      this.rd<bigint>(dn.perpAdapter, perpAdapterAbi, "pending"),
    ]);
    const queuedAssets = escrow > 0n ? await this.rd<bigint>(dn.vault, deltaNeutralVaultAbi, "convertToAssets", [escrow]) : 0n;
    let headOverdue = false;
    let headPayable = false;
    if (bounds[0] < bounds[1]) {
      const head = await this.rd<{shares: bigint; settleBy: bigint}>(dn.vault, deltaNeutralVaultAbi, "request", [bounds[0]]);
      headOverdue = BigInt(head.settleBy) <= now;
      headPayable = (await this.rd<bigint>(dn.vault, deltaNeutralVaultAbi, "convertToAssets", [head.shares])) <= idle;
    }
    const sleeves: SleeveState[] = [];
    const kill: boolean[] = [];
    for (let i = 0; i < Number(n); i++) {
      const sl = await this.rd<{stockToken: `0x${string}`; wrapper: `0x${string}`; rVault: `0x${string}`; oracle: `0x${string}`; perpMarket: Hex; capUsdg: bigint; maxLendBps: number; active: boolean}>(dn.strategy, strategyManagerAbi, "sleeve", [BigInt(i)]);
      const [unitValue, spot, lent, wrapped, loose, rShares, shortRead, rTotal, reasons, rIdle] = await Promise.all([
        this.rd<bigint>(dn.strategy, strategyManagerAbi, "quote", [BigInt(i), UNIT]),
        this.rd<bigint>(dn.strategy, strategyManagerAbi, "spotUnits", [BigInt(i)]),
        this.rd<bigint>(dn.strategy, strategyManagerAbi, "lentUnits", [BigInt(i)]),
        this.rd<bigint>(sl.wrapper, erc20Abi, "balanceOf", [dn.strategy]),
        this.rd<bigint>(sl.stockToken, erc20Abi, "balanceOf", [dn.strategy]),
        this.rd<bigint>(sl.rVault, erc20Abi, "balanceOf", [dn.strategy]),
        this.rd<readonly [boolean, bigint]>(dn.perpAdapter, perpAdapterAbi, "shortSize", [sl.perpMarket]),
        this.rd<bigint>(sl.rVault, vaultV2FullAbi, "totalAssets"),
        this.rd<bigint>(sl.oracle, [{type: "function", name: "guardReasons", stateMutability: "view", inputs: [], outputs: [{type: "uint256"}]}], "guardReasons"),
        this.rd<bigint>(sl.wrapper, erc20Abi, "balanceOf", [sl.rVault]),
      ]);
      let short = shortRead[1];
      if (!shortRead[0]) {
        const last = await this.rd<{shortSizes: readonly bigint[]}>(dn.navOracle, navOracleAbi, "lastReport");
        short = last.shortSizes[i] ?? 0n;
      }
      sleeves.push({id: i, active: sl.active, capUsdg: sl.capUsdg, maxLendBps: BigInt(sl.maxLendBps), stockToken: sl.stockToken, wrapper: sl.wrapper, rVault: sl.rVault, unitValue, spot, lent, wrapped, loose, rShares, short, others: rTotal > lent ? rTotal - lent : 0n, rIdle, guardClear: reasons === 0n});
      const hist = sl.active ? await this.funding.hourly(i, this.p.kill.windowHours + this.p.kill.hours) : [];
      kill.push(sl.active && killSwitch(hist, this.p.kill));
    }
    return {now, open, regular: isUsRegularHours(Number(now)), fresh, paused, nav, idle, bufferBps, stratUsdg, queuedAssets, headOverdue, headPayable, margin, pending, sleeves, kill};
  }

  async tick(): Promise<DnTickResult> {
    const errors: string[] = [];
    let actions: DnAction[] = [];
    let state: DnState | undefined;
    try {
      state = await this.read();
      const session = state.regular ? new Date(Number(state.now) * 1000).toISOString().slice(0, 10) : "";
      const alignNow = state.regular && session !== this.lastAlignedSession;
      actions = plan(state, this.p, alignNow);
      for (const a of actions) {
        try {
          await this.exec(a, state);
        } catch (e) {
          const m = `${a.kind}${"sleeve" in a ? ` #${a.sleeve}` : ""}: ${safeErrorLine(e, process.env)}`;
          errors.push(m);
          this.log(`[dn-rebalancer] ${m}`);
        }
      }
      if (alignNow && errors.length === 0) this.lastAlignedSession = session;
      if (errors.length) this.health?.fail("dn", new Error(errors[0]));
      else this.health?.ok("dn", 0n);
    } catch (e) {
      errors.push(safeErrorLine(e, process.env));
      this.health?.fail("dn", e);
      this.log(`[dn-rebalancer] read failed: ${safeErrorLine(e, process.env)}`);
    }
    const after = errors.length === 0 && actions.length > 0 ? await this.read().catch(() => state) : state;
    const inBand = (after?.sleeves ?? []).map((sl) => !sl.active || (sl.spot === 0n ? sl.short === 0n : abs(sl.spot - sl.short) * BPS <= sl.spot * this.p.bandBps));
    return {actions, inBand, errors};
  }

  private send(to: `0x${string}`, abi: readonly unknown[], functionName: string, args: readonly unknown[], label: string) {
    return this.sender.send(to, (encodeFunctionData as (p: unknown) => Hex)({abi, functionName, args}), label);
  }

  private strat(functionName: string, args: readonly unknown[], label: string) {
    return this.send(this.dn.strategy, strategyManagerAbi, functionName, args, label);
  }

  private async exec(a: DnAction, s: DnState): Promise<void> {
    const sl = "sleeve" in a ? s.sleeves[a.sleeve] : undefined;
    const q = (units: bigint) => this.rd<bigint>(this.dn.strategy, strategyManagerAbi, "quote", [BigInt(sl!.id), units]);
    switch (a.kind) {
      case "kill":
        await this.strat("killSleeve", [BigInt(a.sleeve)], `kill sleeve ${a.sleeve} (DN-R7)`);
        return;
      case "reduce": {
        // Free the units: loose + wrapped first, then redeem rSTOCK; sell; buy back the same short.
        const free = (await this.rd<bigint>(sl!.wrapper, erc20Abi, "balanceOf", [this.dn.strategy])) + sl!.loose;
        if (free < a.units && sl!.rShares > 0n) {
          const shares = await this.rd<bigint>(sl!.rVault, vaultV2FullAbi, "convertToShares", [a.units - free + 1n]);
          await this.strat("unlend", [BigInt(a.sleeve), min(shares + 1n, sl!.rShares)], `unlend sleeve ${a.sleeve}`);
        }
        const w = min(a.units, await this.rd<bigint>(sl!.wrapper, erc20Abi, "balanceOf", [this.dn.strategy]));
        if (w > 0n) {
          const fair = await q(w);
          const minOut = (fair * (BPS - this.p.slippageBps)) / BPS;
          await this.strat("sellSpot", [BigInt(a.sleeve), w, minOut, {target: this.swap.target, data: this.swap.swap(sl!.stockToken, this.d.usdg, w, this.dn.strategy)}], `sell ${w} of sleeve ${a.sleeve} (${a.reason})`);
        }
        const cut = min(sl!.short, w);
        if (cut > 0n) await this.strat("adjustShort", [BigInt(a.sleeve), cut, 0n], `reduce short of sleeve ${a.sleeve}`);
        return;
      }
      case "alignShort": {
        const cur = (await this.rd<readonly [boolean, bigint]>(this.dn.perpAdapter, perpAdapterAbi, "shortSize", [(await this.rd<{perpMarket: Hex}>(this.dn.strategy, strategyManagerAbi, "sleeve", [BigInt(a.sleeve)])).perpMarket]))[1];
        const to = a.to === 0n ? 0n : await this.rd<bigint>(this.dn.strategy, strategyManagerAbi, "spotUnits", [BigInt(a.sleeve)]);
        const delta = cur - to; // > 0: buy back; < 0: sell more
        if (delta !== 0n) await this.strat("adjustShort", [BigInt(a.sleeve), delta, 0n], `align short of sleeve ${a.sleeve} (${a.reason})`);
        return;
      }
      case "topUpMargin": {
        // Strategy cash (e.g. proceeds of the spot sales above) first, then only the vault's excess over its buffer.
        let have = await this.rd<bigint>(this.d.usdg, erc20Abi, "balanceOf", [this.dn.strategy]);
        if (have < a.usdg) {
          const [idle, nav, bufferBps] = await Promise.all([
            this.rd<bigint>(this.dn.vault, deltaNeutralVaultAbi, "idleAssets"),
            this.rd<bigint>(this.dn.vault, deltaNeutralVaultAbi, "totalAssets"),
            this.rd<bigint>(this.dn.vault, deltaNeutralVaultAbi, "bufferBps"),
          ]);
          const minIdle = (nav * bufferBps + BPS - 1n) / BPS;
          const pull = min(a.usdg - have, idle > minIdle ? idle - minIdle : 0n);
          if (pull > 0n) {
            await this.strat("pullFromVault", [pull], "pull for margin");
            have += pull;
          }
        }
        const amount = min(a.usdg, have);
        if (amount > 0n) await this.strat("depositMargin", [amount], `margin top-up ${amount} (${a.reason})`);
        return;
      }
      case "withdrawMargin": {
        // Never below the open target × maintenance, measured now (after the reductions above).
        const m = await this.margin.read();
        const keep = (this.p.marginOpenWad * m.maintenance) / WAD;
        const amount = min(a.usdg, m.equity > keep ? m.equity - keep : 0n);
        if (amount > 0n) await this.strat("requestMarginWithdraw", [amount], `request ${amount} margin back`);
        await this.strat("claimMargin", [], "claim matured margin");
        return;
      }
      case "build": {
        // Size from live numbers: strategy cash plus only what the vault holds above its buffer (the plan's snapshot
        // can be a few trades old within a tick).
        const have = await this.rd<bigint>(this.d.usdg, erc20Abi, "balanceOf", [this.dn.strategy]);
        const [idle, nav, bufferBps] = await Promise.all([
          this.rd<bigint>(this.dn.vault, deltaNeutralVaultAbi, "idleAssets"),
          this.rd<bigint>(this.dn.vault, deltaNeutralVaultAbi, "totalAssets"),
          this.rd<bigint>(this.dn.vault, deltaNeutralVaultAbi, "bufferBps"),
        ]);
        const minIdle = (nav * bufferBps + BPS - 1n) / BPS + 1n;
        const pullable = idle > minIdle ? idle - minIdle : 0n;
        const total = min(a.usdg, have + pullable);
        if (total < this.p.minTradeUsdg) return;
        const spotUsdg = (total * this.p.leverage) / (this.p.leverage + 1n);
        const marginUsdg = total - spotUsdg;
        if (have < total) await this.strat("pullFromVault", [total - have], `pull ${total - have} to build sleeve ${a.sleeve}`);
        const perUnit = await q(UNIT);
        const fair = (spotUsdg * UNIT) / perUnit;
        const minOut = (fair * (BPS - this.p.slippageBps)) / BPS;
        await this.strat("buySpot", [BigInt(a.sleeve), spotUsdg, minOut, {target: this.swap.target, data: this.swap.swap(this.d.usdg, sl!.stockToken, spotUsdg, this.dn.strategy)}], `buy ${spotUsdg} of sleeve ${a.sleeve}`);
        await this.strat("depositMargin", [marginUsdg], `margin for sleeve ${a.sleeve}`);
        const spot = await this.rd<bigint>(this.dn.strategy, strategyManagerAbi, "spotUnits", [BigInt(a.sleeve)]);
        const market = (await this.rd<{perpMarket: Hex}>(this.dn.strategy, strategyManagerAbi, "sleeve", [BigInt(a.sleeve)])).perpMarket;
        const short = (await this.rd<readonly [boolean, bigint]>(this.dn.perpAdapter, perpAdapterAbi, "shortSize", [market]))[1];
        if (spot > short) await this.strat("adjustShort", [BigInt(a.sleeve), short - spot, 0n], `short sleeve ${a.sleeve}`);
        return;
      }
      case "lend":
        await this.strat("lend", [BigInt(a.sleeve), a.wrapped], `lend ${a.wrapped} of sleeve ${a.sleeve}`);
        return;
      case "unlend": {
        const shares = await this.rd<bigint>(sl!.rVault, vaultV2FullAbi, "convertToShares", [a.units]);
        await this.strat("unlend", [BigInt(a.sleeve), min(shares, sl!.rShares)], `unlend ${a.units} of sleeve ${a.sleeve} (DN-R8)`);
        return;
      }
      case "returnAll": {
        await this.strat("claimMargin", [], "claim matured margin");
        const have = await this.rd<bigint>(this.d.usdg, erc20Abi, "balanceOf", [this.dn.strategy]);
        if (have > 0n) await this.strat("returnToVault", [have], `return ${have} to the vault`);
        return;
      }
      case "settle":
        // Trades above bumped the trade nonce: settlement waits for the reporter's next report (DN-R14).
        if (!s.open || !(await this.rd<boolean>(this.dn.navOracle, navOracleAbi, "fresh"))) return;
        await this.send(this.dn.vault, deltaNeutralVaultAbi, "settle", [this.p.settleBatch], "settle the queue (DN-R1)");
        return;
    }
  }
}
