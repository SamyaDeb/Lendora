/**
 * Part C step 4 (the successor of testnetDryRun.ts for a running stack): smoke every feature of a deployed stack through
 * its public surfaces, the way a tester would reach them. Works against the hosted testnet or any local stack.
 *
 * Read-only by default: API routes (status, markets, history, events, positions, protocol revenue, terms, receipt
 * markets, USDG Earn, OpenAPI), every app page, the geo-block rewrite (with the platform's test header), compliance and
 * monitor health (a real sanctions provider off anvil; the weekend log). `--flows` also sends the user flows with
 * `SMOKE_KEY` (env only): faucet → lend, short, rescue top-up, repay, close, borrow, withdraw (terms signed and
 * attested through compliance) and the USDG Earn deposit / instant withdrawal / queued request / settle / claim (when
 * the vault's cap is above 0). On 46630 sending needs `TESTNET_GO=yes`; 4663 is refused.
 *
 *   pnpm --filter @lendora/web exec tsx scripts/testnetSmoke.ts --web URL --api URL --compliance URL --rpc URL \
 *     [--monitor URL] [--geo-header x-vercel-ip-country=US] [--flows] [--report ../docs/runbooks/testnet-smoke.md]
 */
import {writeFileSync} from "node:fs";
import {createPublicClient, http, type Hex} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {getDeployment} from "@lendora/sdk";
import {ChainDriver, complianceAttestationProvider, connectWallet, smokeFlows, vaultSmoke} from "@lendora/devnet";

const arg = (n: string, d = "") => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const has = (n: string) => process.argv.includes(`--${n}`);
const web = arg("web").replace(/\/$/, "");
const api = arg("api").replace(/\/$/, "");
const compliance = arg("compliance").replace(/\/$/, "");
const monitor = arg("monitor").replace(/\/$/, "");
const rpc = arg("rpc");
const reportPath = arg("report");
const [geoName, geoValue] = arg("geo-header", "x-vercel-ip-country=US").split("=");
if (!web || !api || !rpc) throw new Error("--web, --api and --rpc are required");

type Row = {area: string; check: string; ok: boolean | "skip"; detail: string};
const rows: Row[] = [];
const t0 = Date.now();
const log = (m: string) => console.log(`[smoke] ${m}`);
async function check(area: string, name: string, f: () => Promise<string | {skip: string}>) {
  try {
    const r = await f();
    const skip = typeof r === "object";
    rows.push({area, check: name, ok: skip ? "skip" : true, detail: skip ? r.skip : r});
    log(`${skip ? "SKIP" : "ok  "} ${area} · ${name} · ${skip ? r.skip : r}`);
  } catch (e) {
    const detail = (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 200);
    rows.push({area, check: name, ok: false, detail});
    log(`FAIL ${area} · ${name} · ${detail}`);
  }
}
async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, {...init, signal: AbortSignal.timeout(20_000)});
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return (await r.json()) as T;
}
/** A page: 200 after same-origin redirects only (legacy routes redirect to their canonical page). */
async function getPage(path: string, headers: Record<string, string> = {}): Promise<{html: string; at: string}> {
  let url = `${web}${path}`;
  for (let hop = 0; hop < 5; hop++) {
    const r = await fetch(url, {headers, redirect: "manual", signal: AbortSignal.timeout(60_000)});
    if (r.status >= 300 && r.status < 400) {
      const next = new URL(r.headers.get("location") ?? "", url);
      if (next.origin !== new URL(web).origin) throw new Error(`${path} redirects off-site to ${next.origin}`);
      url = next.toString();
      continue;
    }
    if (r.status !== 200) throw new Error(`${r.status} ${path}`);
    return {html: await r.text(), at: url.slice(web.length)};
  }
  throw new Error(`${path}: too many redirects`);
}

const client = createPublicClient({transport: http(rpc)});
const chainId = await client.getChainId();
if (chainId === 4663 && has("flows")) throw new Error("refusing to send on Robinhood Chain mainnet (4663): the mainnet smoke is read-only");
const d = getDeployment(chainId);
if (!d) throw new Error(`no deployment for chain ${chainId} in addresses.json`);
const ticker = Object.keys(d.stocks).includes("NVDA") ? "NVDA" : Object.keys(d.stocks)[0];
log(`chain ${chainId}, web ${web}, api ${api}`);

// ---- API
await check("API", "/v1/status: indexer caught up", async () => {
  const s = await getJson<{data: {indexer: {lagBlocks: number}; markets: {symbol: string; marketStatus: string}[]}}>(`${api}/v1/status`);
  if (s.data.indexer.lagBlocks > 50) throw new Error(`indexer lag ${s.data.indexer.lagBlocks} blocks`);
  return `lag ${s.data.indexer.lagBlocks}; ${s.data.markets.map((m) => `${m.symbol} ${m.marketStatus}`).join(", ")}`;
});
await check("API", "/v1/markets (lend, borrow, short-interest data)", async () => {
  const m = await getJson<{data: {symbol: string}[]}>(`${api}/v1/markets`);
  if (m.data.length !== Object.keys(d.stocks).length) throw new Error(`${m.data.length} markets, book has ${Object.keys(d.stocks).length}`);
  return m.data.map((x) => x.symbol).join(", ");
});
for (const p of [`/v1/markets/${ticker}`, `/v1/markets/${ticker}/history`, `/v1/markets/${ticker}/events`, `/v1/positions/0x0000000000000000000000000000000000000001`, "/v1/protocol/revenue", "/v1/terms", "/v1/receipt-markets"]) {
  await check("API", p, async () => {
    const j = await getJson<{asOfBlock?: string}>(`${api}${p}`);
    return `200${j.asOfBlock ? ` at block ${j.asOfBlock}` : ""}`;
  });
}
await check("API", "/v1/vault/overview (USDG Earn)", async () => {
  if (!d.dnVault) return {skip: "no dnVault in the address book for this chain"};
  const o = await getJson<{data: {tvl: string; cap: string; depositsOpen: boolean; nav: {stale: boolean}}}>(`${api}/v1/vault/overview`);
  return `tvl ${o.data.tvl}, cap ${o.data.cap}, deposits ${o.data.depositsOpen ? "open" : "closed"}, NAV ${o.data.nav.stale ? "stale" : "fresh"}`;
});
await check("API", "/v1/openapi.json lists every route", async () => {
  const s = await getJson<{paths: Record<string, unknown>}>(`${api}/v1/openapi.json`);
  const need = ["/v1/status", "/v1/markets", "/v1/protocol/revenue", "/v1/vault/overview", "/v1/receipt-markets"];
  const missing = need.filter((x) => !(x in s.paths));
  if (missing.length) throw new Error(`missing ${missing.join(", ")}`);
  return `${Object.keys(s.paths).length} paths`;
});

// ---- Web (server-rendered pages: 200 and the app shell)
// Canonical pages and the legacy routes that redirect to them (/market, /lend, /short → /stock; /short-interest → /data).
// /backstop is a flagged Phase 5 preview (NEXT_PUBLIC_FEATURE_BACKSTOP), not part of the smoke.
const pages = ["/", "/markets", `/stock/${ticker}`, `/stock/${ticker}?tab=lend`, `/stock/${ticker}?tab=short`, `/market/${ticker}`, "/portfolio", "/data", "/short-interest", "/vault", "/alerts", "/terms", "/status", "/restricted"];
for (const p of pages)
  await check("Web", `GET ${p}`, async () => {
    const r = await getPage(p);
    return `${r.html.length} bytes${r.at !== p ? ` (→ ${r.at})` : ""}`;
  });
await check("Web", `geo-block: ${geoName}=${geoValue} on /markets renders the restricted page (APP-R2)`, async () => {
  const {html} = await getPage("/markets", {[geoName]: geoValue});
  if (!/not available in your region/i.test(html)) throw new Error("no restricted page: GEO_PLATFORM header name, or the country is allowed?");
  return "rewritten to /restricted";
});
await check("Web", "compliance proxy: terms text through /api/compliance", async () => {
  const t = await getJson<{version: string}>(`${web}/api/compliance/terms?address=0x0000000000000000000000000000000000000001`);
  return `terms ${t.version}`;
});

// ---- Services
await check("Compliance", "/health: signer and sanctions provider", async () => {
  if (!compliance) return {skip: "no --compliance URL (private service): checked through the web proxy above"};
  const h = await getJson<{ok: boolean; signer: string; sanctions: string}>(`${compliance}/health`);
  if (chainId === 4663 && /static|none|mock|deny/i.test(h.sanctions)) throw new Error(`sanctions provider ${h.sanctions} on mainnet`);
  return `signer ${h.signer}, sanctions ${h.sanctions}`;
});
await check("Monitor", "/health and GET /weekends (weekend log accrues)", async () => {
  if (!monitor) return {skip: "no --monitor URL"};
  await getJson(`${monitor}/health`);
  const w = await getJson<{data?: unknown[]; closures?: unknown[]}>(`${monitor}/weekends`);
  return `${(w.data ?? w.closures ?? []).length} closure(s) logged`;
});

// ---- Flows
if (has("flows")) {
  const key = process.env.SMOKE_KEY as Hex | undefined;
  if (!key) throw new Error("--flows needs SMOKE_KEY (env)");
  if (chainId === 46630 && process.env.TESTNET_GO !== "yes") throw new Error("TESTNET_GO=yes is required to send on testnet");
  const a = await connectWallet(rpc, key);
  const me = privateKeyToAccount(key).address;
  const attest = complianceAttestationProvider(`${web}/api/compliance`, key, {[geoName]: "DE"});
  const drv = new ChainDriver(a, {log: () => {}, attestationProvider: attest, mint: false}); // the wallet's own balances
  await check("Flows", "terms signed + attestation through the web's compliance proxy", async () => {
    const att = await attest(me);
    return `expiry ${new Date(Number(att.expiry) * 1000).toISOString()}`;
  });
  await check("Flows", "lend, short, rescue top-up, repay, close, borrow, withdraw (05 §4)", async () => {
    await drv.syncPrices(); // swap minimums from the chain's own feed prices
    const ev = await smokeFlows(drv, me, () => {}, {allocate: false});
    return `${ev.length} txs: ${[...new Set(ev.map((e) => e.kind))].join(", ")}`;
  });
  await check("Flows", "USDG Earn: deposit, instant withdrawal, queued request, settle, claim", async () => {
    const r = await vaultSmoke(a, d, me, attest);
    if (r.length === 1 && r[0].kind === "skip") return {skip: r[0].note};
    return r.map((x) => `${x.kind}${x.hash ? "" : ` (${x.note})`}`).join(" → ");
  });
  await check("API", "the smoke wallet's position is indexed", async () => {
    await new Promise((res) => setTimeout(res, 5000));
    const p = await getJson<{data: unknown}>(`${api}/v1/positions/${me}`);
    return `${JSON.stringify(p.data).length} bytes`;
  });
}

const failed = rows.filter((r) => r.ok === false).length;
const md = `# Testnet smoke

Run ${new Date().toISOString()} by \`web/scripts/testnetSmoke.ts\` (${Math.round((Date.now() - t0) / 1000)} s) against chain ${chainId}:
web ${web}, API ${api}${compliance ? `, compliance ${compliance}` : ""}${monitor ? `, monitor ${monitor}` : ""}. ${has("flows") ? "With user flows." : "Read-only."}
**${failed === 0 ? "All checks passed" : `${failed} check(s) failed`}** (${rows.filter((r) => r.ok === "skip").length} skipped).

| Area | Check | Result | Detail |
|---|---|---|---|
${rows.map((r) => `| ${r.area} | ${r.check} | ${r.ok === "skip" ? "skip" : r.ok ? "ok" : "**FAIL**"} | ${r.detail.replace(/\|/g, "\\|")} |`).join("\n")}
`;
if (reportPath) writeFileSync(reportPath, md);
console.log(md);
process.exit(failed === 0 ? 0 : 1);
