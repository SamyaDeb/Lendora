import {encodeFunctionData, parseUnits, recoverTypedDataAddress, type Hex, type PublicClient} from "viem";
import {
  navMoveBps,
  navOracleAbi,
  navReportTypedData,
  NAV_SECOND_SIGNER_BPS,
  perpAdapterAbi,
  safeErrorLine,
  strategyManagerAbi,
  type ChainDeployment,
  type NavReport,
} from "@stockline/sdk";
import type {TxSender, TypedDataSigner} from "../common/signer.js";
import type {Health} from "../common/health.js";

/** What the venue says about the vault's account. `sizes` in base units 1e18 per sleeve (strategy order). */
export interface VenueRead {
  equity: bigint;
  sizes: bigint[];
}

/** DN-R4: where perp equity comes from. The NAV oracle never reads it onchain; a signer vouches for it. */
export interface EquitySource {
  readonly name: string;
  read(blockNumber: bigint): Promise<VenueRead>;
}

/** The mock venue (anvil, testnet): equity and sizes are onchain, read at the report's block. */
export class MockVenueSource implements EquitySource {
  readonly name = "mock-venue";
  constructor(
    private readonly client: PublicClient,
    private readonly adapter: `0x${string}`,
    /** Venue market id per sleeve, in strategy order (`sleeveMarkets`). */
    private readonly markets: Hex[],
  ) {}
  async read(blockNumber: bigint): Promise<VenueRead> {
    const [, equity] = await this.client.readContract({address: this.adapter, abi: perpAdapterAbi, functionName: "onchainEquity", blockNumber});
    const sizes = await Promise.all(
      this.markets.map(async (m) => (await this.client.readContract({address: this.adapter, abi: perpAdapterAbi, functionName: "shortSize", args: [m], blockNumber}))[1]),
    );
    return {equity, sizes};
  }
}

/**
 * Lighter's public account API (Robinhood Chain instance): equity = `collateral` + Σ `unrealized_pnl`; a short is a
 * position with `sign = -1`. **[VERIFY]** against a live canary (A39/A41): field semantics, and that deposits the
 * adapter made are credited before the report (the reporter waits for L1 deposits to settle). Read-only, no key.
 */
export class LighterAccountSource implements EquitySource {
  readonly name = "lighter";
  constructor(
    private readonly apiUrl: string,
    private readonly adapter: `0x${string}`,
    /** Lighter market id per sleeve, in strategy order (SPY 26, NVDA 15, AAPL 10 on the RH instance). */
    private readonly marketIds: number[],
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  async read(): Promise<VenueRead> {
    const r = await this.fetchImpl(`${this.apiUrl}/api/v1/account?by=l1_address&value=${this.adapter}`, {signal: AbortSignal.timeout(10_000)});
    if (!r.ok) throw new Error(`lighter account ${r.status}`);
    const j = (await r.json()) as {accounts?: {collateral: string; positions?: {market_id: number; sign: number; position: string; unrealized_pnl: string}[]}[]};
    const acct = j.accounts?.[0];
    if (!acct) throw new Error("lighter account not found");
    let equity = usd(acct.collateral);
    for (const p of acct.positions ?? []) equity += usd(p.unrealized_pnl);
    const sizes = this.marketIds.map((id) => {
      const p = (acct.positions ?? []).find((x) => x.market_id === id);
      return p && p.sign === -1 ? parseUnits(p.position, 18) : 0n;
    });
    return {equity: equity > 0n ? equity : 0n, sizes};
  }
}

/** The venue market id of every sleeve, in the strategy's order (the order of `Report.shortSizes`). */
export async function sleeveMarkets(client: PublicClient, strategy: `0x${string}`): Promise<Hex[]> {
  const n = await client.readContract({address: strategy, abi: strategyManagerAbi, functionName: "sleeveCount"});
  return Promise.all(Array.from({length: Number(n)}, async (_, i) => (await client.readContract({address: strategy, abi: strategyManagerAbi, functionName: "sleeve", args: [BigInt(i)]})).perpMarket));
}

/** A USD decimal string → USDG raw (6 dp), rounded toward zero. */
function usd(s: string): bigint {
  const [w, f = ""] = s.split(".");
  const neg = w.startsWith("-");
  const v = BigInt(w.replace("-", "") || "0") * 1_000_000n + BigInt((f + "000000").slice(0, 6));
  return neg ? -v : v;
}

/** Asks an independent co-signer (a separate key, run by someone else) to sign a report (DN-R4 second signer). */
export interface Cosigner {
  cosign(r: NavReport): Promise<Hex>;
}

export interface NavReporterOptions {
  /** Report at least this often (ms); well inside the oracle's 15-minute max age. */
  everyMs: number;
  /** Report sooner when the marked perp side moved by this much (bps of NAV). */
  moveBps: bigint;
}

export const defaultNavReporterOptions: NavReporterOptions = {everyMs: 5 * 60_000, moveBps: 50n};

export interface ReportResult {
  submitted: boolean;
  reason: string;
  moveBps?: bigint;
  signers?: number;
}

/**
 * DN-R4, DN-R5, DN-R14 NAV reporter: reads the venue account, builds the report (equity, the adapter's flow totals
 * and the strategy's trade nonce at the same block, one short size per sleeve), signs it, and — if it moves the perp
 * side by more than 1% of NAV against the oracle's marked estimate — gets the independent co-signer's signature
 * before submitting. Reports whenever the last one is older than `everyMs`, the strategy traded, flows changed, or the
 * marked value drifted; otherwise idles. Restart-safe: everything is read from chain each tick. Anyone may submit a
 * signed report, so the sender only pays gas.
 */
export class NavReporter {
  constructor(
    private readonly client: PublicClient,
    private readonly sender: TxSender,
    private readonly signer: TypedDataSigner,
    private readonly d: ChainDeployment,
    private readonly source: EquitySource,
    private readonly chainId: number,
    private readonly cosigner?: Cosigner,
    private readonly opts: NavReporterOptions = defaultNavReporterOptions,
    private readonly health?: Health,
    private readonly log: (m: string) => void = console.log,
  ) {}

  /** The report for the head block (not signed). */
  async build(): Promise<NavReport> {
    const dn = this.d.dnVault!;
    const block = await this.client.getBlock();
    const bn = block.number;
    const [read, deposited, requested, tradeNonce] = await Promise.all([
      this.source.read(bn),
      this.client.readContract({address: dn.perpAdapter, abi: perpAdapterAbi, functionName: "totalDeposited", blockNumber: bn}),
      this.client.readContract({address: dn.perpAdapter, abi: perpAdapterAbi, functionName: "totalRequested", blockNumber: bn}),
      this.client.readContract({address: dn.strategy, abi: strategyManagerAbi, functionName: "tradeNonce", blockNumber: bn}),
    ]);
    return {equity: read.equity, deposited, requested, tradeNonce: BigInt(tradeNonce), timestamp: block.timestamp, shortSizes: read.sizes};
  }

  async tick(): Promise<ReportResult> {
    const dn = this.d.dnVault;
    if (!dn || /^0x0{40}$/i.test(dn.perpAdapter)) return {submitted: false, reason: "no venue adapter"};
    try {
      const r = await this.build();
      const [last, perpNow, navNow, pending] = await Promise.all([
        this.client.readContract({address: dn.navOracle, abi: navOracleAbi, functionName: "lastReport"}),
        this.client.readContract({address: dn.navOracle, abi: navOracleAbi, functionName: "perpValue"}),
        this.client.readContract({address: dn.navOracle, abi: navOracleAbi, functionName: "nav"}),
        this.client.readContract({address: dn.perpAdapter, abi: perpAdapterAbi, functionName: "pending"}),
      ]);
      const nextPerp = r.equity + pending; // flows since the report are zero: it carries the current totals
      const move = navMoveBps(perpNow, nextPerp, navNow);
      const ageMs = (Number(r.timestamp) - Number(last.timestamp)) * 1000;
      const due =
        last.timestamp === 0n ||
        ageMs >= this.opts.everyMs ||
        BigInt(last.tradeNonce) !== r.tradeNonce ||
        last.deposited !== r.deposited ||
        last.requested !== r.requested ||
        move >= this.opts.moveBps;
      if (!due || r.timestamp <= last.timestamp) {
        this.health?.ok("nav", 0n);
        return {submitted: false, reason: "not due", moveBps: move};
      }
      const td = navReportTypedData(this.chainId, dn.navOracle, r);
      const sigs: {addr: string; sig: Hex}[] = [{addr: this.signer.address.toLowerCase(), sig: await this.signer.signTypedData(td as never)}];
      if (move > NAV_SECOND_SIGNER_BPS) {
        if (!this.cosigner) throw new Error(`report moves NAV by ${move} bps (> 1%): a second signer is required (DN-R4) and none is configured`);
        const sig = await this.cosigner.cosign(r);
        sigs.push({addr: "", sig});
      }
      const ordered = await orderSignatures(sigs, td);
      const data = encodeFunctionData({abi: navOracleAbi, functionName: "submit", args: [r, ordered]});
      await this.sender.send(dn.navOracle, data, `nav report (move ${move} bps, ${ordered.length} signer(s))`);
      this.log(`[nav-reporter] equity ${r.equity} at ${r.timestamp}, move ${move} bps, ${ordered.length} signer(s)`);
      this.health?.ok("nav", 0n);
      return {submitted: true, reason: "due", moveBps: move, signers: ordered.length};
    } catch (e) {
      this.health?.fail("nav", e);
      this.log(`[nav-reporter] error: ${safeErrorLine(e, process.env)}`);
      return {submitted: false, reason: safeErrorLine(e, process.env)};
    }
  }
}

/** NavOracle needs signatures ordered by signer address, strictly increasing. */
async function orderSignatures(sigs: {addr: string; sig: Hex}[], td: ReturnType<typeof navReportTypedData>): Promise<Hex[]> {
  const withAddr = await Promise.all(
    sigs.map(async (s) => ({addr: (await recoverTypedDataAddress({...(td as unknown as Parameters<typeof recoverTypedDataAddress>[0]), signature: s.sig})).toLowerCase(), sig: s.sig})),
  );
  return withAddr.sort((a, b) => (a.addr < b.addr ? -1 : 1)).map((s) => s.sig);
}

/**
 * The independent second signer (DN-R4): re-reads the venue account from **its own** source and signs only a report
 * that matches it (equity within `toleranceBps` + 1 USDG, identical sizes, flow totals and trade nonce equal to the
 * chain at the report's block, timestamp at most `maxAgeSec` old). It never signs what it can't verify.
 */
export class NavCosigner implements Cosigner {
  constructor(
    private readonly client: PublicClient,
    private readonly signer: TypedDataSigner,
    private readonly d: ChainDeployment,
    private readonly source: EquitySource,
    private readonly chainId: number,
    private readonly toleranceBps = 25n,
    private readonly maxAgeSec = 300n,
  ) {}
  async cosign(r: NavReport): Promise<Hex> {
    const dn = this.d.dnVault!;
    const head = await this.client.getBlock();
    if (r.timestamp > head.timestamp || head.timestamp - r.timestamp > this.maxAgeSec) throw new Error("cosigner: report timestamp out of range");
    const [mine, deposited, requested, tradeNonce] = await Promise.all([
      this.source.read(head.number),
      this.client.readContract({address: dn.perpAdapter, abi: perpAdapterAbi, functionName: "totalDeposited"}),
      this.client.readContract({address: dn.perpAdapter, abi: perpAdapterAbi, functionName: "totalRequested"}),
      this.client.readContract({address: dn.strategy, abi: strategyManagerAbi, functionName: "tradeNonce"}),
    ]);
    if (r.deposited !== deposited || r.requested !== requested || r.tradeNonce !== BigInt(tradeNonce)) throw new Error("cosigner: flows or trade nonce differ from the chain");
    if (r.shortSizes.length !== mine.sizes.length || r.shortSizes.some((s, i) => s !== mine.sizes[i])) throw new Error("cosigner: short sizes differ from the venue");
    const diff = r.equity > mine.equity ? r.equity - mine.equity : mine.equity - r.equity;
    if (diff > (mine.equity * this.toleranceBps) / 10_000n + 1_000_000n) throw new Error(`cosigner: equity ${r.equity} differs from ${mine.equity}`);
    return this.signer.signTypedData(navReportTypedData(this.chainId, dn.navOracle, r) as never);
  }
}

/** Calls a co-signer service over HTTPS (`POST /cosign` with a bearer token). */
export class HttpCosigner implements Cosigner {
  constructor(
    private readonly url: string,
    private readonly auth: string | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  async cosign(r: NavReport): Promise<Hex> {
    const body = JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    const res = await this.fetchImpl(this.url, {method: "POST", headers: {"content-type": "application/json", ...(this.auth ? {authorization: `Bearer ${this.auth}`} : {})}, body, signal: AbortSignal.timeout(15_000)});
    if (!res.ok) throw new Error(`cosigner ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return ((await res.json()) as {signature: Hex}).signature;
  }
}

/** Parse a report posted to the co-signer service. */
export function parseReport(j: Record<string, unknown>): NavReport {
  const b = (k: string) => BigInt(String(j[k]));
  return {equity: b("equity"), deposited: b("deposited"), requested: b("requested"), tradeNonce: b("tradeNonce"), timestamp: b("timestamp"), shortSizes: (j.shortSizes as unknown[]).map((x) => BigInt(String(x)))};
}
