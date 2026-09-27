import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {encodeFunctionData, maxUint256, type Hex} from "viem";
import {generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount} from "viem/accounts";
import {attestationDomain, attestationTypes, erc20Abi, morphoAbi, stocklineRouterAbi, vaultV2Abi} from "@stockline/sdk";
import {envKeyTypedDataSigner} from "@stockline/keepers/signer";
import {ChainDriver, startAnvil, startPostgres, type Anvil, type Service} from "@stockline/devnet";
import {assertStartupConfig, startCompliance, type RunningCompliance} from "../src/server.js";
import type {SanctionsScreen} from "../src/checks.js";

const E18 = 10n ** 18n;
const E6 = 10n ** 6n;
const WED = 1_790_784_000n;
const ALLOWED = {"x-geo-country": "DE", "x-forwarded-for": "192.0.2.10"};
const SECRET = "test-proxy-secret-0123456789abcdef"; // ≥ 32 chars (CP-R8)

describe("CP-R8 startup refuses to trust geo headers without the proxy secret", () => {
  it("CP_R8 testnet (46630) needs PROXY_SECRET >= 32 chars; TRUST_PROXY without it is refused", async () => {
    await expect(startCompliance({STOCKLINE_NETWORK: "46630", DATABASE_URL: "postgres://unused"})).rejects.toThrow(/PROXY_SECRET/);
    expect(() => assertStartupConfig({PROXY_SECRET: "short"}, "46630")).toThrow(/PROXY_SECRET/);
    expect(() => assertStartupConfig({TRUST_PROXY: "true"}, "46630")).toThrow(/PROXY_SECRET/);
    expect(() => assertStartupConfig({TRUST_PROXY: "true", PROXY_SECRET: SECRET}, "46630")).not.toThrow();
    expect(() => assertStartupConfig({TRUST_PROXY: "true", PROXY_SECRET: SECRET}, "fork-4663")).not.toThrow();
    expect(() => assertStartupConfig({}, "fork-4663")).toThrow(/PROXY_SECRET/);
  });

  it("CP_R8 local anvil (31337) may run without a secret, but a set secret must still be long enough", () => {
    expect(() => assertStartupConfig({TRUST_PROXY: "true"}, "31337")).not.toThrow();
    expect(() => assertStartupConfig({PROXY_SECRET: "s3cret"}, "31337")).toThrow(/at least 32/);
  });

  it("CP_R8 mainnet (4663) refuses the deny-list sanctions adapter (Q5)", () => {
    expect(() => assertStartupConfig({PROXY_SECRET: SECRET}, "4663")).toThrow(/deny-list/);
    expect(() => assertStartupConfig({PROXY_SECRET: SECRET, SANCTIONS_PROVIDER: "deny-list"}, "4663")).toThrow(/deny-list/);
    expect(() => assertStartupConfig({PROXY_SECRET: SECRET, SANCTIONS_PROVIDER: "trm"}, "4663")).not.toThrow();
  });
});

/** CP-R1…R4, RT-R2, APP-R10 against the deployed router on anvil. */
describe("compliance signer on anvil (CP-R1…R4, RT-R2, APP-R10)", () => {
  let a: Anvil;
  let drv: ChainDriver;
  let pg: Service;
  let c: RunningCompliance;
  let signerKey: Hex;
  const sanctioned = privateKeyToAccount(generatePrivateKey());
  const router = () => a.d.router!;
  const nvda = () => a.d.stocks.NVDA;
  const call = (abi: readonly unknown[], functionName: string, args: readonly unknown[] = []) => (encodeFunctionData as (p: unknown) => Hex)({abi, functionName, args});

  async function acceptTerms(u: PrivateKeyAccount) {
    const t = (await (await fetch(`${c.url}/v1/compliance/terms?address=${u.address}`)).json()) as {version: string; message: string};
    const signature = await u.signMessage({message: t.message});
    const r = await fetch(`${c.url}/v1/compliance/terms`, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({address: u.address, signature, version: t.version})});
    expect(r.status).toBe(200);
  }

  async function attest(u: `0x${string}`, headers: Record<string, string> = ALLOWED) {
    return fetch(`${c.url}/v1/compliance/attest`, {method: "POST", headers: {"content-type": "application/json", ...headers}, body: JSON.stringify({address: u})});
  }

  async function onboard(u: `0x${string}`, usdg: bigint) {
    await drv.mintUsdg(u, usdg);
    await a.send(u, a.d.usdg, call(erc20Abi, "approve", [router(), maxUint256]));
    await a.send(u, a.d.morpho, call(morphoAbi, "setAuthorization", [router(), true]));
  }

  async function borrow(u: `0x${string}`, att: {expiry: bigint | string; signature: Hex}, amount = 10n * E18, collateral = 5_000n * E6) {
    const deadline = (await drv.now()) + 3600n;
    return a.send(u, router(), call(stocklineRouterAbi, "borrow", [nvda().stockToken, collateral, amount, u, {expiry: BigInt(att.expiry), signature: att.signature}, deadline]));
  }

  async function setRouterSigner(addr: `0x${string}`) {
    const owner = await a.client.readContract({address: router(), abi: stocklineRouterAbi, functionName: "owner"});
    await a.send(owner, router(), call(stocklineRouterAbi, "setAttestationSigner", [addr]));
  }

  beforeAll(async () => {
    a = await startAnvil();
    drv = new ChainDriver(a);
    await drv.freshRounds(WED);
    await drv.lend("NVDA", "0x57000000000000000000000000000000000000c1", 1_000n * E18);
    await drv.allocate(["NVDA"]);
    pg = await startPostgres();
    signerKey = generatePrivateKey();
    c = await startCompliance(
      {
        DATABASE_URL: pg.url,
        RPC_URL: a.url,
        STOCKLINE_NETWORK: "31337",
        TRUST_PROXY: "true",
        PORT: "0",
        HOST: "127.0.0.1",
        COMPLIANCE_SIGNER_KEY: signerKey,
        COMPLIANCE_SCHEMA: `compliance_${Date.now()}`,
        DATACENTER_RANGES: "203.0.113.0/24",
        SANCTIONS_DENY_LIST: sanctioned.address,
      },
      {},
    );
    await setRouterSigner(c.svc.signerAddress);
  }, 300_000);

  afterAll(async () => {
    await c?.close();
    pg?.stop();
    a?.stop();
  });

  it("RT_R2 CP_R3 an attestation from the compliance signer (terms + allowed country + clean screen) opens a borrow on the router", async () => {
    const u = privateKeyToAccount(generatePrivateKey());
    await acceptTerms(u);
    const r = await attest(u.address);
    expect(r.status).toBe(200);
    const att = (await r.json()) as {user: string; expiry: string; signature: Hex; signer: string; chainId: number};
    expect(att.signer).toBe(c.svc.signerAddress);
    expect(att.chainId).toBe(31337);
    const now = await drv.now();
    expect(BigInt(att.expiry) - now).toBeGreaterThan(24n * 3600n - 60n); // CP-R3: 24h validity
    expect(BigInt(att.expiry) - now).toBeLessThanOrEqual(24n * 3600n);
    await onboard(u.address, 5_000n * E6);
    await borrow(u.address, att);
    const pos = await a.client.readContract({address: a.d.morpho, abi: morphoAbi, functionName: "position", args: [nvda().marketId, u.address]});
    expect(pos.borrowShares).toBeGreaterThan(0n);
  });

  it("CP_R1 restricted countries and regions, and unknown locations, get no attestation", async () => {
    const u = privateKeyToAccount(generatePrivateKey());
    await acceptTerms(u);
    for (const [headers, code] of [
      [{"x-geo-country": "US", "x-forwarded-for": "192.0.2.11"}, "RESTRICTED_REGION"],
      [{"x-geo-country": "GB", "x-forwarded-for": "192.0.2.12"}, "RESTRICTED_REGION"],
      [{"x-geo-country": "UA", "x-geo-region": "43", "x-forwarded-for": "192.0.2.13"}, "RESTRICTED_REGION"],
      [{"x-forwarded-for": "192.0.2.14"}, "GEO_UNKNOWN"],
    ] as const) {
      const r = await attest(u.address, headers);
      expect(r.status).toBe(403);
      expect(((await r.json()) as {code: string}).code).toBe(code);
    }
    const conn = (await (await fetch(`${c.url}/v1/compliance/connection`, {headers: {"x-vercel-ip-country": "CA"}})).json()) as {restricted: boolean};
    expect(conn.restricted).toBe(true); // APP-R2: the web app shows the block page
  });

  it("CP_R2 datacenter / VPN IPs cannot get a borrow attestation", async () => {
    const u = privateKeyToAccount(generatePrivateKey());
    await acceptTerms(u);
    const r = await attest(u.address, {"x-geo-country": "DE", "x-forwarded-for": "203.0.113.50"});
    expect(r.status).toBe(403);
    expect(((await r.json()) as {code: string}).code).toBe("DATACENTER_IP");
  });

  it("CP_R3 sanctioned wallets, wallets without the current terms and a failing screen are refused", async () => {
    await acceptTerms(sanctioned);
    let r = await attest(sanctioned.address);
    expect(((await r.json()) as {code: string}).code).toBe("SANCTIONED");
    const fresh = privateKeyToAccount(generatePrivateKey());
    r = await attest(fresh.address);
    expect(((await r.json()) as {code: string}).code).toBe("TERMS_REQUIRED");

    const failing: SanctionsScreen = {screen: async () => Promise.reject(new Error("provider down"))};
    const c2 = await startCompliance(
      {DATABASE_URL: pg.url, RPC_URL: a.url, STOCKLINE_NETWORK: "31337", TRUST_PROXY: "true", PORT: "0", HOST: "127.0.0.1", COMPLIANCE_SIGNER_KEY: signerKey, COMPLIANCE_SCHEMA: `compliance_b_${Date.now()}`},
      {sanctions: failing},
    );
    try {
      const r2 = await fetch(`${c2.url}/v1/compliance/attest`, {method: "POST", headers: {"content-type": "application/json", ...ALLOWED}, body: JSON.stringify({address: fresh.address})});
      expect(((await r2.json()) as {code: string}).code).toBe("SCREEN_UNAVAILABLE"); // fails closed
    } finally {
      await c2.close();
    }
  });

  it("CP_R1 behind a proxy secret, geo headers from anyone else are ignored", async () => {
    const c3 = await startCompliance(
      {DATABASE_URL: pg.url, RPC_URL: a.url, STOCKLINE_NETWORK: "31337", TRUST_PROXY: "true", PORT: "0", HOST: "127.0.0.1", COMPLIANCE_SIGNER_KEY: signerKey, COMPLIANCE_SCHEMA: `compliance_c_${Date.now()}`, PROXY_SECRET: SECRET},
      {},
    );
    try {
      const u = privateKeyToAccount(generatePrivateKey());
      const spoofed = await fetch(`${c3.url}/v1/compliance/attest`, {method: "POST", headers: {"content-type": "application/json", ...ALLOWED}, body: JSON.stringify({address: u.address})});
      expect(((await spoofed.json()) as {code: string}).code).toBe("GEO_UNKNOWN");
      const viaProxy = await fetch(`${c3.url}/v1/compliance/connection`, {headers: {"x-stockline-proxy": SECRET, "x-vercel-ip-country": "US"}});
      expect(((await viaProxy.json()) as {restricted: boolean}).restricted).toBe(true);
    } finally {
      await c3.close();
    }
  });

  it("CP_R8 /attest is rate-limited per IP and per wallet", async () => {
    const c4 = await startCompliance(
      {DATABASE_URL: pg.url, RPC_URL: a.url, STOCKLINE_NETWORK: "31337", TRUST_PROXY: "true", PORT: "0", HOST: "127.0.0.1", COMPLIANCE_SIGNER_KEY: signerKey, COMPLIANCE_SCHEMA: `compliance_d_${Date.now()}`, ATTEST_RPM: "2"},
      {},
    );
    try {
      const post = (address: string, ip: string) =>
        fetch(`${c4.url}/v1/compliance/attest`, {method: "POST", headers: {"content-type": "application/json", "x-geo-country": "DE", "x-forwarded-for": ip}, body: JSON.stringify({address})});
      const w = privateKeyToAccount(generatePrivateKey()).address;
      // One wallet from rotating IPs: the third request in the minute is refused.
      expect((await post(w, "192.0.2.101")).status).not.toBe(429);
      expect((await post(w, "192.0.2.102")).status).not.toBe(429);
      expect((await post(w, "192.0.2.103")).status).toBe(429);
      // One IP for rotating wallets: likewise.
      const ip = "192.0.2.110";
      for (let i = 0; i < 2; i++) expect((await post(privateKeyToAccount(generatePrivateKey()).address, ip)).status).not.toBe(429);
      expect((await post(privateKeyToAccount(generatePrivateKey()).address, ip)).status).toBe(429);
    } finally {
      await c4.close();
    }
  });

  it("APP_R10 terms: wrong signatures and stale versions are rejected; storage has wallet, version, hash, signature, time and no IP", async () => {
    const u = privateKeyToAccount(generatePrivateKey());
    const other = privateKeyToAccount(generatePrivateKey());
    const t = (await (await fetch(`${c.url}/v1/compliance/terms?address=${u.address}`)).json()) as {version: string; message: string; hash: string; text: string};
    expect(t.text).toContain("Risk Disclosure");
    expect(t.message).toContain(t.hash);
    const bad = await fetch(`${c.url}/v1/compliance/terms`, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({address: u.address, signature: await other.signMessage({message: t.message}), version: t.version})});
    expect(bad.status).toBe(403);
    const stale = await fetch(`${c.url}/v1/compliance/terms`, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({address: u.address, signature: await u.signMessage({message: t.message}), version: "2025-01-01"})});
    expect(stale.status).toBe(403);
    expect(((await (await fetch(`${c.url}/v1/compliance/terms/${u.address}`)).json()) as {accepted: boolean}).accepted).toBe(false);
    await acceptTerms(u);
    expect(((await (await fetch(`${c.url}/v1/compliance/terms/${u.address}`)).json()) as {accepted: boolean}).accepted).toBe(true);
    const {rows} = await c.store.pool.query(`select * from "${(c.store as unknown as {s: string}).s.replace(/"/g, "")}".terms_acceptance limit 1`);
    expect(Object.keys(rows[0]).sort()).toEqual(["address", "signature", "signed_at", "terms_hash", "version"]);
  });

  it("RT_R2 the router rejects an expired attestation, another signer's, another user's and another chain's", async () => {
    const u = privateKeyToAccount(generatePrivateKey());
    const v = privateKeyToAccount(generatePrivateKey());
    await acceptTerms(u);
    await onboard(u.address, 20_000n * E6);
    await onboard(v.address, 20_000n * E6);
    const att = (await (await attest(u.address)).json()) as {expiry: string; signature: Hex};

    // Bound to the user: v cannot use u's attestation.
    await expect(borrow(v.address, att)).rejects.toThrow(/BadAttestation/);

    // Another signer (right domain and message) is rejected.
    const rogue = envKeyTypedDataSigner("X", {X_KEY: generatePrivateKey()});
    const expiry = (await drv.now()) + 3600n;
    const forged = await rogue.signTypedData({domain: attestationDomain(31337, router()), types: attestationTypes, primaryType: "Attestation", message: {user: u.address, expiry}});
    await expect(borrow(u.address, {expiry, signature: forged})).rejects.toThrow(/BadAttestation/);

    // Bound to the chain: the real signer, but for chain id 1.
    const real = envKeyTypedDataSigner("C", {C_KEY: signerKey});
    const otherChain = await real.signTypedData({domain: attestationDomain(1, router()), types: attestationTypes, primaryType: "Attestation", message: {user: u.address, expiry}});
    await expect(borrow(u.address, {expiry, signature: otherChain})).rejects.toThrow(/BadAttestation/);

    // Expired: 25h later (with fresh feed rounds so the guard is not what fails).
    await drv.freshRounds((await drv.now()) + 25n * 3600n);
    await expect(borrow(u.address, att)).rejects.toThrow(/BadAttestation/);
    // A fresh attestation works again.
    const again = (await (await attest(u.address)).json()) as {expiry: string; signature: Hex};
    await borrow(u.address, again);
  });

  it("CP_R4 exits need no attestation: with no signer on the router and the guard tripped, repay, withdraw, closeShort and withdrawLend work", async () => {
    const u = privateKeyToAccount(generatePrivateKey());
    await acceptTerms(u);
    await onboard(u.address, 40_000n * E6);
    await borrow(u.address, (await (await attest(u.address)).json()) as {expiry: string; signature: Hex}, 20n * E18, 20_000n * E6);
    // A short opened with an attestation from the driver's path (its own signer, restored below).
    const shorter = "0x57000000000000000000000000000000000000c2" as const;
    await acceptTerms(privateKeyToAccount(signerKey)); // unrelated wallet: keeps the terms table non-empty
    await drv.useAttestationSigner();
    await drv.openShort("NVDA", shorter, 20_000n * E6, 10n * E18);

    // Compliance is gone (signer = 0) and the guardian tripped the guard.
    await setRouterSigner("0x0000000000000000000000000000000000000000");
    await drv.guardian("NVDA", "trip");
    await expect(borrow(u.address, {expiry: (await drv.now()) + 100n, signature: "0x"})).rejects.toThrow(/GuardTripped|BadAttestation/);

    await drv.repay("NVDA", u.address); // repay all by shares
    await a.send(u.address, router(), call(stocklineRouterAbi, "withdrawCollateral", [nvda().stockToken, maxUint256, u.address, (await drv.now()) + 3600n]));
    await drv.closeShort("NVDA", shorter);
    const lender = "0x57000000000000000000000000000000000000c1" as const;
    const shares = await a.client.readContract({address: nvda().vault, abi: vaultV2Abi, functionName: "balanceOf", args: [lender]});
    await drv.withdrawLend("NVDA", lender, shares / 10n);
    for (const who of [u.address, shorter]) {
      const pos = await a.client.readContract({address: a.d.morpho, abi: morphoAbi, functionName: "position", args: [nvda().marketId, who]});
      expect(pos.borrowShares, who).toBe(0n);
    }
    await drv.guardian("NVDA", "clear");
    await setRouterSigner(c.svc.signerAddress);
  });
});
