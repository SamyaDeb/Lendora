import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {deltaNeutralVaultAbi, erc20Abi} from "@stockline/sdk";
import {DnDriver, SEED_WED} from "@stockline/devnet";
import {startStack, type Stack} from "./harness.js";

const E6 = 10n ** 6n;
const E18 = 10n ** 18n;
const DEPLOYER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;
const alice = "0x00000000000000000000000000000000000e1a13" as const;

/** DN-R11 (task 16) and A3: `/v1/vault/*` and `/v1/receipt-markets` on the indexed anvil stack; values equal chain reads. */
describe("USDG Earn and receipt-market API (DN-R11, A3)", () => {
  let s: Stack;
  let dn: DnDriver;
  let base: string;
  const getJson = async <T = Record<string, unknown>>(path: string) => {
    const r = await fetch(`${base}${path}`);
    expect(r.status, `${path}: ${r.status} ${r.status !== 200 ? await r.clone().text() : ""}`).toBe(200);
    return (await r.json()) as T & {asOfBlock: string};
  };
  const vault = () => s.config.d.dnVault!;
  const rd = <T,>(functionName: string, args: readonly unknown[] = []) => (s.anvil.client.readContract as (p: unknown) => Promise<T>)({address: vault().vault, abi: deltaNeutralVaultAbi, functionName, args});
  const sync = async () => s.indexer.waitForBlock(await s.anvil.client.getBlockNumber());

  beforeAll(async () => {
    s = await startStack({seed: false});
    base = s.api.url;
    dn = new DnDriver(s.drv);
    await s.drv.freshRounds(SEED_WED);
    for (const t of s.drv.tickers) {
      await s.drv.mintStock(t, DEPLOYER, 20_000n * E18);
      await s.drv.lend(t, DEPLOYER, 20_000n * E18);
    }
    await dn.report();
    await dn.deposit(alice, 1_000_000n * E6);
    await dn.build(0, 400_000n * E6);
    await dn.build(1, 200_000n * E6);
    await dn.report();
    await dn.funding(1, 10n ** 15n); // 0.1% of the NVDA notional to the shorts
    await dn.report();
    await sync();
  }, 600_000);
  afterAll(async () => s?.close());

  it("DN_R11 overview: NAV, share price, cap, allocation and sleeves equal the chain; rates are labelled variable", async () => {
    const o = await getJson<{data: Record<string, unknown> & {sleeves: {symbol: string; delta: string; status: string; shortUnits: string}[]; allocation: Record<string, string>; apy: Record<string, string | null>}}>("/v1/vault/overview");
    const d = o.data;
    expect(d.rateKind).toBe("variable");
    expect(Number(d.tvl)).toBeCloseTo(Number(await rd<bigint>("totalAssets")) / 1e6, 2);
    expect(Number(d.sharePrice)).toBeCloseTo(Number(await rd<bigint>("sharePrice")) / 1e18, 9);
    expect(Number(d.cap)).toBe(2_000_000); // DeployLocal dev cap
    expect(d.sleeves.map((x) => x.symbol)).toEqual(["SPY", "NVDA", "AAPL"]);
    expect(d.sleeves[1].status).toBe("active");
    expect(Math.abs(Number(d.sleeves[1].delta))).toBeLessThan(0.02); // DN-R2 band
    const alloc = Object.values(d.allocation).reduce((x, y) => x + Number(y), 0);
    expect(alloc).toBeGreaterThan(0.98);
    expect(alloc).toBeLessThan(1.02);
    expect(d.apy.d30).toBeNull(); // no 30-day history yet: never a projection (CP-R7)
    expect(d.depositsOpen).toBe(true);
    expect((d.venue as {status: string}).status).toBe("ok");
  });

  it("DN_R1_R11 account: shares, value at the share price, net deposits; requests move queued → ready → claimed", async () => {
    let a = await getJson<{data: {shares: string; value: string; netDeposits: string; requests: {id: string; status: string; position: number}[]}}>(`/v1/vault/account/${alice}`);
    expect(Number(a.data.shares)).toBe(1_000_000);
    expect(Number(a.data.netDeposits)).toBe(1_000_000);
    const price = Number(await rd<bigint>("sharePrice")) / 1e18;
    expect(Number(a.data.value)).toBeCloseTo(1_000_000 * price, 0);
    const id = await dn.requestRedeem(alice, 100_000n * E18);
    await sync();
    a = await getJson(`/v1/vault/account/${alice}`);
    expect(a.data.requests[0]).toMatchObject({id: String(id), status: "queued", position: 1});
    await dn.report();
    await dn.settle();
    await sync();
    a = await getJson(`/v1/vault/account/${alice}`);
    expect(a.data.requests[0].status).toBe("ready");
    const before = await s.anvil.client.readContract({address: s.config.d.usdg, abi: erc20Abi, functionName: "balanceOf", args: [alice]});
    await dn.claim(id);
    await sync();
    a = await getJson(`/v1/vault/account/${alice}`);
    expect(a.data.requests[0].status).toBe("claimed");
    const after = await s.anvil.client.readContract({address: s.config.d.usdg, abi: erc20Abi, functionName: "balanceOf", args: [alice]});
    expect(Number(a.data.netDeposits)).toBeCloseTo(1_000_000 - Number(after - before) / 1e6, 2);
  });

  it("DN_R11 funding shows in the 7-day split once there is a day of history", async () => {
    await s.drv.freshRounds((await s.drv.now()) + 86_400n + 3600n);
    await dn.report();
    await sync();
    const o = await getJson<{data: {split: {window: string; funding: string; costs: string; lending: string}[]; apy: {d7: string | null}; apySeries: unknown[]; sharePriceSeries: unknown[]}}>("/v1/vault/overview");
    const w7 = o.data.split.find((x) => x.window === "7d")!;
    expect(Number(w7.funding)).toBeGreaterThan(0);
    expect(o.data.apy.d7).not.toBeNull();
    const total = Number(w7.funding) + Number(w7.costs) + Number(w7.lending);
    expect(total).toBeCloseTo(Number(o.data.apy.d7), 5); // the parts add up to the net APY (each is rounded to 6 dp)
    expect(o.data.sharePriceSeries.length).toBeGreaterThanOrEqual(2);
  });

  it("A3 receipt markets: the NVDA market is deployed but not listed (caps 0) until the curator's timelocked step", async () => {
    const r = await getJson<{data: {symbol: string; listed: boolean; lltv: string; supplied: string}[]}>("/v1/receipt-markets");
    expect(r.data).toHaveLength(1);
    expect(r.data[0]).toMatchObject({symbol: "NVDA", listed: false, lltv: "0.625"});
    expect(Number(r.data[0].supplied)).toBe(1); // the $1 seed
  });

  it("DN_R11 unknown addresses are refused; OpenAPI lists the vault routes", async () => {
    const bad = await fetch(`${base}/v1/vault/account/0x123`);
    expect(bad.status).toBe(400);
    const spec = await getJson<{paths: Record<string, unknown>}>("/v1/openapi.json");
    expect(Object.keys(spec.paths)).toEqual(expect.arrayContaining(["/v1/vault/overview", "/v1/vault/account/{address}", "/v1/receipt-markets"]));
  });
});
