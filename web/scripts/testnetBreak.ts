/**
 * Try to break the whole product on a running stack (the local testnet stack, or a hosted one), as a hostile user
 * with one test wallet and no role. Every check states what must hold; a FAIL is a bug (or an undocumented residual).
 *
 *   W. Web: reflected input, open redirects, oversized and malformed bodies, proxy path escapes, methods, headers.
 *   P. API: every parameter with hostile values (never a 5xx), SIWE key replay / wrong domain, WebSocket limits.
 *   K. Compliance: malformed requests, terms forgery, a sanctioned address, direct access without the proxy secret.
 *   R. Router and tokens by simulation: zero / max / dust amounts, zero receivers, forged or expired attestations,
 *      hostile swap data, every owner action from a stranger, clUSDG outside the router, the faucet.
 *   X. Bypasses with real transactions (`--flows`, feed session open): collateral withdrawn past the router's 24h
 *      buffer, clUSDG handed to a never-attested wallet that then borrows on Morpho directly (and whether the monitor
 *      pages DIRECT_BORROW), a dust vault request through the queue. Everything is unwound at the end.
 *   S. Invariants after all of it: the router holds nothing, backing ≥ supply, the API equals the chain.
 *   Z. Abuse last (it spends rate-limit budget): API and page bursts, compliance attestation flood.
 *
 *   SMOKE_KEY=… TESTNET_GO=yes pnpm --filter @stockline/web exec tsx scripts/testnetBreak.ts --web http://127.0.0.1:3000 \
 *     --api http://127.0.0.1:42070 --compliance http://127.0.0.1:42071 --monitor http://127.0.0.1:42073 \
 *     --rpc https://rpc.testnet.chain.robinhood.com [--flows] [--report ../docs/runbooks/testnet-break.md]
 */
import {readFileSync, writeFileSync} from "node:fs";
import {encodeFunctionData, erc20Abi, maxUint256, parseEther, type Hex} from "viem";
import {generatePrivateKey, privateKeyToAccount} from "viem/accounts";
import {createSiweMessage} from "viem/siwe";
import {
  collateralTokenAbi,
  deltaNeutralVaultAbi,
  getDeployment,
  marketHoursAbi,
  mockAggregatorSwap,
  morphoAbi,
  stocklineOracleAbi,
  stocklineRouterAbi,
  stockWrapperAbi,
} from "@stockline/sdk";
import {ChainDriver, complianceAttestationProvider, connectWallet, waitForLiquidity} from "@stockline/devnet";
import {explainError} from "../lib/errors";
import {arg, has, kit, trim} from "./e2eKit";

const web = trim(arg("web"));
const api = trim(arg("api"));
const compliance = trim(arg("compliance"));
const monitor = trim(arg("monitor"));
const rpc = arg("rpc");
if (!web || !api || !rpc) throw new Error("--web, --api and --rpc are required");
const {client, step, get, status, revertOf, refuses, table, counts, log} = kit(rpc, "break", explainError);

const chainId = await client.getChainId();
if (chainId === 4663) throw new Error("refusing mainnet (4663)");
const d = getDeployment(chainId);
if (!d?.router) throw new Error(`no deployment for chain ${chainId}`);
const R = d.router;
const T = "NVDA";
const s = d.stocks[T];
const E6 = 10n ** 6n;
const E18 = 10n ** 18n;
const ZERO = "0x0000000000000000000000000000000000000000" as const;
const EVIL = "evil.example";
const now = async () => (await client.getBlock()).timestamp;
const deadline = async () => (await now()) + 1800n;
const open = await client.readContract({address: d.marketHours, abi: marketHoursAbi, functionName: "isOpen", args: [await now()]});
const probeKey = generatePrivateKey();
const probe = privateKeyToAccount(probeKey).address; // a stranger: no funds, no role, never attested
const params = (await client.readContract({address: R, abi: stocklineRouterAbi, functionName: "market", args: [s.stockToken]})).params;
const faucetAbi = [
  {type: "function", name: "claim", stateMutability: "nonpayable", inputs: [{name: "to", type: "address"}], outputs: []},
  {type: "error", name: "TooSoon", inputs: [{name: "nextClaimAt", type: "uint256"}]},
] as const;
log(`chain ${chainId}, session ${open ? "open" : "closed"}, stranger ${probe}`);

/** Never a 5xx; `want` is the set of acceptable statuses. */
async function sane(url: string, want: number[], init?: RequestInit): Promise<string> {
  const r = await get(url, init);
  const body = await r.text();
  if (r.status >= 500 && !want.includes(r.status)) throw new Error(`${r.status} (server error) ${body.slice(0, 100)}`);
  if (!want.includes(r.status)) throw new Error(`${r.status}, expected ${want.join("/")}: ${body.slice(0, 100)}`);
  return `${r.status}`;
}
const post = (body: BodyInit, type = "application/json", extra: Record<string, string> = {}): RequestInit => ({method: "POST", headers: {"content-type": type, ...extra}, body});
const big = (mb: number) => JSON.stringify({address: probe, pad: "x".repeat(mb * 1024 * 1024)});

// =============================================================== W. Web
const W = "W · web";
await step(W, "reflected script in /stock/{symbol} is not echoed and is not a 5xx", async () => {
  const r = await get(`${web}/stock/${encodeURIComponent("<script>alert(1)</script>")}`);
  const b = await r.text();
  if (r.status >= 500) throw new Error(`${r.status}`);
  if (b.includes("<script>alert(1)</script>")) throw new Error("payload reflected unescaped");
  return `${r.status}, not reflected`;
});
await step(W, "reflected markup in ?tab= is not echoed", async () => {
  const p = "<img src=x onerror=alert(1)>";
  const r = await get(`${web}/stock/${T}?tab=${encodeURIComponent(p)}`);
  const b = await r.text();
  if (r.status >= 500) throw new Error(`${r.status}`);
  if (b.includes(p)) throw new Error("payload reflected unescaped");
  return `${r.status}, not reflected`;
});
await step(W, "unknown or lower-case stock symbols are a clean 404 or a redirect, never a 5xx", async () => {
  const out = [];
  for (const sym of ["nvda", "TSLA", "N%00VDA", "%F0%9F%92%A9", "A".repeat(3000)]) out.push(`${sym.slice(0, 8)}:${await sane(`${web}/stock/${sym}`, [200, 301, 302, 307, 308, 400, 404, 414])}`);
  return out.join(" ");
});
for (const path of [`/market//${EVIL}`, `/market/%2F%2F${EVIL}`, `/lend/..%2F..%2F%2F${EVIL}`, `/short/%5C%5C${EVIL}`, `/short-interest?next=//${EVIL}`, `//${EVIL}/`])
  await step(W, `no open redirect: ${path}`, async () => {
    const r = await get(`${web}${path}`);
    const loc = r.headers.get("location") ?? "";
    if (r.status >= 500) throw new Error(`${r.status}`);
    if (loc && (new URL(loc, web).host !== new URL(web).host)) throw new Error(`redirects off-site to ${loc}`);
    return `${r.status}${loc ? ` → ${loc.replace(web, "")}` : ""}`;
  });
await step(W, "a 16 KB path is refused cleanly", async () => sane(`${web}/${"a".repeat(16_384)}`, [400, 404, 414, 431]));
for (const [name, path] of [["compliance", "/api/compliance/attest"], ["compliance terms", "/api/compliance/terms"], ["alerts", `/api/alerts/settings/${probe}`], ["analytics", "/api/analytics"]] as const) {
  await step(W, `${name} proxy: a non-JSON body is a 4xx`, async () => sane(`${web}${path}`, [204, 400, 401, 403, 404, 415, 422, 503], post("not json", "text/plain")));
  await step(W, `${name} proxy: a 12 MB body is refused before it is buffered and forwarded`, async () => {
    const t = Date.now();
    const r = await get(`${web}${path}`, post(big(12)));
    if (r.status >= 500 && r.status !== 503) throw new Error(`${r.status} after ${Date.now() - t} ms`);
    if (r.status !== 413) throw new Error(`accepted a 12 MB body (${r.status} after ${Date.now() - t} ms): no size limit, so a client can make the server buffer arbitrary bodies`);
    return `413 in ${Date.now() - t} ms`;
  });
}
await step(W, "the web app still serves pages after the oversized bodies", async () => `${(await status(`${web}/markets`, 200)).status}`);
for (const p of ["/api/compliance/%2e%2e/health", "/api/compliance/..%252f..%252fhealth", "/api/compliance/terms/0xZZ", `/api/compliance/terms/${probe}/../../health`, "/api/compliance/attest%00", "/api/alerts/..%2fhealth", "/api/alerts/settings/../../admin"])
  await step(W, `proxy path escape refused: ${p}`, async () => sane(`${web}${p}`, [400, 404]));
for (const m of ["PUT", "DELETE", "PATCH"])
  await step(W, `${m} on the compliance proxy → 405`, async () => sane(`${web}/api/compliance/attest`, [404, 405], {method: m}));
await step(W, "alerts proxy with the alerts service down → 503 with a message, not a hang", async () => {
  const r = await get(`${web}/api/alerts/settings/${probe}`);
  if (r.status >= 500 && r.status !== 503) throw new Error(`${r.status}`);
  return `${r.status} ${(await r.text()).slice(0, 60)}`;
});
await step(W, "security headers on every page: CSP frame-ancestors/object-src, nosniff, referrer-policy", async () => {
  const missing: string[] = [];
  for (const p of ["/", "/markets", `/stock/${T}`, "/portfolio", "/vault", "/terms", "/restricted"]) {
    const h = (await get(`${web}${p}`)).headers;
    const csp = h.get("content-security-policy") ?? "";
    if (!/frame-ancestors 'none'/.test(csp)) missing.push(`${p}: frame-ancestors`);
    if (!/object-src 'none'/.test(csp)) missing.push(`${p}: object-src`);
    if (h.get("x-content-type-options") !== "nosniff") missing.push(`${p}: nosniff`);
    if (!h.get("referrer-policy")) missing.push(`${p}: referrer-policy`);
  }
  if (missing.length) throw new Error(missing.join(", "));
  return "7 pages";
});

// =============================================================== P. API
const P = "P · API";
const owner = privateKeyToAccount(generatePrivateKey()); // a throwaway SIWE signer (no funds needed)
let apiKey = "";
await step(P, "SIWE: create an API key (07 §2)", async () => {
  const n = (await (await status(`${api}/v1/auth/nonce`, 200)).json()) as {nonce: string; domain: string; chainId: number; statement: string};
  const message = createSiweMessage({domain: n.domain, address: owner.address, statement: n.statement, uri: `http://${n.domain}`, version: "1", chainId: n.chainId, nonce: n.nonce});
  const signature = await owner.signMessage({message});
  const r = await status(`${api}/v1/auth/keys`, 201, post(JSON.stringify({message, signature, label: "break"})));
  apiKey = ((await r.json()) as {key: string}).key;
  const again = await get(`${api}/v1/auth/keys`, post(JSON.stringify({message, signature})));
  if (again.ok) throw new Error(`the same signed message created a second key (${again.status}): nonce replay`);
  return `key created; replaying the signed message → ${again.status}`;
});
await step(P, "SIWE: a message for another domain is refused", async () => {
  const n = (await (await status(`${api}/v1/auth/nonce`, 200)).json()) as {nonce: string; chainId: number; statement: string};
  const message = createSiweMessage({domain: EVIL, address: owner.address, statement: n.statement, uri: `https://${EVIL}`, version: "1", chainId: n.chainId, nonce: n.nonce});
  return sane(`${api}/v1/auth/keys`, [400, 401], post(JSON.stringify({message, signature: await owner.signMessage({message})})));
});
await step(P, "SIWE: a signature by another wallet is refused", async () => {
  const n = (await (await status(`${api}/v1/auth/nonce`, 200)).json()) as {nonce: string; domain: string; chainId: number; statement: string};
  const message = createSiweMessage({domain: n.domain, address: owner.address, statement: n.statement, uri: `http://${n.domain}`, version: "1", chainId: n.chainId, nonce: n.nonce});
  return sane(`${api}/v1/auth/keys`, [400, 401], post(JSON.stringify({message, signature: await privateKeyToAccount(generatePrivateKey()).signMessage({message})})));
});
const K = () => ({headers: apiKey ? {"x-api-key": apiKey} : {}}) as RequestInit;
await step(P, "a wrong API key → 401 (and it costs the free budget, OFF-9)", async () => sane(`${api}/v1/markets`, [401, 429], {headers: {"x-api-key": "0".repeat(40)}}));
await step(P, "keys list and revoke need a key", async () => `${await sane(`${api}/v1/auth/keys`, [401])} / ${await sane(`${api}/v1/auth/keys/0123456789abcdef`, [401], {method: "DELETE"})}`);
await step(P, "a 3 MB key request body is refused", async () => sane(`${api}/v1/auth/keys`, [400, 413], post(big(3))));
const hostile: [string, number[]][] = [
  [`/v1/markets/${T}/history?interval=bogus`, [400]],
  [`/v1/markets/${T}/history?from=abc`, [400]],
  [`/v1/markets/${T}/history?from=-1`, [200, 400]],
  [`/v1/markets/${T}/history?from=99999999999&to=1`, [200, 400]],
  [`/v1/markets/${T}/history?limit=0`, [200, 400]],
  [`/v1/markets/${T}/history?limit=-5`, [400]],
  [`/v1/markets/${T}/history?limit=100000000000`, [200, 400]],
  [`/v1/markets/${T}/history?limit=1e3`, [200, 400]],
  [`/v1/markets/${T}/history?format=xml`, [400]],
  [`/v1/markets/${T}/history?from=1&to=99999999999&interval=1m`, [200, 400]],
  [`/v1/markets/${T}/events?type=bogus`, [400]],
  [`/v1/markets/${T}/events?cursor=${encodeURIComponent("'; drop table x;--")}`, [400]],
  [`/v1/markets/${T}/events?cursor=${"9".repeat(80)}`, [200, 400]],
  [`/v1/markets/${T}/events?account=0x123`, [400]],
  [`/v1/markets/${T}/events?limit=999999999`, [200, 400]],
  ["/v1/protocol/revenue?from=abc", [400]],
  ["/v1/protocol/revenue?from=5&to=1", [200, 400]],
  [`/v1/positions/${probe.toLowerCase()}`, [200]],
  [`/v1/positions/${probe.slice(0, 2)}${probe.slice(2).toUpperCase()}`, [200, 400]],
  ["/v1/markets/nvda", [200, 301, 404]],
  ["/v1/markets/%F0%9F%92%A9", [400, 404]],
  [`/v1/markets/${"A".repeat(5000)}`, [400, 404, 414]],
  [`/v1/vault/account/${ZERO}`, [200, 400, 404]],
  ["/v1/definitely-not-a-route", [404]],
];
for (const [p, want] of hostile) await step(P, `hostile input ${p.slice(0, 70)}`, async () => sane(`${api}${p}`, want, K()));
await step(P, "history CSV is CSV (SI-R12)", async () => {
  const r = await status(`${api}/v1/markets/${T}/history?format=csv`, 200, K());
  const ct = r.headers.get("content-type") ?? "";
  if (!ct.includes("csv")) throw new Error(`content-type ${ct}`);
  return `${ct}, ${(await r.text()).split("\n").length} lines`;
});
await step(P, "POST on a read route → 404/405", async () => sane(`${api}/v1/markets`, [404, 405], {...K(), method: "POST"}));
await step(P, "CORS never reflects an arbitrary origin with credentials", async () => {
  const r = await get(`${api}/v1/markets`, {method: "OPTIONS", headers: {origin: `https://${EVIL}`, "access-control-request-method": "GET"}});
  const o = r.headers.get("access-control-allow-origin");
  const cred = r.headers.get("access-control-allow-credentials");
  if (o === `https://${EVIL}` && cred === "true") throw new Error("reflects the origin with credentials");
  return `allow-origin ${o ?? "none"}, credentials ${cred ?? "no"}`;
});
await step(P, "WebSocket: welcome, a push on a new block, message flood closes it (OFF-11), one free socket per IP (SI-R10)", async () => {
  const url = `${api.replace(/^http/, "ws")}/v1/stream`;
  const ws = new WebSocket(url);
  const got: string[] = [];
  const closed = new Promise<number>((res) => ws.addEventListener("close", (e) => res(e.code)));
  ws.addEventListener("message", (e) => got.push(String(e.data)));
  await new Promise<void>((res, rej) => {
    ws.addEventListener("open", () => res());
    ws.addEventListener("error", () => rej(new Error("could not connect")));
  });
  ws.send(JSON.stringify({channel: "market", symbol: T}));
  for (let i = 0; i < 60 && got.length < 2; i++) await new Promise((r) => setTimeout(r, 500));
  if (!got.some((m) => m.includes("welcome"))) throw new Error("no welcome");
  if (got.length < 2) throw new Error("no push within 30 s");
  const second = await fetch(`${api}/v1/stream`, {headers: {connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ=="}}).then((r) => r.status).catch(() => 0);
  for (let i = 0; i < 40; i++) ws.send("{not json");
  const code = await Promise.race([closed, new Promise<number>((r) => setTimeout(() => r(-1), 15_000))]);
  if (code !== 1008) throw new Error(`flood not closed with 1008 (got ${code})`);
  return `${got.length} messages; second socket → ${second}; flood → close ${code}`;
});

// =============================================================== K. Compliance
const C = "K · compliance";
for (const [name, body, type] of [["{}", "{}", "application/json"], ["address 0x123", JSON.stringify({address: "0x123"}), "application/json"], ["address as a number", JSON.stringify({address: 123}), "application/json"], ["not JSON", "address=0x1", "application/x-www-form-urlencoded"], ["a JSON array", "[1,2]", "application/json"]] as const)
  await step(C, `attest with ${name} → 4xx`, async () => sane(`${web}/api/compliance/attest`, [400, 403, 415, 422], post(body, type)));
await step(C, "terms: a malformed signature → 4xx", async () => {
  const t = (await (await status(`${web}/api/compliance/terms?address=${probe}`, 200)).json()) as {version: string};
  return sane(`${web}/api/compliance/terms`, [400, 401, 403, 422], post(JSON.stringify({address: probe, signature: "0x1234", version: t.version})));
});
await step(C, "terms: the right key signing a wrong version is refused", async () => {
  const t = (await (await status(`${web}/api/compliance/terms?address=${probe}`, 200)).json()) as {version: string; text?: string; message?: string};
  const message = t.message ?? t.text ?? `terms ${t.version}`;
  return sane(`${web}/api/compliance/terms`, [400, 401, 403, 409, 422], post(JSON.stringify({address: probe, signature: await privateKeyToAccount(probeKey).signMessage({message}), version: `${t.version}-forged`})));
});
await step(C, "a sanctioned address (deny-list) is never attested", async () => {
  let bad = "";
  try {
    bad = (JSON.parse(readFileSync(new URL("../../.dev/testnet-users.json", import.meta.url), "utf8")) as {sanctioned?: {address?: string}}).sanctioned?.address ?? "";
  } catch {
    /* no users file */
  }
  if (!bad) return {skip: "no deny-listed test user in .dev/testnet-users.json"};
  const r = await get(`${web}/api/compliance/attest`, post(JSON.stringify({address: bad})));
  if (r.ok) throw new Error(`attested a deny-listed address (${r.status})`);
  return `${r.status} ${(await r.text()).slice(0, 80)}`;
});
await step(C, "compliance direct: forged proxy secret is not trusted (CP-R8)", async () => {
  if (!compliance) return {skip: "no --compliance URL"};
  const r = await get(`${compliance}/v1/compliance/attest`, post(JSON.stringify({address: probe}), "application/json", {"x-stockline-proxy": "0".repeat(64), "x-geo-country": "DE", "x-forwarded-for": "1.2.3.4"}));
  if (r.ok) throw new Error(`attested with a guessed secret (${r.status})`);
  return `${r.status} ${(await r.text()).slice(0, 60)}`;
});
await step(C, "compliance direct: a 12 MB body is refused", async () => (compliance ? sane(`${compliance}/v1/compliance/attest`, [400, 403, 413], post(big(12))) : {skip: "no --compliance URL"}));

// =============================================================== R. Router, tokens, faucet by simulation
const G_R = "R · router (simulated)";
const key = process.env.SMOKE_KEY as Hex | undefined;
const me = key ? privateKeyToAccount(key).address : undefined;
let cached: {expiry: bigint; signature: Hex} | undefined;
const attest = async () => {
  if (!key || !me) throw new Error("needs SMOKE_KEY");
  if (!cached || cached.expiry < (await now()) + 600n) cached = await complianceAttestationProvider(`${web}/api/compliance`, key)(me);
  return cached;
};
const who = me ?? probe;
const ownerCalls: [string, readonly unknown[]][] = [
  ["listMarket", [s.stockToken, {wrapper: s.wrapper, vault: s.vault, adapter: s.adapter, params, perAddressCapUsd: 1n, listed: true}]],
  ["delistMarket", [s.stockToken]],
  ["setCapOverride", [probe, s.stockToken, maxUint256]],
  ["setGlobalCap", [maxUint256]],
  ["setAttestationSigner", [probe]],
  ["setSwapTarget", [probe, 1]],
  ["transferOwnership", [probe]],
  ["upgradeToAndCall", [probe, "0x"]],
];
for (const [fn, a] of ownerCalls) await step(G_R, `router.${fn} from a stranger → NotOwner`, async () => refuses(stocklineRouterAbi, R, fn, a, probe, /NotOwner/));
await step(G_R, "clUSDG.mint outside the router → NotRouter (CL-R2)", async () => d.clUSDG ? refuses(collateralTokenAbi, d.clUSDG, "mint", [probe, E6], probe, /NotRouter/) : {skip: "no clUSDG in the book"});
await step(G_R, "clUSDG wallet-to-wallet transfer → TransferNotAllowed (CL-R3)", async () => d.clUSDG ? refuses(collateralTokenAbi, d.clUSDG, "transfer", [probe, 0n], who, /TransferNotAllowed/) : {skip: "no clUSDG in the book"});
await step(G_R, "lend to the zero address is refused (shares would be lost)", async () => refuses(stocklineRouterAbi, R, "lend", [s.stockToken, E18 / 100n, 0n, ZERO, await deadline()], who, /./));
await step(G_R, "lend more than the balance → ERC20InsufficientBalance", async () => refuses(stocklineRouterAbi, R, "lend", [s.stockToken, 10n ** 30n, 0n, who, await deadline()], who, /ERC20InsufficientBalance|ERC20InsufficientAllowance|balance is too low|transfer/i));
await step(G_R, "lend with minShares above the preview → InsufficientOutput", async () => (me ? refuses(stocklineRouterAbi, R, "lend", [s.stockToken, E18 / 100n, 10n ** 40n, me, await deadline()], me, /InsufficientOutput/) : {skip: "needs SMOKE_KEY"}));
await step(G_R, "withdrawLend to the zero address is refused", async () => refuses(stocklineRouterAbi, R, "withdrawLend", [s.stockToken, 1n, 0n, ZERO, await deadline()], who, /./));
await step(G_R, "withdrawLend 0 shares does not move funds", async () => {
  const r = await revertOf(stocklineRouterAbi, R, "withdrawLend", [s.stockToken, 0n, 0n, who, await deadline()], who);
  return r ? `reverts: ${r.name || r.text.slice(0, 60)}` : "no-op (0 assets)";
});
await step(G_R, "repay with both assets and shares, or neither → ZeroAmount", async () => {
  await refuses(stocklineRouterAbi, R, "repay", [s.stockToken, 1n, 1n, who, await deadline()], who, /ZeroAmount/);
  return refuses(stocklineRouterAbi, R, "repay", [s.stockToken, 0n, 0n, who, await deadline()], who, /ZeroAmount/);
});
await step(G_R, "withdrawCollateral(all) with no collateral → ZeroAmount", async () => refuses(stocklineRouterAbi, R, "withdrawCollateral", [s.stockToken, maxUint256, who, await deadline()], who, /ZeroAmount/));
await step(G_R, "addCollateral 0 → ZeroAmount; for a wallet with no debt → NoDebtPosition", async () => {
  await refuses(stocklineRouterAbi, R, "addCollateral", [s.stockToken, 0n, who, await deadline()], who, /ZeroAmount/);
  return refuses(stocklineRouterAbi, R, "addCollateral", [s.stockToken, E6, probe, await deadline()], who, /NoDebtPosition/);
});
await step(G_R, "a real attestation with its expiry moved by 1 s → BadAttestation", async () => {
  if (!me) return {skip: "needs SMOKE_KEY"};
  const a = await attest();
  return refuses(stocklineRouterAbi, R, "borrow", [s.stockToken, 100n * E6, E18 / 1000n, me, {...a, expiry: a.expiry + 1n}, await deadline()], me, /BadAttestation/);
});
await step(G_R, "a real attestation after its expiry → BadAttestation (block time override)", async () => {
  if (!me) return {skip: "needs SMOKE_KEY"};
  const a = await attest();
  try {
    await client.call({account: me, to: R, data: encodeFunctionData({abi: stocklineRouterAbi, functionName: "borrow", args: [s.stockToken, 100n * E6, E18 / 1000n, me, a, a.expiry + 3600n]}), blockOverrides: {time: a.expiry + 1n}} as never);
  } catch (e) {
    const m = String((e as Error).message);
    if (/0x8baa579f|BadAttestation/i.test(m)) return "reverted: BadAttestation";
    if (/blockOverrides|not supported|invalid|unknown field/i.test(m) && !/revert/i.test(m)) return {skip: `the RPC has no block overrides (${m.split("\n")[0].slice(0, 60)})`};
    return `reverted: ${m.split("\n")[0].slice(0, 80)}`;
  }
  throw new Error("an expired attestation passed the router");
});
await step(G_R, "borrow 0 against collateral (a collateral-only entry) is refused (RT-R8)", async () => {
  if (!me) return {skip: "needs SMOKE_KEY"};
  return refuses(stocklineRouterAbi, R, "borrow", [s.stockToken, 100n * E6, 0n, me, await attest(), await deadline()], me, /./);
});
await step(G_R, "borrow to the zero address is refused", async () => {
  if (!me) return {skip: "needs SMOKE_KEY"};
  return refuses(stocklineRouterAbi, R, "borrow", [s.stockToken, 100n * E6, E18 / 1000n, ZERO, await attest(), await deadline()], me, /./);
});
await step(G_R, "openShort selling more than it borrowed → InsufficientOutput", async () => {
  if (!me) return {skip: "needs SMOKE_KEY"};
  const swap = mockAggregatorSwap(d.mocks!.swapAggregator, s.stockToken, d.usdg, E18, 0n, R);
  return refuses(stocklineRouterAbi, R, "openShort", [s.stockToken, 500n * E6, E18 / 100n, swap, false, me, await attest(), await deadline()], me, /InsufficientOutput|insufficient liquidity/);
});
await step(G_R, "openShort with Morpho or clUSDG as the swap target → SwapTargetNotAllowed (RT-R3)", async () => {
  if (!me) return {skip: "needs SMOKE_KEY"};
  const a = await attest();
  await refuses(stocklineRouterAbi, R, "openShort", [s.stockToken, 500n * E6, E18 / 1000n, {target: d.morpho, data: "0x", amountIn: E18 / 1000n, minOut: 0n}, false, me, a, await deadline()], me, /SwapTargetNotAllowed|insufficient liquidity/);
  return refuses(stocklineRouterAbi, R, "openShort", [s.stockToken, 500n * E6, E18 / 1000n, {target: d.usdg, data: encodeFunctionData({abi: erc20Abi, functionName: "transfer", args: [probe, 1n]}), amountIn: E18 / 1000n, minOut: 0n}, false, me, a, await deadline()], me, /SwapTargetNotAllowed|insufficient liquidity/);
});
await step(G_R, "faucet: a second claim inside 24h → TooSoon (decoded)", async () => (me && d.mocks?.faucet ? refuses(faucetAbi, d.mocks.faucet, "claim", [me], me, /TooSoon/) : {skip: "needs SMOKE_KEY and a faucet"}));
await step(G_R, "faucet: anyone can claim for any fresh address (sybil, testnet only)", async () => {
  if (!d.mocks?.faucet) return {skip: "no faucet"};
  const r = await revertOf(faucetAbi, d.mocks.faucet, "claim", [privateKeyToAccount(generatePrivateKey()).address], probe);
  return r ? `refused: ${r.name}` : "allowed: one wallet can drip for unlimited fresh addresses (mock tokens only; P3)";
});
if (d.dnVault) {
  const v = d.dnVault;
  await step(G_R, "vault: requestRedeem 0 → ZeroAmount; to the zero address → ZeroAddress; for someone else without allowance → refused", async () => {
    await refuses(deltaNeutralVaultAbi, v.vault, "requestRedeem", [0n, who, who], who, /ZeroAmount/);
    await refuses(deltaNeutralVaultAbi, v.vault, "requestRedeem", [1n, ZERO, who], who, /ZeroAddress/);
    return refuses(deltaNeutralVaultAbi, v.vault, "requestRedeem", [1n, probe, me ?? d.router!], probe, /ERC20InsufficientAllowance/);
  });
  await step(G_R, "vault: a dust deposit (1 USDG unit) mints shares or reverts ZeroAmount, never 0 shares for your USDG", async () => {
    if (!me) return {skip: "needs SMOKE_KEY"};
    const r = await client.simulateContract({address: v.vault, abi: deltaNeutralVaultAbi, functionName: "deposit", args: [1n, me, await attest()], account: me}).then((x) => x.result as bigint).catch((e: Error) => e);
    if (r instanceof Error) {
      if (/ZeroAmount|MarketClosed|NavStale/.test(r.message)) return `reverted: ${r.message.split("\n")[0].slice(0, 60)}`;
      throw r;
    }
    if (r === 0n) throw new Error("1 unit of USDG would mint 0 shares");
    return `1 unit → ${r} shares`;
  });
  await step(G_R, "vault: deposit to the zero address is refused", async () => {
    if (!me) return {skip: "needs SMOKE_KEY"};
    return refuses(deltaNeutralVaultAbi, v.vault, "deposit", [10n * E6, ZERO, await attest()], me, /./);
  });
  await step(G_R, "vault: guardian and fee setters from a stranger are refused", async () => {
    const out = [];
    for (const [fn, a] of [["setDepositsPaused", [true]], ["setTotalCap", [maxUint256]], ["setBufferBps", [0n]], ["setFeeRecipient", [probe]]] as const) {
      const r = await revertOf(deltaNeutralVaultAbi, v.vault, fn, a, probe).catch(() => ({name: "no such function", args: [], text: ""}));
      if (!r) throw new Error(`${fn} succeeded from a stranger`);
      out.push(`${fn}: ${r.name || "reverts"}`);
    }
    return out.join(", ");
  });
}

// =============================================================== X. Bypasses with real transactions
const X = "X · bypass (real txs)";
if (has("flows")) {
  if (!key || !me) throw new Error("--flows needs SMOKE_KEY (env)");
  if (chainId === 46630 && process.env.TESTNET_GO !== "yes") throw new Error("TESTNET_GO=yes is required to send on testnet");
  const a = await connectWallet(rpc, key);
  const drv = new ChainDriver(a, {log: () => {}, attestationProvider: async () => attest(), mint: false});
  await drv.syncPrices();
  const bal = (token: `0x${string}`, w: `0x${string}` = me) => client.readContract({address: token, abi: erc20Abi, functionName: "balanceOf", args: [w]});
  const pos = (w: `0x${string}`) => client.readContract({address: d.morpho, abi: morphoAbi, functionName: "position", args: [s.marketId, w]});
  const send = (to: `0x${string}`, abi: readonly unknown[], fn: string, args: readonly unknown[]) => a.send(me, to, encodeFunctionData({abi, functionName: fn, args} as never));
  const price = () => client.readContract({address: s.oracle, abi: stocklineOracleAbi, functionName: "price"});
  let lent = false;
  let borrowed = false;
  const ghostKey = generatePrivateKey();
  const ghost = privateKeyToAccount(ghostKey).address; // never signed the terms, never attested
  let ghostDebt = false;

  await step(X, `setup: lend 1 ${T} and wait for the allocator to supply the market`, async () => {
    if (!open) return {skip: "feed session closed"};
    const r = await drv.lend(T, me, E18);
    lent = true;
    await waitForLiquidity(drv, T, E18 / 2n, () => {}, 180_000);
    return `lent in ${r.transactionHash}`;
  });
  await step(X, "setup: an attested borrow at Morpho health 1.6 (router HF at t+24h ≥ 1.1)", async () => {
    if (!lent) return {skip: "no liquidity"};
    const collateral = 200n * E6;
    const amount = (((collateral * (await price())) / 10n ** 36n) * params.lltv * 10n) / (E18 * 16n);
    const r = await drv.borrow(T, me, collateral, amount);
    borrowed = true;
    const hf = await client.readContract({address: R, abi: stocklineRouterAbi, functionName: "healthFactorAt", args: [s.stockToken, me, (await now()) + 86_400n]});
    return `borrowed ${Number(amount) / 1e18} ${T} in ${r.transactionHash}; HF at t+24h ${(Number(hf) / 1e18).toFixed(3)}`;
  });
  await step(X, "residual (e): router.withdrawCollateral with debt can go below the 24h buffer, down to Morpho's LLTV (05 §1 (e); the app only offers it with no debt)", async () => {
    if (!borrowed) return {skip: "no position"};
    const p = await pos(me);
    const debt = await drv.debtOf(T, me);
    // Leave collateral for Morpho health 1.03 at today's price: Morpho accepts it; the 24h buffer does not.
    const keep = (debt * 10n ** 36n * E18 * 103n) / ((await price()) * params.lltv * 100n) + 1n;
    const amount = p.collateral - keep;
    const r = await revertOf(stocklineRouterAbi, R, "withdrawCollateral", [s.stockToken, amount, me, await deadline()], me);
    if (r) return `refused: ${r.name === "Error" ? String(r.args[0]) : r.name} (residual (e) closed)`;
    return `RESIDUAL (e) confirmed: withdrawing ${Number(amount) / 1e6} of ${Number(p.collateral) / 1e6} USDG would leave Morpho HF 1.03 (HF at t+24h < 1.1); simulated only`;
  });
  await step(X, "residual (d): an attested wallet hands clUSDG to a never-attested wallet through Morpho", async () => {
    if (!borrowed) return {skip: "no position"};
    const gift = 20n * E6;
    await send(d.morpho, morphoAbi, "withdrawCollateral", [params, gift, me, me]);
    const cl = await bal(d.clUSDG!);
    await send(d.clUSDG!, erc20Abi, "approve", [d.morpho, gift]);
    const r = await send(d.morpho, morphoAbi, "supplyCollateral", [params, gift, ghost, "0x"]);
    const g = await pos(ghost);
    if (g.collateral !== gift) throw new Error(`ghost collateral ${g.collateral}`);
    return `withdrew ${Number(cl) / 1e6} clUSDG from Morpho and supplied it for ${ghost} in ${r.transactionHash}`;
  });
  let borrowBlock = 0n;
  await step(X, "residual (d): the never-attested wallet borrows on Morpho directly (no terms, no attestation, no cap; 05 §1 (d))", async () => {
    if ((await pos(ghost)).collateral === 0n) return {skip: "no gifted collateral"};
    await a.wallet.sendTransaction({account: a.wallet.account!, to: ghost, value: parseEther("0.0003"), chain: a.wallet.chain});
    const g = await connectWallet(rpc, ghostKey);
    const amount = E18 / 1000n;
    const r = await g.send(ghost, d.morpho, encodeFunctionData({abi: morphoAbi, functionName: "borrow", args: [params, amount, 0n, ghost, ghost]}));
    ghostDebt = true;
    borrowBlock = r.blockNumber;
    return `RESIDUAL (d) confirmed: a wallet that never passed compliance borrowed ${Number(amount) / 1e18} w${T} in ${r.transactionHash}; detection below`;
  });
  await step(X, "the monitor pages DIRECT_BORROW for that borrow (MON-R10)", async () => {
    if (!ghostDebt) return {skip: "no direct borrow"};
    if (!monitor) return {skip: "no --monitor URL"};
    for (let i = 0; i < 60; i++) {
      const j = (await (await get(`${monitor}/incidents`)).json()) as {open?: {rule: string; subject: string}[]};
      const hit = j.open?.find((x) => x.rule === "DIRECT_BORROW" && x.subject.includes(ghost.toLowerCase()));
      if (hit) return `paged: ${hit.subject}`;
      await new Promise((r) => setTimeout(r, 5000));
    }
    throw new Error(`no DIRECT_BORROW incident for ${ghost} within 5 min of block ${borrowBlock}`);
  });
  await step(X, "unwind: repay the ghost's debt through the router (anyone may repay anyone), its collateral back to USDG", async () => {
    if (!ghostDebt) return {skip: "nothing to unwind"};
    await send(s.stockToken, erc20Abi, "approve", [R, maxUint256]);
    await send(R, stocklineRouterAbi, "repay", [s.stockToken, 0n, maxUint256, ghost, await deadline()]);
    const g = await connectWallet(rpc, ghostKey);
    const c = (await pos(ghost)).collateral;
    await g.send(ghost, d.morpho, encodeFunctionData({abi: morphoAbi, functionName: "withdrawCollateral", args: [params, c, ghost, ghost]}));
    const r = await g.send(ghost, d.clUSDG!, encodeFunctionData({abi: collateralTokenAbi, functionName: "unwrap", args: [c, me]}));
    return `ghost debt 0, ${Number(c) / 1e6} clUSDG unwrapped to USDG for the tester in ${r.transactionHash}`;
  });
  await step(X, "rescue top-up by a third party for a position with debt (RT-R8: anyone may top up anyone)", async () => {
    if (!borrowed) return {skip: "no position"};
    const before = (await pos(me)).collateral;
    await drv.addCollateral(T, me, 5n * E6);
    return `collateral ${Number(before) / 1e6} → ${Number((await pos(me)).collateral) / 1e6} USDG`;
  });
  await step(X, "repay more than the debt refunds the excess (RT-R4)", async () => {
    if (!borrowed) return {skip: "no position"};
    const debt = await drv.debtOf(T, me);
    const before = await bal(s.stockToken);
    await send(s.stockToken, erc20Abi, "approve", [R, maxUint256]);
    await send(R, stocklineRouterAbi, "repay", [s.stockToken, 0n, maxUint256, me, await deadline()]);
    const spent = before - (await bal(s.stockToken));
    if ((await pos(me)).borrowShares !== 0n) throw new Error("debt left after repay(all)");
    if (spent > debt + debt / 1000n + 2n) throw new Error(`spent ${spent} for a debt of ${debt}`);
    return `debt ${Number(debt) / 1e18}, spent ${Number(spent) / 1e18}`;
  });
  await step(X, "unwind: withdraw all collateral and the lend", async () => {
    if (!lent) return {skip: "nothing lent"};
    if ((await pos(me)).collateral > 0n) await send(R, stocklineRouterAbi, "withdrawCollateral", [s.stockToken, maxUint256, me, await deadline()]);
    const r = await drv.withdrawLend(T, me);
    return `withdrawn in ${r.transactionHash}`;
  });
  if (d.dnVault) {
    const v = d.dnVault;
    const rdv = <U,>(fn: string, args: readonly unknown[] = []) => (client.readContract as (p: unknown) => Promise<U>)({address: v.vault, abi: deltaNeutralVaultAbi, functionName: fn, args});
    await step(X, "vault: a 1-share withdrawal request goes through the queue and claims 0 without breaking the API", async () => {
      if (!open) return {skip: "feed session closed"};
      if ((await bal(v.vault)) === 0n) return {skip: "no shares"};
      await send(v.vault, deltaNeutralVaultAbi, "requestRedeem", [1n, me, me]);
      const [, tail] = await rdv<readonly [bigint, bigint]>("queueBounds");
      const id = tail - 1n;
      await send(v.vault, deltaNeutralVaultAbi, "settle", [20n]).catch(() => undefined);
      if ((await rdv<{status: number}>("request", [id])).status !== 2) return {skip: `request ${id} still queued behind the head`};
      const r = await send(v.vault, deltaNeutralVaultAbi, "claim", [id]);
      await refuses(deltaNeutralVaultAbi, v.vault, "claim", [id], me, /NotClaimable/);
      for (let i = 0; i < 60; i++) {
        const j = (await (await get(`${api}/v1/vault/account/${me}`, K())).json()) as {data?: {requests?: {id: string; status: string}[]}};
        const st = j.data?.requests?.find((x) => x.id === String(id))?.status;
        if (st === "claimed") return `request ${id} claimed (${r.transactionHash}); a second claim → NotClaimable; API: claimed`;
        await new Promise((res) => setTimeout(res, 3000));
      }
      throw new Error(`API never showed request ${id} as claimed`);
    });
  }
}

// =============================================================== S. Invariants
const S = "S · invariants";
await step(S, "the router holds no tokens between transactions", async () => {
  const toks: [string, `0x${string}`][] = [["USDG", d.usdg], ...Object.entries(d.stocks).flatMap(([t, x]) => [[t, x.stockToken], [`w${t}`, x.wrapper]] as [string, `0x${string}`][])];
  if (d.clUSDG) toks.push(["clUSDG", d.clUSDG]);
  const held = [];
  for (const [n, t] of toks) {
    const b = await client.readContract({address: t, abi: erc20Abi, functionName: "balanceOf", args: [R]});
    if (b > 0n) held.push(`${n} ${b}`);
  }
  if (held.length) throw new Error(`router holds ${held.join(", ")}`);
  return `${toks.length} tokens, all 0`;
});
await step(S, "clUSDG backing ≥ supply (CL-R6); each wrapper's backing ≥ supply", async () => {
  const out = [];
  if (d.clUSDG) {
    const [sup, back] = await Promise.all([client.readContract({address: d.clUSDG, abi: erc20Abi, functionName: "totalSupply"}), client.readContract({address: d.usdg, abi: erc20Abi, functionName: "balanceOf", args: [d.clUSDG]})]);
    if (back < sup) throw new Error(`clUSDG backing ${back} < supply ${sup}`);
    out.push(`clUSDG ${Number(sup) / 1e6}`);
  }
  for (const [t, x] of Object.entries(d.stocks)) {
    const sf = await client.readContract({address: x.wrapper, abi: stockWrapperAbi, functionName: "backingShortfall"}).catch(() => undefined);
    if (sf !== undefined && sf > 0n) throw new Error(`${t} wrapper shortfall ${sf}`);
    out.push(`${t} ok`);
  }
  return out.join(", ");
});
await step(S, "API positions equal Morpho at the API's block", async () => {
  if (!me) return {skip: "needs SMOKE_KEY"};
  await new Promise((r) => setTimeout(r, 8000));
  const j = (await (await status(`${api}/v1/positions/${me}`, 200, K())).json()) as {asOfBlock: string; data: {symbol?: string; collateral?: string; borrowShares?: string}[]};
  const out = [];
  for (const [t, x] of Object.entries(d.stocks)) {
    const p = await client.readContract({address: d.morpho, abi: morphoAbi, functionName: "position", args: [x.marketId, me], blockNumber: BigInt(j.asOfBlock)});
    const a = j.data.find((y) => y.symbol === t);
    if ((p.borrowShares > 0n || p.collateral > 0n) && !a) throw new Error(`${t}: chain has a position, API has none`);
    if (a && p.borrowShares === 0n && p.collateral === 0n) throw new Error(`${t}: API shows a position the chain doesn't have`);
    out.push(`${t} ${p.collateral}/${p.borrowShares}`);
  }
  return `at ${j.asOfBlock}: ${out.join(", ")}`;
});

// =============================================================== Z. Abuse (last: spends rate-limit budget)
const Z = "Z · abuse";
await step(Z, "API burst without a key: 429 with Retry-After after the free budget (SI-R10), keyed still served", async () => {
  const codes = await Promise.all(Array.from({length: 90}, () => get(`${api}/v1/markets`).then((r) => ({s: r.status, ra: r.headers.get("retry-after")}))));
  const n429 = codes.filter((c) => c.s === 429);
  if (codes.some((c) => c.s >= 500)) throw new Error("5xx under burst");
  if (!n429.length) throw new Error("90 requests, no 429: the free tier is not limited");
  if (!n429[0].ra) throw new Error("429 without Retry-After");
  const keyed = apiKey ? (await get(`${api}/v1/markets`, K())).status : 0;
  if (apiKey && keyed !== 200) throw new Error(`keyed request → ${keyed} while the free tier is exhausted`);
  return `${n429.length}/90 limited, Retry-After ${n429[0].ra}s; keyed → ${keyed || "no key"}`;
});
await step(Z, "pages keep rendering real data while this IP's API budget is exhausted (server-side calls share the web server's IP)", async () => {
  const pages = await Promise.all(Array.from({length: 24}, (_, i) => get(`${web}${["/markets", `/stock/${T}`, "/data", "/vault"][i % 4]}`).then(async (r) => ({s: r.status, b: await r.text()}))));
  const bad = pages.filter((p) => p.s >= 500);
  if (bad.length) throw new Error(`${bad.length}/24 pages → 5xx`);
  const noData = pages.filter((p) => /rate limit exceeded/i.test(p.b)).length;
  if (noData) throw new Error(`${noData}/24 pages show the API's rate-limit error`);
  return "24/24 rendered";
});
await step(Z, "compliance attestation flood for one fresh wallet → 429 (per-wallet / per-IP limit)", async () => {
  const w = privateKeyToAccount(generatePrivateKey()).address;
  const codes = await Promise.all(Array.from({length: 25}, () => get(`${web}/api/compliance/attest`, post(JSON.stringify({address: w}))).then((r) => r.status)));
  if (codes.some((c) => c >= 500)) throw new Error(`5xx: ${codes.join(",")}`);
  const n = codes.filter((c) => c === 429).length;
  if (!n) throw new Error(`25 attest requests, no 429 (${[...new Set(codes)].join(",")})`);
  // Leave the stack as found: the per-IP window is 60 s, and the next run's malformed-body checks would read 429.
  await new Promise((r) => setTimeout(r, 61_000));
  return `${n}/25 → 429 (others ${[...new Set(codes.filter((c) => c !== 429))].join(",")}); waited out the 60 s window`;
});

const c = counts();
const md = `# Break-the-product run on chain ${chainId}

Run ${new Date().toISOString()} by \`web/scripts/testnetBreak.ts\` (${c.seconds} s): web ${web}, API ${api}${compliance ? `, compliance ${compliance}` : ""}${monitor ? `, monitor ${monitor}` : ""}.
Feed session ${open ? "open" : "closed"}. ${has("flows") ? "With real bypass transactions (tester key)." : "Simulations and HTTP only."}
**${c.failed === 0 ? "Nothing broke" : `${c.failed} check(s) failed`}** (${c.ok} ok, ${c.skipped} skipped).

${table()}
`;
if (arg("report")) writeFileSync(arg("report"), md);
console.log(md);
process.exit(c.failed === 0 ? 0 : 1);
