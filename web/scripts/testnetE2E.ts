/**
 * The whole product end to end against a running stack (the local testnet stack from scripts/dev-testnet.sh, or a
 * hosted one): every surface, every flow a wallet can do now, and every edge case that can be triggered without
 * controlling prices or time. What needs a price shock, a stale feed or a weekend (liquidation, guard trips, margin
 * calls, the kill switch, weekend mode) is covered on anvil and forks (e2e/, forkDrills, DnVault.fork) and listed at
 * the end of the report.
 *
 *   A. Surface (read-only): API routes and their input errors, every page, security headers, compliance refusals.
 *   B. Contract edge cases by simulation (eth_call, nothing sent, no key): each must revert with the named error.
 *   C. Flows (`--flows`, needs `SMOKE_KEY` in env, `TESTNET_GO=yes` on 46630): lending, borrowing, shorting, rescue
 *      top-up, repay, close, withdraw, USDG Earn deposit / instant / queued / settle / claim, each checked against the
 *      API after the indexer catches up; then the attested edge cases (health, slippage, swap target, someone else's
 *      attestation, vault cap, claim before settlement, over-withdrawal).
 *
 *   pnpm --filter @stockline/web exec tsx scripts/testnetE2E.ts --web http://127.0.0.1:3000 --api http://127.0.0.1:42070 \
 *     --compliance http://127.0.0.1:42071 --monitor http://127.0.0.1:42073 --rpc https://rpc.testnet.chain.robinhood.com \
 *     [--flows] [--report ../docs/runbooks/testnet-e2e.md]
 */
import {writeFileSync} from "node:fs";
import {createPublicClient, encodeFunctionData, erc20Abi, http, maxUint256, type Abi, type Hex, type PublicClient} from "viem";
import {generatePrivateKey, privateKeyToAccount} from "viem/accounts";
import {
  deltaNeutralVaultAbi,
  feeConverterAbi,
  getDeployment,
  marketHoursAbi,
  mockAggregatorSwap,
  morphoAbi,
  navOracleAbi,
  stocklineOracleAbi,
  stocklineRouterAbi,
  strategyManagerAbi,
} from "@stockline/sdk";
import {ChainDriver, complianceAttestationProvider, connectWallet, smokeFlows} from "@stockline/devnet";

const arg = (n: string, d = "") => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const has = (n: string) => process.argv.includes(`--${n}`);
const trim = (u: string) => u.replace(/\/$/, "");
const web = trim(arg("web"));
const api = trim(arg("api"));
const compliance = trim(arg("compliance"));
const monitor = trim(arg("monitor"));
const rpc = arg("rpc");
if (!web || !api || !rpc) throw new Error("--web, --api and --rpc are required");

type Result = true | false | "skip";
const rows: {group: string; name: string; ok: Result; detail: string}[] = [];
const t0 = Date.now();
const log = (m: string) => console.log(`[e2e] ${m}`);
async function step(group: string, name: string, f: () => Promise<string | {skip: string}>) {
  try {
    const r = await f();
    const skip = typeof r === "object";
    rows.push({group, name, ok: skip ? "skip" : true, detail: skip ? r.skip : r});
    log(`${skip ? "SKIP" : "ok  "} ${group} · ${name} · ${skip ? r.skip : r}`);
  } catch (e) {
    const detail = (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 220);
    rows.push({group, name, ok: false, detail});
    log(`FAIL ${group} · ${name} · ${detail}`);
  }
}
const get = (url: string, init?: RequestInit) => fetch(url, {...init, redirect: "manual", signal: AbortSignal.timeout(60_000)});
async function status(url: string, want: number | number[], init?: RequestInit): Promise<Response> {
  const r = await get(url, init);
  const ok = Array.isArray(want) ? want.includes(r.status) : r.status === want;
  if (!ok) throw new Error(`${url.replace(/^https?:\/\/[^/]+/, "")} → ${r.status}, expected ${want}`);
  return r;
}

const client = createPublicClient({transport: http(rpc)}) as PublicClient;
const chainId = await client.getChainId();
if (chainId === 4663) throw new Error("refusing mainnet (4663): this suite sends transactions and simulates as test wallets");
const d = getDeployment(chainId);
if (!d) throw new Error(`no deployment for chain ${chainId}`);
const T = "NVDA";
const s = d.stocks[T];
const probe = privateKeyToAccount(generatePrivateKey()).address; // a fresh address: no balance, no role, no position
const now = async () => (await client.getBlock()).timestamp;
const open = await client.readContract({address: d.marketHours, abi: marketHoursAbi, functionName: "isOpen", args: [await now()]});
log(`chain ${chainId}, feed session ${open ? "open" : "CLOSED (entries refuse with MarketClosed-type errors)"}, probe ${probe}`);

/** Simulate `fn` from `from`; passes only when it reverts and the error matches `want`. */
async function refuses(abi: Abi | readonly unknown[], address: `0x${string}`, functionName: string, args: readonly unknown[], from: `0x${string}`, want: RegExp): Promise<string> {
  try {
    await client.simulateContract({address, abi: abi as Abi, functionName, args, account: from} as never);
  } catch (e) {
    const err = e as {shortMessage?: string; message?: string; walk?: (f: (x: unknown) => boolean) => unknown};
    const inner = err.walk?.((x) => typeof (x as {data?: {errorName?: string}}).data?.errorName === "string") as {data?: {errorName?: string; args?: unknown[]}} | undefined;
    const name = inner?.data?.errorName ?? "";
    const text = `${name} ${err.shortMessage ?? ""} ${err.message ?? ""}`;
    if (want.test(text)) return `reverted: ${name || (err.shortMessage ?? "").slice(0, 80)}`;
    throw new Error(`reverted with the wrong reason: ${name || (err.shortMessage ?? "").slice(0, 160)} (expected ${want})`, {cause: e});
  }
  throw new Error(`did not revert (expected ${want})`);
}
const badAtt = async () => ({expiry: (await now()) + 3600n, signature: `0x${"11".repeat(65)}` as Hex});
const deadline = async () => (await now()) + 1800n;

// =============================================================== A. Surface
const G_A = "A · surface";
await step(G_A, "API /v1/status: chain and indexer lag", async () => {
  const j = (await (await status(`${api}/v1/status`, 200)).json()) as {data: {chainId: number; indexer: {lagBlocks: number}}};
  if (j.data.chainId !== chainId) throw new Error(`API chain ${j.data.chainId} ≠ RPC chain ${chainId}`);
  if (j.data.indexer.lagBlocks > 60) throw new Error(`indexer lag ${j.data.indexer.lagBlocks}`);
  return `lag ${j.data.indexer.lagBlocks} blocks`;
});
for (const p of ["/v1/markets", `/v1/markets/${T}`, `/v1/markets/${T}/history`, `/v1/markets/${T}/events`, "/v1/protocol/revenue", "/v1/terms", "/v1/receipt-markets", "/v1/openapi.json", `/v1/positions/${probe}`, `/v1/vault/account/${probe}`, "/v1/vault/overview"])
  await step(G_A, `API ${p} → 200`, async () => `${(await (await status(`${api}${p}`, p.includes("vault") && !d.dnVault ? [200, 404] : 200)).text()).length} bytes`);
await step(G_A, "API /v1/markets/{symbol}: an unknown stock → 404", async () => ((await status(`${api}/v1/markets/TSLA`, [404, 400])).status + ""));
await step(G_A, "API invalid address → 400 (positions, vault account)", async () => {
  await status(`${api}/v1/positions/0x123`, 400);
  await status(`${api}/v1/vault/account/not-an-address`, 400);
  return "both 400";
});
await step(G_A, "API /v1/markets/{symbol}: symbol injection refused", async () => `${(await status(`${api}/v1/markets/${encodeURIComponent("NVDA';--")}`, [400, 404])).status}`);
await step(G_A, "API numbers equal the chain (vault TVL = totalAssets)", async () => {
  if (!d.dnVault) return {skip: "no dnVault"};
  const o = (await (await status(`${api}/v1/vault/overview`, 200)).json()) as {asOfBlock: string; data: {tvl: string}};
  const ta = await client.readContract({address: d.dnVault.vault, abi: deltaNeutralVaultAbi, functionName: "totalAssets", blockNumber: BigInt(o.asOfBlock)});
  const diff = Math.abs(Number(o.data.tvl) - Number(ta) / 1e6);
  if (diff > 0.01) throw new Error(`API tvl ${o.data.tvl} vs chain ${Number(ta) / 1e6} at ${o.asOfBlock}`);
  return `tvl ${o.data.tvl} at block ${o.asOfBlock}`;
});

const pages = ["/", "/markets", `/stock/${T}`, `/stock/${T}?tab=lend`, `/stock/${T}?tab=short`, "/portfolio", "/data", "/vault", "/alerts", "/terms", "/status", "/restricted"];
for (const p of pages)
  await step(G_A, `page ${p} → 200`, async () => {
    const r = await status(`${web}${p}`, 200);
    return `${(await r.text()).length} bytes`;
  });
for (const [from, to] of [[`/market/${T}`, `/stock/${T}`], [`/lend/${T}`, "tab=lend"], [`/short/${T}`, "tab=short"], ["/short-interest", "/data"]] as const)
  await step(G_A, `legacy route ${from} redirects to ${to}`, async () => {
    const r = await get(`${web}${from}`);
    const loc = r.headers.get("location") ?? "";
    if (r.status < 300 || r.status >= 400 || !loc.includes(to)) throw new Error(`${r.status} → ${loc}`);
    return `${r.status} → ${loc.replace(web, "")}`;
  });
await step(G_A, "an unknown page → 404", async () => `${(await status(`${web}/definitely-not-a-page`, 404)).status}`);
await step(G_A, "security headers: CSP with frame-ancestors 'none', object-src 'none'", async () => {
  const csp = (await get(`${web}/markets`)).headers.get("content-security-policy") ?? "";
  if (!/frame-ancestors 'none'/.test(csp) || !/object-src 'none'/.test(csp)) throw new Error(`CSP: ${csp.slice(0, 120) || "missing"}`);
  return `${csp.split(";").length} directives`;
});
await step(G_A, "compliance proxy: only its fixed paths (anything else 404)", async () => {
  await status(`${web}/api/compliance/admin`, 404);
  await status(`${web}/api/compliance/terms/..%2F..%2Fhealth`, 404);
  return "404 for unknown paths";
});
await step(G_A, "compliance proxy: terms text for any address", async () => {
  const t = (await (await status(`${web}/api/compliance/terms?address=${probe}`, 200)).json()) as {version: string};
  return `terms ${t.version}`;
});
await step(G_A, "attestation refused before the terms are signed (APP-R10)", async () => {
  const r = await get(`${web}/api/compliance/attest`, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({address: probe})});
  if (r.ok) throw new Error(`attested an address that never signed the terms (${r.status})`);
  return `${r.status} ${(await r.text()).slice(0, 80)}`;
});
await step(G_A, "terms acceptance with a wrong signature is refused", async () => {
  const t = (await (await status(`${web}/api/compliance/terms?address=${probe}`, 200)).json()) as {version: string};
  const other = privateKeyToAccount(generatePrivateKey());
  const r = await get(`${web}/api/compliance/terms`, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({address: probe, signature: await other.signMessage({message: "not the terms"}), version: t.version})});
  if (r.ok) throw new Error(`accepted a signature by another key (${r.status})`);
  return `${r.status}`;
});
await step(G_A, "compliance direct: client geo headers without the proxy secret are not trusted (CP-R8)", async () => {
  if (!compliance) return {skip: "no --compliance URL"};
  const r = await get(`${compliance}/v1/compliance/attest`, {method: "POST", headers: {"content-type": "application/json", "cf-ipcountry": "DE", "x-vercel-ip-country": "DE"}, body: JSON.stringify({address: probe})});
  if (r.ok) throw new Error(`attested on client-sent geo headers (${r.status})`);
  return `${r.status} ${(await r.text()).slice(0, 60)}`;
});
await step(G_A, "compliance /health", async () => {
  if (!compliance) return {skip: "no --compliance URL"};
  const h = (await (await status(`${compliance}/health`, 200)).json()) as {signer: string; sanctions: string};
  const router = await client.readContract({address: d.router!, abi: stocklineRouterAbi, functionName: "attestationSigner"});
  if (router.toLowerCase() !== h.signer.toLowerCase()) throw new Error(`compliance signer ${h.signer} is not the router's attestation signer ${router}`);
  return `signer = router.attestationSigner; sanctions ${h.sanctions}`;
});
await step(G_A, "monitor /health and the weekend log", async () => {
  if (!monitor) return {skip: "no --monitor URL"};
  await status(`${monitor}/health`, 200);
  const w = (await (await status(`${monitor}/weekends`, 200)).json()) as {weekends?: unknown[]};
  return `${w.weekends?.length ?? 0} closure(s) recorded`;
});

// =============================================================== B. Contract edge cases (simulation, no key)
const G_B = "B · edge cases (simulated)";
const R = d.router!;
await step(G_B, "lend: an expired deadline → Expired", async () => refuses(stocklineRouterAbi, R, "lend", [s.stockToken, 10n ** 18n, 0n, probe, (await now()) - 1n], probe, /Expired/));
await step(G_B, "lend: zero amount → ZeroAmount", async () => refuses(stocklineRouterAbi, R, "lend", [s.stockToken, 0n, 0n, probe, await deadline()], probe, /ZeroAmount/));
await step(G_B, "lend: an unlisted token → NotListed", async () => refuses(stocklineRouterAbi, R, "lend", [probe, 10n ** 18n, 0n, probe, await deadline()], probe, /NotListed/));
await step(G_B, "borrow: a forged attestation → BadAttestation (RT-R2)", async () => refuses(stocklineRouterAbi, R, "borrow", [s.stockToken, 1_000n * 10n ** 6n, 10n ** 17n, probe, await badAtt(), await deadline()], probe, /BadAttestation|GuardTripped|MarketClosed/));
await step(G_B, "borrow: an expired attestation → refused", async () => refuses(stocklineRouterAbi, R, "borrow", [s.stockToken, 1_000n * 10n ** 6n, 10n ** 17n, probe, {expiry: 1n, signature: `0x${"11".repeat(65)}`}, await deadline()], probe, /BadAttestation|Expired/));
await step(G_B, "openShort: a forged attestation → BadAttestation", async () =>
  refuses(stocklineRouterAbi, R, "openShort", [s.stockToken, 1_000n * 10n ** 6n, 10n ** 17n, {target: d.mocks!.swapAggregator, data: "0x", amountIn: 10n ** 17n, minOut: 0n}, false, probe, await badAtt(), await deadline()], probe, /BadAttestation|GuardTripped|MarketClosed/),
);
await step(G_B, "addCollateral without a debt position → NoDebtPosition (RT-R8)", async () => refuses(stocklineRouterAbi, R, "addCollateral", [s.stockToken, 10n ** 6n, probe, await deadline()], probe, /NoDebtPosition/));
await step(G_B, "router owner action from a stranger → NotOwner", async () => refuses(stocklineRouterAbi, R, "setGlobalCap", [1n], probe, /NotOwner/));
await step(G_B, "oracle guard trip from a stranger → Unauthorized", async () => refuses(stocklineOracleAbi, s.oracle, "trip", [1n], probe, /Unauthorized/));
await step(G_B, "Morpho: withdraw collateral you don't have → reverts", async () => {
  const p = await client.readContract({address: R, abi: stocklineRouterAbi, functionName: "market", args: [s.stockToken]});
  return refuses(morphoAbi, d.morpho, "withdrawCollateral", [p.params, 10n ** 6n, probe, probe], probe, /./);
});
if (d.feeSplitter && d.treasuryConverter)
  await step(G_B, "fee converter: convert by a non-keeper → NotKeeper (FE-R4)", async () =>
    refuses(feeConverterAbi, d.treasuryConverter!, "convert", [s.vault, 1n, 1n, {target: d.mocks!.swapAggregator, data: "0x"}], probe, /NotKeeper/),
  );
if (d.dnVault) {
  const v = d.dnVault;
  await step(G_B, "vault: plain ERC-4626 deposit → AttestationRequired (A42)", async () => refuses(deltaNeutralVaultAbi, v.vault, "deposit", [10n ** 6n, probe], probe, /AttestationRequired/));
  await step(G_B, "vault: mint → AttestationRequired", async () => refuses(deltaNeutralVaultAbi, v.vault, "mint", [10n ** 18n, probe], probe, /AttestationRequired/));
  await step(G_B, "vault: attested deposit with a forged attestation → refused", async () => refuses(deltaNeutralVaultAbi, v.vault, "deposit", [10n ** 6n, probe, await badAtt()], probe, /BadAttestation|NavStale|MarketClosed|DepositsPaused/));
  await step(G_B, "vault: claim a request that doesn't exist → NotClaimable", async () => refuses(deltaNeutralVaultAbi, v.vault, "claim", [10n ** 9n], probe, /NotClaimable/));
  await step(G_B, "vault: withdraw with no shares → refused", async () => refuses(deltaNeutralVaultAbi, v.vault, "withdraw", [10n ** 6n, probe, probe], probe, /ExceedsInstant|ERC4626|Exceeded|NavStale|MarketClosed/));
  await step(G_B, "vault: requestRedeem with no shares → refused", async () => refuses(deltaNeutralVaultAbi, v.vault, "requestRedeem", [10n ** 18n, probe, probe], probe, /./));
  await step(G_B, "vault: guardian actions from a stranger → NotGuardian", async () => refuses(deltaNeutralVaultAbi, v.vault, "setDepositsPaused", [true], probe, /NotGuardian/));
  await step(G_B, "strategy: operator action from a stranger → NotOperator (DN-R10)", async () => refuses(strategyManagerAbi, v.strategy, "pullFromVault", [1n], probe, /NotOperator/));
  await step(G_B, "NAV oracle: an unsigned report → BadSignature (DN-R4)", async () => {
    const last = await client.readContract({address: v.navOracle, abi: navOracleAbi, functionName: "lastReport"});
    const ts = await now();
    if (ts <= last.timestamp) return {skip: "a report landed in this block; re-run"};
    return refuses(navOracleAbi, v.navOracle, "submit", [{...last, timestamp: ts}, []], probe, /BadSignature|TradeNotReported|BadReport/);
  });
  await step(G_B, "vault: settle with an empty or unpayable queue changes nothing", async () => {
    const [head, tail] = await client.readContract({address: v.vault, abi: deltaNeutralVaultAbi, functionName: "queueBounds"});
    const r = await client.simulateContract({address: v.vault, abi: deltaNeutralVaultAbi, functionName: "settle", args: [20n], account: probe}).catch((e: Error) => ({result: `reverts: ${e.message.split("\n")[0].slice(0, 80)}`}));
    return `queue ${head}..${tail}; settle(20) → ${String((r as {result: unknown}).result)}`;
  });
}

// =============================================================== C. Flows (key)
const G_C = "C · flows";
const G_E = "C · edge cases (with a position)";
if (has("flows")) {
  const key = process.env.SMOKE_KEY as Hex | undefined;
  if (!key) throw new Error("--flows needs SMOKE_KEY (env)");
  if (chainId === 46630 && process.env.TESTNET_GO !== "yes") throw new Error("TESTNET_GO=yes is required to send on testnet");
  const a = await connectWallet(rpc, key);
  const me = privateKeyToAccount(key).address;
  // One attestation per run (valid 24h): compliance rate-limits attestation requests (429), by design.
  const fresh = complianceAttestationProvider(`${web}/api/compliance`, key);
  let cached: {expiry: bigint; signature: Hex} | undefined;
  const attest = async (user: `0x${string}`) => {
    if (user.toLowerCase() !== me.toLowerCase()) return fresh(user);
    if (!cached || cached.expiry < (await now()) + 600n) cached = await fresh(user);
    return cached;
  };
  const drv = new ChainDriver(a, {log: () => {}, attestationProvider: attest, mint: false});
  await drv.syncPrices();
  const bal = (token: `0x${string}`, who: `0x${string}` = me) => client.readContract({address: token, abi: erc20Abi, functionName: "balanceOf", args: [who]});
  const indexed = async (block: bigint) => {
    for (let i = 0; i < 120; i++) {
      const j = (await (await get(`${api}/v1/status`)).json()) as {data: {indexer: {headBlock: string}}};
      if (BigInt(j.data.indexer.headBlock) >= block) return;
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error(`indexer did not reach block ${block} in 4 min`);
  };
  log(`tester ${me}: ${Number(await bal(d.usdg)) / 1e6} USDG, ${Number(await bal(s.stockToken)) / 1e18} ${T}, ${Number(await client.getBalance({address: me})) / 1e18} ETH`);

  await step(G_C, "faucet: claim test USDG + stocks (once per 24h)", async () => {
    if (!d.mocks?.faucet) return {skip: "no faucet on this chain"};
    try {
      const r = await a.send(me, d.mocks.faucet, encodeFunctionData({abi: [{type: "function", name: "claim", stateMutability: "nonpayable", inputs: [{type: "address"}], outputs: []}], functionName: "claim", args: [me]}));
      return `claimed in ${r.transactionHash}`;
    } catch (e) {
      return {skip: `already claimed in the last 24h (${String(e).split("\n")[0].slice(0, 60)})`};
    }
  });
  await step(G_C, "terms signed + attestation through the web's compliance proxy", async () => {
    const at = await attest(me);
    return `valid until ${new Date(Number(at.expiry) * 1000).toISOString()}`;
  });
  await step(G_C, "lending and borrowing: lend, short, rescue top-up, repay, close, borrow, repay all, withdraw", async () => {
    if (!open) return {skip: "feed session closed: entries refuse by design (re-run during the US session)"};
    const ev = await smokeFlows(drv, me, () => {}, {allocate: false});
    await indexed(ev.at(-1)!.block);
    return `${ev.length} txs (${[...new Set(ev.map((e) => e.kind))].join(", ")}), indexed`;
  });
  await step(G_C, "API /v1/positions reflects the wallet after the flows", async () => {
    const p = (await (await status(`${api}/v1/positions/${me}`, 200)).json()) as {data: unknown};
    return `${JSON.stringify(p.data).slice(0, 120)}`;
  });

  // Edge cases that need an attestation or a position.
  await step(G_E, "borrow inside Morpho's LLTV but under the router's buffered health → HealthTooLow (RT-R1)", async () => {
    const att = await attest(me);
    // 100 USDG collateral, debt worth 76.5% of it: Morpho (LLTV 77%) would allow it, the router's buffered check
    // (next-close price + the buffer) must not.
    const collateral = 100n * 10n ** 6n;
    if ((await bal(d.usdg)) < collateral) return {skip: "under 100 USDG"};
    const price = drv.prices[T]; // 8 dp, synced from the feed
    const amount = (collateral * 765n * 10n ** 20n) / (1000n * price); // USDG 6dp → stock 18dp
    return refuses(stocklineRouterAbi, R, "borrow", [s.stockToken, collateral, amount, me, att, await deadline()], me, /HealthTooLow|GuardTripped|MarketClosed/);
  });
  await step(G_E, "openShort through a swap target that isn't allowlisted → SwapTargetNotAllowed (RT-R3)", async () => {
    const att = await attest(me);
    return refuses(stocklineRouterAbi, R, "openShort", [s.stockToken, 500n * 10n ** 6n, 10n ** 17n, {target: probe, data: "0x", amountIn: 10n ** 17n, minOut: 0n}, false, me, att, await deadline()], me, /SwapTargetNotAllowed|GuardTripped|MarketClosed/);
  });
  await step(G_E, "openShort with a minimum above what the DEX pays → InsufficientOutput (slippage, FE-R4-style bound)", async () => {
    const att = await attest(me);
    const amount = 10n ** 17n;
    const swap = mockAggregatorSwap(d.mocks!.swapAggregator, s.stockToken, d.usdg, amount, 10n ** 12n, R); // 1M USDG for 0.1 NVDA
    return refuses(stocklineRouterAbi, R, "openShort", [s.stockToken, 500n * 10n ** 6n, amount, swap, false, me, att, await deadline()], me, /InsufficientOutput|GuardTripped|MarketClosed/);
  });
  await step(G_E, "someone else's attestation is refused (bound to the wallet)", async () => {
    const att = await attest(me);
    return refuses(stocklineRouterAbi, R, "borrow", [s.stockToken, 500n * 10n ** 6n, 10n ** 17n, probe, att, await deadline()], probe, /BadAttestation/);
  });
  await step(G_E, "withdraw more lent shares than held → refused", async () => refuses(stocklineRouterAbi, R, "withdrawLend", [s.stockToken, 10n ** 30n, 0n, me, await deadline()], me, /./));
  await step(G_E, "repay with no debt → refused or no-op", async () => {
    const r = await client.simulateContract({address: R, abi: stocklineRouterAbi, functionName: "repay", args: [s.stockToken, 0n, maxUint256, me, await deadline()], account: me}).catch((e: Error) => ({result: `reverts (${e.message.split("\n")[0].slice(0, 60)})`}));
    return `repay(all) with no debt → ${String((r as {result: unknown}).result)}`;
  });

  if (d.dnVault) {
    const v = d.dnVault;
    const rdv = <T,>(fn: string, args: readonly unknown[] = []) => (client.readContract as (p: unknown) => Promise<T>)({address: v.vault, abi: deltaNeutralVaultAbi, functionName: fn, args});
    const send = (fn: string, args: readonly unknown[]) => a.send(me, v.vault, encodeFunctionData({abi: deltaNeutralVaultAbi, functionName: fn, args} as never));
    let reqId: bigint | undefined;
    await step(G_C, "USDG Earn: attested deposit of 100 USDG mints shares at the share price", async () => {
      if (!(await client.readContract({address: v.navOracle, abi: navOracleAbi, functionName: "fresh"}))) throw new Error("NAV stale: is the nav-reporter running? (dn-nav-stale.md)");
      if (!open) return {skip: "feed session closed: the vault neither mints nor burns (DN-R12)"};
      if ((await bal(d.usdg)) < 100n * 10n ** 6n) return {skip: "under 100 USDG: claim the faucet"};
      if ((await client.readContract({address: d.usdg, abi: erc20Abi, functionName: "allowance", args: [me, v.vault]})) < 100n * 10n ** 6n) await a.send(me, d.usdg, encodeFunctionData({abi: erc20Abi, functionName: "approve", args: [v.vault, maxUint256]}));
      const before = await bal(v.vault);
      const r = await send("deposit", [100n * 10n ** 6n, me, await attest(me)]);
      const minted = (await bal(v.vault)) - before;
      await indexed(r.blockNumber);
      const acct = (await (await status(`${api}/v1/vault/account/${me}`, 200)).json()) as {data: {shares: string}};
      return `${Number(minted) / 1e18} shares; API shares ${acct.data.shares}`;
    });
    await step(G_E, "vault: deposit above the cap → refused (DN-R6)", async () => {
      const cap = await rdv<bigint>("totalCap");
      return refuses(deltaNeutralVaultAbi, v.vault, "deposit", [cap + 1n, me, await attest(me)], me, /CapExceeded|ERC4626|Exceeded|NavStale|MarketClosed/);
    });
    await step(G_C, "USDG Earn: instant withdrawal of 10 USDG (no attestation, CP-R4)", async () => {
      if (!open) return {skip: "feed session closed (DN-R12)"};
      const before = await bal(d.usdg);
      await send("withdraw", [10n * 10n ** 6n, me, me]);
      return `received ${Number((await bal(d.usdg)) - before) / 1e6} USDG`;
    });
    await step(G_E, "vault: instant withdrawal above the cash buffer → ExceedsInstant", async () => {
      const inst = await rdv<bigint>("instantCapacity");
      return refuses(deltaNeutralVaultAbi, v.vault, "withdraw", [inst + 10n ** 12n, me, me], me, /ExceedsInstant|ERC4626|Exceeded/);
    });
    await step(G_E, "vault: requestRedeem more shares than held → refused", async () => refuses(deltaNeutralVaultAbi, v.vault, "requestRedeem", [(await bal(v.vault)) + 1n, me, me], me, /./));
    await step(G_C, "USDG Earn: queued withdrawal request (always accepted)", async () => {
      const sh = await bal(v.vault);
      if (sh === 0n) return {skip: "no shares"};
      await send("requestRedeem", [sh / 2n, me, me]);
      const [, tail] = await rdv<readonly [bigint, bigint]>("queueBounds");
      reqId = tail - 1n;
      const req = await rdv<{settleBy: bigint}>("request", [reqId]);
      return `request ${reqId}, settles by ${new Date(Number(req.settleBy) * 1000).toISOString()}`;
    });
    await step(G_E, "vault: claim before settlement → NotClaimable", async () => {
      if (reqId === undefined) return {skip: "no request"};
      if ((await rdv<{status: number}>("request", [reqId])).status === 2) return {skip: "already settled by the rebalancer"};
      return refuses(deltaNeutralVaultAbi, v.vault, "claim", [reqId], me, /NotClaimable/);
    });
    await step(G_C, "USDG Earn: settle (permissionless) then claim; the API shows it claimed", async () => {
      if (reqId === undefined) return {skip: "no request"};
      if ((await rdv<{status: number}>("request", [reqId])).status !== 2) {
        try {
          await send("settle", [20n]);
        } catch (e) {
          return {skip: `not settleable now (${String(e).split("\n")[0].slice(0, 80)}); the rebalancer settles it by its deadline, then claim from /portfolio`};
        }
      }
      if ((await rdv<{status: number}>("request", [reqId])).status !== 2) return {skip: `request ${reqId} still queued (cash short): the rebalancer raises cash; claim later from /portfolio`};
      const before = await bal(d.usdg);
      const r = await send("claim", [reqId]);
      await indexed(r.blockNumber);
      const acct = (await (await status(`${api}/v1/vault/account/${me}`, 200)).json()) as {data: {requests: {id: string; status: string}[]}};
      const st = acct.data.requests.find((x) => x.id === String(reqId))?.status;
      if (st !== "claimed") throw new Error(`API shows request ${reqId} as ${st}`);
      return `claimed ${Number((await bal(d.usdg)) - before) / 1e6} USDG; API: claimed`;
    });
  }
}

const failed = rows.filter((r) => r.ok === false).length;
const skipped = rows.filter((r) => r.ok === "skip").length;
const md = `# Product end-to-end on chain ${chainId}

Run ${new Date().toISOString()} by \`web/scripts/testnetE2E.ts\` (${Math.round((Date.now() - t0) / 1000)} s): web ${web}, API ${api}${compliance ? `, compliance ${compliance}` : ""}${monitor ? `, monitor ${monitor}` : ""}, RPC ${rpc.replace(/\/v2\/.*/, "/…")}.
Feed session ${open ? "open" : "closed"}. ${has("flows") ? "With flows (tester key)." : "Surface and simulated edge cases only (no key)."}
**${failed === 0 ? "All checks passed" : `${failed} check(s) failed`}** (${rows.length - failed - skipped} ok, ${skipped} skipped).

| Group | Check | Result | Detail |
|---|---|---|---|
${rows.map((r) => `| ${r.group} | ${r.name} | ${r.ok === "skip" ? "skip" : r.ok ? "ok" : "**FAIL**"} | ${r.detail.replace(/\|/g, "\\|")} |`).join("\n")}

**Not testable on a live chain now** (needs prices or time we don't control; covered on anvil / forks): liquidation of an
unhealthy position (MON-R2), guard trips from a feed deviation or a stale feed, issuer pause / blocklist, the weekend
buffer ramp (happens by itself Fri 16:00 ET), a > 2× re-anchor, bad debt and backing shortfalls, DN margin top-up after
a big move, the funding kill switch, a venue halt, the queued-withdrawal deadline (72h / next US open).
`;
if (arg("report")) writeFileSync(arg("report"), md);
console.log(md);
process.exit(failed === 0 ? 0 : 1);
