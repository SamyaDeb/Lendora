import {spawn, type ChildProcess} from "node:child_process";
import {createServer} from "node:net";
import {fileURLToPath} from "node:url";
import {encodeFunctionData} from "viem";
import {generatePrivateKey, privateKeyToAccount} from "viem/accounts";
import {stocklineRouterAbi} from "@stockline/sdk";
import {startStack, type Stack} from "@stockline/api/harness";
import {startCompliance, type RunningCompliance} from "@stockline/compliance/server";
import {serve} from "@hono/node-server";
import pg from "pg";
import {alertsApp, SettingsStore} from "@stockline/keepers/alerts";
import {Health} from "@stockline/keepers/health";

/**
 * The full local product for Playwright and Lighthouse: anvil (DeployLocal) + the devnet seed week + Ponder + Postgres
 * + the public API + the compliance signer (a generated key installed on the router through the impersonated
 * timelock) + a production build of the web app pointed at all of it. Nothing leaves the machine.
 */
export const WEB_DIR = fileURLToPath(new URL("..", import.meta.url));
/** Anvil's default account #7: unlocked on anvil (anvil holds its key), used by the wagmi mock connector. */
export const E2E_ACCOUNT = "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955" as const;

export interface WebStack {
  stack: Stack;
  compliance: RunningCompliance;
  baseUrl: string;
  close(): Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, () => {
      const p = (s.address() as {port: number}).port;
      s.close(() => resolve(p));
    });
  });
}

export async function startWebStack(o: {build?: boolean; log?: (m: string) => void; onEnv?: (env: NodeJS.ProcessEnv) => void; web?: boolean} = {}): Promise<WebStack> {
  const log = o.log ?? console.log;
  const t0 = Date.now();
  log("[e2e] stack: anvil + seed week + indexer + API");
  const stack = await startStack();
  log(`[e2e] stack ready in ${Math.round((Date.now() - t0) / 1000)} s`);
  const signerKey = generatePrivateKey();
  const proxySecret = `e2e-${generatePrivateKey()}`; // CP-R8: web proxy → compliance, as in production
  log("[e2e] compliance signer");
  const compliance = await startCompliance(
    {
      DATABASE_URL: stack.pg.url,
      RPC_URL: stack.anvil.url,
      STOCKLINE_NETWORK: "31337",
      PORT: "0",
      HOST: "127.0.0.1",
      COMPLIANCE_SIGNER_KEY: signerKey,
      COMPLIANCE_SCHEMA: `compliance_e2e_${Date.now()}`,
      DEV_DEFAULT_COUNTRY: "DE",
      TRUST_PROXY: "true",
      PROXY_SECRET: proxySecret,
    } as unknown as NodeJS.ProcessEnv,
    {},
  );
  const owner = await stack.anvil.client.readContract({address: stack.config.d.router!, abi: stocklineRouterAbi, functionName: "owner"});
  await stack.anvil.send(owner, stack.config.d.router!, encodeFunctionData({abi: stocklineRouterAbi, functionName: "setAttestationSigner", args: [privateKeyToAccount(signerKey).address]}));

  // Fund the e2e wallet with Stock Tokens and USDG (mocks), ETH for gas.
  for (const t of ["SPY", "NVDA", "AAPL"]) await stack.drv.mintStock(t, E2E_ACCOUNT, 500n * 10n ** 18n);
  await stack.drv.mintUsdg(E2E_ACCOUNT, 1_000_000n * 10n ** 6n);
  await stack.anvil.test.setBalance({address: E2E_ACCOUNT, value: 10n ** 21n});

  // Alerts settings API (APP-R8) on the same Postgres.
  const alertsPool = new pg.Pool({connectionString: stack.pg.url, max: 3});
  const alertsStore = new SettingsStore(alertsPool, `alerts_e2e_${Date.now()}`);
  await alertsStore.migrate();
  const alertsPort = await freePort();
  const alertsServer = serve({fetch: alertsApp(alertsStore, stack.anvil.client, new Health(60_000), {allowHttpWebhooks: true}).fetch, port: alertsPort, hostname: "127.0.0.1"});

  const env = {
    ...process.env,
    NEXT_TELEMETRY_DISABLED: "1",
    NEXT_PUBLIC_CHAIN_ID: "31337",
    NEXT_PUBLIC_RPC_URL: stack.anvil.url,
    NEXT_PUBLIC_API_URL: stack.api.url,
    NEXT_PUBLIC_E2E: "1",
    NEXT_PUBLIC_E2E_ACCOUNT: E2E_ACCOUNT,
    COMPLIANCE_URL: compliance.url,
    PROXY_SECRET: proxySecret,
    GEO_PLATFORM: "vercel",
    ALERTS_URL: `http://127.0.0.1:${alertsPort}`,
  };
  o.onEnv?.(env);
  if (o.web !== false && o.build !== false) {
    log("[e2e] next build");
    // Async: the API and compliance servers run in this process and must keep answering during the build.
    const code = await new Promise<number | null>((resolve) => spawn("npx", ["next", "build"], {cwd: WEB_DIR, env, stdio: "inherit"}).on("exit", resolve));
    if (code !== 0) throw new Error("next build failed");
  }
  // `web: false`: services only (scripts/liveStack.ts runs `next dev` against them).
  const port = o.web === false ? 0 : await freePort();
  if (port) log(`[e2e] next start on :${port}`);
  const web: ChildProcess | undefined = port ? spawn("npx", ["next", "start", "-p", String(port), "-H", "127.0.0.1"], {cwd: WEB_DIR, env, stdio: "ignore"}) : undefined;
  const baseUrl = port ? `http://127.0.0.1:${port}` : "";
  for (let i = 0; port && i < 300; i++) {
    try {
      if ((await fetch(`${baseUrl}/restricted`)).ok) break;
    } catch {
      /* starting */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return {
    stack,
    compliance,
    baseUrl,
    async close() {
      web?.kill();
      alertsServer.close();
      await alertsPool.end().catch(() => {});
      await compliance.close().catch(() => {});
      await stack.close();
    },
  };
}
