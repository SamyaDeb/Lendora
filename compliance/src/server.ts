import type {AddressInfo} from "node:net";
import type {Server} from "node:http";
import {serve} from "@hono/node-server";
import pg from "pg";
import {createPublicClient, http, type PublicClient} from "viem";
import {getDeployment, parseDeploymentKey, restrictedListFromEnv, TERMS_VERSION, type Address} from "@stockline/sdk";
import {envKeyTypedDataSigner, remoteTypedDataSigner, type TypedDataSigner} from "@stockline/keepers/signer";
import {createComplianceApp} from "./app.js";
import {sanctionsFromEnv, StaticRangeReputation, type IpReputation, type SanctionsScreen} from "./checks.js";
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

export async function startCompliance(env: NodeJS.ProcessEnv = process.env, o: ComplianceOverrides = {}): Promise<RunningCompliance> {
  const raw = env.STOCKLINE_NETWORK ?? env.DEPLOYMENT_KEY ?? "31337";
  if (raw === "4663") throw new Error("Phase 2 signs no attestations for 4663");
  const key = parseDeploymentKey(raw);
  const d = getDeployment(key);
  if (!d?.router) throw new Error(`no router for "${raw}" in @stockline/sdk addresses.json`);
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required");
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
    sanctions: o.sanctions ?? sanctionsFromEnv(env),
    terms,
    store,
  });
  const app = createComplianceApp(svc, terms, {
    trustProxy: env.TRUST_PROXY === "true",
    proxySecret: env.PROXY_SECRET || undefined,
    devDefaultCountry: key === 31337 ? env.DEV_DEFAULT_COUNTRY || undefined : undefined,
    attestRpm: Number(env.ATTEST_RPM ?? 20),
    allowedOrigins: (env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  });
  const server = await new Promise<Server>((resolve) => {
    const s = serve({fetch: app.fetch, port: Number(env.PORT ?? 42071), hostname: env.HOST ?? "0.0.0.0"}, () => resolve(s as Server));
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
