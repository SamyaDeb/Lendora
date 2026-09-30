/**
 * Phase 2 task 7 dry run: the whole testnet stack against an **anvil fork of Robinhood Chain testnet** (nothing is
 * sent to the testnet): DeployTestnet must already have run on the fork (addresses.json["46630"]). Starts Postgres,
 * the indexer (46630), the API, the compliance signer and the feed mirror (reading the real mainnet feeds,
 * read-only), runs the smoke flows with attestations from the compliance service, then checks the 07 acceptance
 * (API = lens at the same block) and the SI-R5 reconciliation. Writes docs/runbooks/testnet-dry-run.md.
 *
 *   anvil --fork-url https://rpc.testnet.chain.robinhood.com --port 18600 &
 *   (DeployTestnet with TESTNET_GO=fork-dry-run)
 *   COMPLIANCE_SIGNER_KEY_FILE=… pnpm --filter @lendora/web exec tsx scripts/testnetDryRun.ts --rpc http://127.0.0.1:18600
 */
import {readFileSync, writeFileSync} from "node:fs";
import {createPublicClient, http, type PublicClient} from "viem";
import {generatePrivateKey, privateKeyToAccount} from "viem/accounts";
import {getDeployment, getExternal, robinhoodChain, shortInterestLensAbi} from "@lendora/sdk";
import {ChainDriver, connectAnvil, smokeFlows, startPostgres} from "@lendora/devnet";
import {startIndexer} from "@lendora/indexer/harness";
import {ConsolePager, reconcile} from "@lendora/indexer/reconcile";
import {startApi} from "@lendora/api/server";
import {startCompliance} from "@lendora/compliance/server";
import {rpcUnlockedSender} from "@lendora/keepers/signer";
import {FeedMirror, ChainlinkSource} from "@lendora/keepers/feed-mirror";
import pg from "pg";

const arg = (n: string, d = "") => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const rpc = arg("rpc", "http://127.0.0.1:18600");
const log = (m: string) => console.log(`[dry-run] ${m}`);
const t0 = Date.now();
const report: string[] = [];

const a = await connectAnvil(rpc);
const chainId = await a.client.getChainId();
if (chainId !== 46630) throw new Error(`expected an anvil fork of 46630, got chain ${chainId}`);
const d = getDeployment(46630)!;
const forkBlock = BigInt(d.startBlock ?? 0);
report.push(`| Fork | anvil fork of 46630 at block ${forkBlock}; DeployTestnet (--slow) on the fork: see the deploy log |`);

const pgs = await startPostgres();
const signerKeyFile = process.env.COMPLIANCE_SIGNER_KEY_FILE;
if (!signerKeyFile) throw new Error("COMPLIANCE_SIGNER_KEY_FILE (the key whose address DeployTestnet installed) is required");
const compliance = await startCompliance({
  DATABASE_URL: pgs.url,
  RPC_URL: rpc,
  LENDORA_NETWORK: "46630",
  PORT: "0",
  HOST: "127.0.0.1",
  COMPLIANCE_SIGNER_KEY_FILE: signerKeyFile,
  COMPLIANCE_SCHEMA: "dry_compliance",
  TRUST_PROXY: "true",
} as unknown as NodeJS.ProcessEnv);
log(`compliance signer ${compliance.svc.signerAddress}`);

// Feed mirror: the real mainnet Chainlink rounds (read-only on 4663) → the fork's mock feeds.
const mainnet = createPublicClient({chain: robinhoodChain, transport: http("https://rpc.mainnet.chain.robinhood.com")}) as PublicClient;
await a.test.impersonateAccount({address: d.roles.guardKeeper});
const mirror = new FeedMirror(a.client, rpcUnlockedSender(a.client, rpc, {...robinhoodChain, id: 46630} as never, d.roles.guardKeeper), d, new ChainlinkSource(mainnet, getExternal(4663)!), undefined, log);
const pushed = await mirror.tick();
report.push(`| Feed mirror | pushed ${pushed.length} mainnet rounds (${pushed.join(", ")}) to the mock feeds and DEX |`);

// Smoke flows by a keyed tester (the key signs the terms; txs are impersonated on the fork).
const tester = privateKeyToAccount(generatePrivateKey());
const provider = async (user: `0x${string}`) => {
  const t = compliance.svc.termsMessageFor(user);
  await compliance.svc.acceptTerms(user, await tester.signMessage({message: t}), JSON.parse(readFileSync(new URL("../../packages/sdk/data/compliance.json", import.meta.url), "utf8")).termsVersion);
  const att = await compliance.svc.attest(user, {country: "DE", region: null}, "192.0.2.1");
  return {expiry: BigInt(att.expiry), signature: att.signature};
};
const drv = new ChainDriver(a, {attestationProvider: provider, log: () => {}});
const smoke = await smokeFlows(drv, tester.address, log);
report.push(`| Smoke flows | ${smoke.length} actions: ${[...new Set(smoke.map((e) => e.kind))].join(", ")} (openShort/borrow attested by the compliance service) |`);

// Indexer + API over the fork.
const tIdx = Date.now();
const idx = await startIndexer({rpcUrl: rpc, databaseUrl: pgs.url, network: "46630", env: {TICK_INTERVAL_BLOCKS: "1", PONDER_POLLING_MS: "200"}, timeoutMs: 900_000});
const head = await a.client.getBlockNumber();
await idx.waitForBlock(head, 300_000);
report.push(`| Indexer | backfill from block ${forkBlock} to ${head}: ${Math.round((Date.now() - tIdx) / 1000)} s (${idx.backfillMs} ms to ready) |`);

const api = await startApi({
  port: 0,
  host: "127.0.0.1",
  databaseUrl: pgs.url,
  indexerSchema: idx.viewsSchema,
  apiSchema: "dry_api",
  rpcUrl: rpc,
  key: 46630,
  chainId: 46630,
  d,
  freeRpm: 1000,
  keyedRpm: 10_000,
  freeWs: 1,
  keyedWs: 10,
  maxKeysPerAddress: 5,
  trustProxy: false,
  trustedProxyHops: 1,
  siweDomain: "localhost",
  streamPollMs: 200,
});
let lensOk = 0;
for (const symbol of Object.keys(d.stocks)) {
  const m = (await (await fetch(`${api.url}/v1/markets/${symbol}`)).json()) as {asOfBlock: string; data: {stockToken: `0x${string}`; raw: Record<string, string | boolean>}};
  const lens = await a.client.readContract({address: d.lens!, abi: shortInterestLensAbi, functionName: "snapshot", args: [m.data.stockToken], blockNumber: BigInt(m.asOfBlock)});
  const same =
    BigInt(m.data.raw.suppliedShares as string) === lens.suppliedShares &&
    BigInt(m.data.raw.borrowedShares as string) === lens.borrowedShares &&
    BigInt(m.data.raw.utilizationWad as string) === lens.utilizationWad &&
    BigInt(m.data.raw.borrowRatePerSecWad as string) === lens.borrowRatePerSecWad &&
    BigInt(m.data.raw.bufferWad as string) === lens.bufferWad &&
    m.data.raw.marketOpen === lens.marketOpen;
  if (same) lensOk++;
  else log(`${symbol}: API ≠ lens at ${m.asOfBlock}: ${JSON.stringify(m.data.raw)} vs ${JSON.stringify(lens, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
}
report.push(`| 07 acceptance | /v1/markets/{symbol} = ShortInterestLens.snapshot() at the same block for ${lensOk}/${Object.keys(d.stocks).length} stocks |`);

const pool = new pg.Pool({connectionString: pgs.url});
const rec = await reconcile({pool, schema: idx.viewsSchema, client: a.client, d, pager: new ConsolePager()});
report.push(`| SI-R5 reconciliation | ${rec.checked} values at block ${rec.block}: ${rec.diffs.length} diffs |`);
const status = (await (await fetch(`${api.url}/v1/status`)).json()) as {data: {indexer: {lagBlocks: number}; markets: {symbol: string; marketStatus: string}[]}};
report.push(`| /v1/status | lag ${status.data.indexer.lagBlocks} blocks; ${status.data.markets.map((m) => `${m.symbol} ${m.marketStatus}`).join(", ")} |`);

await pool.end();
await api.close();
await idx.stop();
await compliance.close();
pgs.stop();

const md = `# Testnet dry run (anvil fork of 46630)

Run on ${new Date().toISOString()} by \`web/scripts/testnetDryRun.ts\` (${Math.round((Date.now() - t0) / 1000)} s). Nothing was sent to the
testnet: the deployment and every transaction ran on a local anvil fork. The real deployment waits for the owner's go.

| Step | Result |
|---|---|
${report.join("\n")}
`;
writeFileSync(new URL("../../docs/runbooks/testnet-dry-run.md", import.meta.url), md);
console.log(md);
process.exit(lensOk === Object.keys(d.stocks).length && rec.diffs.length === 0 ? 0 : 1);
