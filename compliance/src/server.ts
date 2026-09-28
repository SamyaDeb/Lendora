import type {AddressInfo} from "node:net";
import type {Server} from "node:http";
import {serve} from "@hono/node-server";
import pg from "pg";
import {createPublicClient, http, type PublicClient} from "viem";
import {getDeployment, parseDeploymentKey, restrictedListFromEnv, TERMS_VERSION, type Address} from "@stockline/sdk";
import {envKeyTypedDataSigner, remoteTypedDataSigner, type TypedDataSigner} from "@stockline/keepers/signer";
import {createComplianceApp} from "./app.js";
import {StaticRangeReputation, type IpReputation, type SanctionsScreen} from "./checks.js";
import {sanctionsFromEnv, sanctionsProviderOf} from "./sanctions/index.js";
import {ComplianceService, loadTerms, TermsStore} from "./service.js";

export interface RunningCompliance {
  url: string;
  svc: ComplianceService;
  store: TermsStore;
  close(): Promise<void>;
}

export interface ComplianceOverrides {
  signer?: TypedDataSigner;
  sanctions?: SanctionsScreen;
  ipReputation?: IpReputation;
}

/** Signer from env: `COMPLIANCE_SIGNER_KEY` / `COMPLIANCE_SIGNER_KEY_FILE`, or `COMPLIANCE_REMOTE_SIGNER_URL` +
 * `COMPLIANCE_SIGNER_ADDRESS` (KMS/HSM bridge). */
function signerFromEnv(env: NodeJS.ProcessEnv): TypedDataSigner {
  if (env.COMPLIANCE_REMOTE_SIGNER_URL) {
    if (!env.COMPLIANCE_SIGNER_ADDRESS) throw new Error("COMPLIANCE_SIGNER_ADDRESS is required with a remote signer");
    return remoteTypedDataSigner(env.COMPLIANCE_REMOTE_SIGNER_URL, env.COMPLIANCE_SIGNER_ADDRESS as Address, env.COMPLIANCE_REMOTE_SIGNER_AUTH);
  }
  return envKeyTypedDataSigner("COMPLIANCE_SIGNER", env);
}

/** OFF-5: a bounded integer env var; a bad value fails startup with its name (before: `NaN`). */
export function intEnv(env: NodeJS.ProcessEnv, name: string, dflt: number, min: number, max: number): number {
  const v = env[name];
  if (v === undefined || v === "") return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer between ${min} and ${max} (got "${v}")`);
  return n;
}

/** Minimum `PROXY_SECRET` length off anvil (CP-R8). */
export const MIN_PROXY_SECRET = 32;

/**
 * CP-R8 startup rules, before anything else starts. Geo and client-IP headers are trusted only from the web proxy, so
 * every network except local anvil (31337) needs `PROXY_SECRET` (≥ 32 chars, also when set on anvil), and
 * `TRUST_PROXY=true` without it is refused. On mainnet (4663) the deny-list sanctions adapter and a missing
 * `SANCTIONS_API_KEY` are refused: a real provider must be configured (CP-R3, open decision Q5). An unknown
 * `SANCTIONS_PROVIDER` is refused on every network.
 */
export function assertStartupConfig(env: NodeJS.ProcessEnv, raw: string): void {
  const local = raw === "31337";
  const secret = env.PROXY_SECRET ?? "";
  if (!local && secret.length < MIN_PROXY_SECRET) {
    throw new Error(`PROXY_SECRET (>= ${MIN_PROXY_SECRET} chars) is required on network ${raw} (CP-R8): without it anyone could send geo headers`);
  }
  if (!local && env.TRUST_PROXY === "true" && !secret) throw new Error("TRUST_PROXY=true needs PROXY_SECRET (CP-R8)");
  if (secret && secret.length < MIN_PROXY_SECRET) throw new Error(`PROXY_SECRET must be at least ${MIN_PROXY_SECRET} chars (CP-R8)`);
  const provider = sanctionsProviderOf(env); // unknown names are refused everywhere, never a silent deny-list fallback
  if (raw === "4663") {
    if (provider === "deny-list") throw new Error("mainnet (4663) refuses the deny-list sanctions adapter: set SANCTIONS_PROVIDER=chainalysis|trm (CP-R3, CP-R8)");
    if (!env.SANCTIONS_API_KEY) throw new Error(`mainnet (4663) needs SANCTIONS_API_KEY for ${provider} (CP-R3, Q5)`);
    if (env.SANCTIONS_API_URL && !env.SANCTIONS_API_URL.startsWith("https://")) throw new Error("mainnet (4663) needs an https SANCTIONS_API_URL (CP-R3)");
  }
}

export async function startCompliance(env: NodeJS.ProcessEnv = process.env, o: ComplianceOverrides = {}): Promise<RunningCompliance> {
  const raw = env.STOCKLINE_NETWORK ?? env.DEPLOYMENT_KEY ?? "31337";
  assertStartupConfig(env, raw);
  const key = parseDeploymentKey(raw);
  const d = getDeployment(key);
  if (!d?.router) throw new Error(`no router for "${raw}" in @stockline/sdk addresses.json`);
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const sanctions = o.sanctions ?? sanctionsFromEnv(env);
  console.log(`[compliance] network ${raw} · sanctions provider ${sanctions.name ?? "custom"}`); // CP-R3: the provider in the startup log, never the key
  const chainId = key === "fork-4663" ? 4663 : Number(key);
  const client = createPublicClient({transport: http(env.RPC_URL ?? "http://127.0.0.1:8545")}) as PublicClient;
  const pool = new pg.Pool({connectionString: env.DATABASE_URL, max: 5});
  const store = new TermsStore(pool, env.COMPLIANCE_SCHEMA ?? "stockline_compliance");
  await store.migrate();
  const terms = loadTerms(env.TERMS_VERSION ?? TERMS_VERSION);
  const signer = o.signer ?? signerFromEnv(env);
  const svc = new ComplianceService({
    signer,
    client,
    chainId,
    router: d.router,
    restricted: restrictedListFromEnv(env),
    ipReputation: o.ipReputation ?? StaticRangeReputation.fromConfig(env),
    sanctions,
    terms,
    store,
  });
  const app = createComplianceApp(svc, terms, {
    trustProxy: env.TRUST_PROXY === "true",
    proxySecret: env.PROXY_SECRET || undefined,
    devDefaultCountry: key === 31337 ? env.DEV_DEFAULT_COUNTRY || undefined : undefined,
    attestRpm: intEnv(env, "ATTEST_RPM", 20, 1, 10_000),
    allowedOrigins: (env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    corsAnyOrigin: key === 31337,
  });
  const server = await new Promise<Server>((resolve) => {
    const s = serve({fetch: app.fetch, port: intEnv(env, "PORT", 42071, 0, 65_535), hostname: env.HOST ?? "0.0.0.0"}, () => resolve(s as Server));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    svc,
    store,
    async close() {
      await new Promise<void>((r) => server.close(() => r()));
      await pool.end();
    },
  };
}
