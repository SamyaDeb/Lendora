import {describe, expect, it} from "vitest";
import {earnings, nextUsOpen, settleTime, splitFor, splitTotal, splitWithdraw} from "@/lib/vault";
import {createFixtureSource} from "@/lib/vault/source";
import {FX_VAULT_OVERVIEW, VAULT_STATES, fxVault} from "@/lib/fixtures";

const A = "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955" as const;
const T = (s: string) => Date.parse(s) / 1000;

describe("withdraw split (DN-R1)", () => {
  it("pays up to the cash buffer now and queues the rest", () => {
    const p = splitWithdraw(5_000, 3_000, T("2026-10-06T20:19:12Z"));
    expect(p.instant).toBe(3_000);
    expect(p.queued).toBe(2_000);
    expect(p.settlesAt).toBe("2026-10-09T20:19:12.000Z"); // 72 h later is after the next open (Wed 09:30 ET)
  });

  it("is all instant within the buffer, with no settlement time", () => {
    expect(splitWithdraw(1_000, 64_200, T("2026-10-06T20:19:12Z"))).toEqual({instant: 1_000, queued: 0, settlesAt: undefined});
  });

  it("queues everything while instant withdrawals are paused (stale NAV)", () => {
    const p = splitWithdraw(1_000, 64_200, T("2026-10-10T16:00:00Z"), true);
    expect(p).toMatchObject({instant: 0, queued: 1_000});
  });

  it("waits for the next US open when the market stays shut past 72 hours (Christmas 2026)", () => {
    expect(new Date(nextUsOpen(T("2026-10-06T20:19:12Z")) * 1000).toISOString()).toBe("2026-10-07T13:30:00.000Z");
    // Thu 24 Dec 10:00 ET + 72 h = Sun 27 Dec; the next open is Mon 28 Dec 09:30 ET (Fri 25 is a holiday).
    expect(new Date(settleTime(T("2026-12-24T15:00:00Z")) * 1000).toISOString()).toBe("2026-12-28T14:30:00.000Z");
  });
});

describe("earnings", () => {
  it("is unknown until deposits are indexed, never 'everything is profit'", () => {
    expect(earnings({value: 5_000, netDeposits: 0})).toBeUndefined();
    expect(earnings({value: 5_000, netDeposits: 4_850})).toBe(150);
  });
});

describe("fixtures", () => {
  it("every window's split adds up to its headline APY", () => {
    for (const w of ["7d", "30d", "90d"] as const) {
      const key = ({"7d": "d7", "30d": "d30", "90d": "d90"} as const)[w];
      expect(splitTotal(splitFor(FX_VAULT_OVERVIEW, w))).toBeCloseTo(FX_VAULT_OVERVIEW.apy[key]!, 6);
    }
    const ks = fxVault("kill_switch").overview!;
    expect(splitTotal(splitFor(ks, "30d"))).toBeCloseTo(ks.apy.d30!, 6);
  });

  it("covers every preview state", () => {
    for (const s of VAULT_STATES) expect(fxVault(s)).toBeDefined();
    expect(fxVault("loading").overview).toBeUndefined();
    expect(fxVault("disconnected").user).toBeUndefined();
    expect(fxVault("has_requests").user!.requests.map((r) => r.status).sort()).toEqual(["queued", "ready"]);
  });
});

describe("fixture ledger", () => {
  it("deposit → instant + queued withdraw → settle → claim changes the balances", async () => {
    const s = createFixtureSource("open", {delayMs: 0, persist: false});
    const u0 = await s.user(A);
    await s.approve(A, 10_000);
    await s.deposit(A, 10_000, await s.attest(A));
    const u1 = await s.user(A);
    expect(u1.usdgBalance).toBe(u0.usdgBalance - 10_000);
    expect(u1.value).toBeCloseTo(u0.value + 10_000, 0);
    expect((await s.overview()).tvl).toBe(FX_VAULT_OVERVIEW.tvl + 10_000);

    const cap = (await s.overview()).instantCapacity;
    const p = await s.previewWithdraw(cap + 2_000);
    expect(p).toMatchObject({instant: cap, queued: 2_000});
    await s.withdraw(A, 3_000);
    expect((await s.overview()).instantCapacity).toBe(cap - 3_000);
    expect((await s.user(A)).usdgBalance).toBe(u1.usdgBalance + 3_000);
    const {id} = await s.requestRedeem(A, p.queued / FX_VAULT_OVERVIEW.sharePrice);
    let r = (await s.user(A)).requests.find((x) => x.id === id)!;
    expect(r.status).toBe("queued");
    expect(r.position).toBe(3);
    await expect(s.claim(A, id)).rejects.toThrow("isn't ready");

    s.advance(4 * 86_400);
    r = (await s.user(A)).requests.find((x) => x.id === id)!;
    expect(r.status).toBe("ready");
    const before = (await s.user(A)).usdgBalance;
    await s.claim(A, id);
    expect((await s.user(A)).usdgBalance).toBeCloseTo(before + 2_000, 1);
  });

  it("refuses deposits the way the vault will: full cap, stale NAV", async () => {
    const full = createFixtureSource("cap_full", {delayMs: 0, persist: false});
    await full.approve(A, 100);
    await expect(full.deposit(A, 100, await full.attest(A))).rejects.toThrow("closed");
    const stale = createFixtureSource("nav_stale", {delayMs: 0, persist: false});
    await stale.approve(A, 100);
    await expect(stale.deposit(A, 100, await stale.attest(A))).rejects.toThrow("stale");
    await expect(stale.withdraw(A, 100)).rejects.toThrow("stale");
    // A request that already settled can still be claimed.
    const ready = (await stale.user(A)).requests.find((r) => r.status === "ready")!;
    await stale.claim(A, ready.id);
    expect((await stale.user(A)).requests.find((r) => r.id === ready.id)!.status).toBe("claimed");
  });
});

describe("apiSource mapping (task 16)", () => {
  it("DN_R11 maps the API's decimal strings to numbers and keeps a missing APY window as null (CP-R7)", async () => {
    const {overviewFromApi} = await import("@/lib/vault/apiSource");
    const o = overviewFromApi({
      asOfBlock: "10",
      asOfTime: "2026-10-01T16:00:00.000Z",
      confirmed: false,
      safe: false,
      scope: "",
      data: {
        sharePrice: "1.0012",
        tvl: "1000000",
        cap: "2000000",
        instantCapacity: "50000",
        apy: {d7: "0.05", d30: null, d90: null},
        apySeries: [{t: 1, v: "0.04"}],
        sharePriceSeries: [{t: 1, v: "1.0012"}],
        split: [{window: "7d", lending: "0.01", funding: "0.045", buffer: "0", costs: "-0.005"}],
        sleeves: [{symbol: "NVDA", weight: "1", cap: "500000", delta: "0.001", marginRatio: null, status: "active", spotUsdg: "1", lentUnits: "1", shortUnits: "1"}],
        allocation: {lent: "0.6", held: "0.1", perpMargin: "0.25", cash: "0.05"},
        nav: {ageSec: 30, stale: false, maxAgeClosedSec: 900},
        venue: {name: "Mock perp venue (test)", status: "ok"},
        killSwitch: [],
        lastRebalance: null,
        bandPct: "0.02",
        marginTarget: "2",
        marginTargetClosed: "3",
        marketClosed: false,
        depositsOpen: true,
        pauseReason: null,
        queue: {length: 0, escrowedShares: "0"},
        contracts: {vault: "0x0000000000000000000000000000000000000001", strategy: "0x0000000000000000000000000000000000000002", navOracle: "0x0000000000000000000000000000000000000003", perpAdapter: "0x0000000000000000000000000000000000000004"},
        rateKind: "variable",
      },
    });
    expect(o.apy).toEqual({d7: 0.05, d30: null, d90: null});
    expect(o.sharePrice).toBe(1.0012);
    expect(o.sleeves[0].marginRatio).toBeNull();
    expect(o.pauseReason).toBeUndefined();
    expect(splitTotal(o.split[0])).toBeCloseTo(0.05, 9);
  });
});
