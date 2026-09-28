import {createServer, type IncomingMessage, type Server} from "node:http";
import type {AddressInfo} from "node:net";
import {afterAll, afterEach, beforeAll, describe, expect, it} from "vitest";
import type {PublicClient} from "viem";
import {createComplianceApp} from "../src/app.js";
import {DenyListScreen, StaticRangeReputation} from "../src/checks.js";
import {assertStartupConfig} from "../src/server.js";
import {ComplianceService, type Terms, type TermsStore} from "../src/service.js";
import {ChainalysisScreen, LayeredScreen, ScreenUnavailable, sanctionsFromEnv, TrmScreen} from "../src/sanctions/index.js";

/**
 * CP-R3 / Q5: the Chainalysis and TRM adapters against a fake HTTP server shaped like each provider's public API.
 * No real API calls. Every failure mode fails closed for entries (no attestation) and never names the key.
 */
const KEY = "sk_test_do_not_log_0123456789";
const ADDR = "0x1111111111111111111111111111111111111111";
const SECRET = "test-proxy-secret-0123456789abcdef";

type Handler = (req: IncomingMessage, body: string) => {status?: number; json?: unknown; raw?: string; hang?: boolean};
interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

let server: Server;
let base: string;
let handler: Handler = () => ({status: 404});
const seen: Seen[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({method: req.method ?? "", url: req.url ?? "", headers: req.headers, body});
      const r = handler(req, body);
      if (r.hang) return; // never answers: the adapter's timeout must fire
      res.writeHead(r.status ?? 200, {"content-type": "application/json"});
      res.end(r.raw ?? JSON.stringify(r.json ?? {}));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});
afterEach(() => {
  seen.length = 0;
  handler = () => ({status: 404});
});

const http = {timeoutMs: 300};
const chainalysis = () => new ChainalysisScreen(KEY, `${base}/api/risk/v2/entities`, http);
const trm = (chain = "ethereum") => new TrmScreen(KEY, chain, `${base}/public/v2/screening/addresses`, http);

/** Chainalysis v2: POST registers, GET returns the entity. */
function chainalysisReturns(entity: unknown, status = 200): Handler {
  return (req) => (req.method === "POST" ? {json: {address: ADDR}} : {status, json: entity});
}
const entity = (o: Record<string, unknown> = {}) => ({address: ADDR, risk: "Low", riskReason: null, status: "COMPLETE", cluster: null, addressIdentifications: [], exposures: [], triggers: [], ...o});

async function failsClosed(p: Promise<unknown>) {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(ScreenUnavailable);
  expect(String((e as Error).message)).not.toContain(KEY); // offchain review: no key in errors or logs
  return e as ScreenUnavailable;
}

describe("CP-R3 Chainalysis adapter (Q5)", () => {
  it("CP_R3 chainalysis registers then reads the entity with the Token header; Low risk is clean", async () => {
    handler = chainalysisReturns(entity());
    expect(await chainalysis().screen(ADDR)).toEqual({sanctioned: false, provider: "chainalysis", reference: undefined});
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual(["POST /api/risk/v2/entities", `GET /api/risk/v2/entities/${ADDR}`]);
    expect(JSON.parse(seen[0].body)).toEqual({address: ADDR});
    expect(seen.every((s) => s.headers.token === KEY)).toBe(true);
  });

  it("CP_R3 chainalysis blocks Severe risk and any sanctions identification", async () => {
    handler = chainalysisReturns(entity({risk: "Severe", riskReason: "Identified as sanctioned entity"}));
    expect(await chainalysis().screen(ADDR)).toMatchObject({sanctioned: true, reference: "Identified as sanctioned entity"});
    handler = chainalysisReturns(entity({risk: "Low", addressIdentifications: [{category: "sanctions", name: "SDN list"}]}));
    expect(await chainalysis().screen(ADDR)).toMatchObject({sanctioned: true, reference: "SDN list"});
    handler = chainalysisReturns(entity({risk: "High", riskReason: "exposure"}));
    expect((await chainalysis().screen(ADDR)).sanctioned).toBe(false); // High is not a block (A36)
  });

  it("CP_R3 chainalysis fails closed on HTTP errors, a pending entity, a wrong address, a bad body and a timeout", async () => {
    handler = () => ({status: 500});
    expect((await failsClosed(chainalysis().screen(ADDR))).status).toBe(500);
    handler = chainalysisReturns({}, 403);
    expect((await failsClosed(chainalysis().screen(ADDR))).status).toBe(403);
    handler = chainalysisReturns(entity({status: "IN_PROGRESS"}));
    await failsClosed(chainalysis().screen(ADDR));
    handler = chainalysisReturns(entity({address: "0x2222222222222222222222222222222222222222"}));
    await failsClosed(chainalysis().screen(ADDR));
    handler = chainalysisReturns({risk: "Unknown"});
    await failsClosed(chainalysis().screen(ADDR));
    handler = (req) => (req.method === "POST" ? {json: {}} : {raw: "<html>"});
    await failsClosed(chainalysis().screen(ADDR));
    handler = () => ({hang: true});
    const t0 = Date.now();
    await failsClosed(chainalysis().screen(ADDR));
    expect(Date.now() - t0).toBeLessThan(2_000);
  });
});

describe("CP-R3 TRM adapter (Q5)", () => {
  const row = (o: Record<string, unknown> = {}) => [{address: ADDR, chain: "ethereum", addressRiskIndicators: [], entities: [], ...o}];

  it("CP_R3 trm posts [{address, chain}] with Basic key:key auth; no indicators is clean", async () => {
    handler = () => ({json: row()});
    expect(await trm("arbitrum").screen(ADDR)).toEqual({sanctioned: false, provider: "trm", reference: undefined});
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe("POST");
    expect(seen[0].url).toBe("/public/v2/screening/addresses");
    expect(JSON.parse(seen[0].body)).toEqual([{address: ADDR, chain: "arbitrum"}]);
    const auth = String(seen[0].headers.authorization);
    expect(Buffer.from(auth.replace(/^Basic /, ""), "base64").toString()).toBe(`${KEY}:${KEY}`);
  });

  it("CP_R3 trm blocks a Sanctions entity, a Severe Sanctions indicator and a Severe ownership indicator", async () => {
    handler = () => ({json: row({entities: [{category: "Sanctions", entity: "OFAC SDN", riskScoreLevelLabel: "Severe"}]})});
    expect(await trm().screen(ADDR)).toMatchObject({sanctioned: true, reference: "OFAC SDN"});
    handler = () => ({json: row({addressRiskIndicators: [{category: "Sanctions", categoryRiskScoreLevelLabel: "Severe", riskType: "COUNTERPARTY"}]})});
    expect((await trm().screen(ADDR)).sanctioned).toBe(true);
    handler = () => ({json: row({addressRiskIndicators: [{category: "Terrorist Financing", categoryRiskScoreLevelLabel: "Severe", riskType: "OWNERSHIP"}]})});
    expect((await trm().screen(ADDR)).sanctioned).toBe(true);
    handler = () => ({json: row({addressRiskIndicators: [{category: "Gambling", categoryRiskScoreLevelLabel: "High", riskType: "COUNTERPARTY"}]})});
    expect((await trm().screen(ADDR)).sanctioned).toBe(false);
  });

  it("CP_R3 trm fails closed on 401/429/5xx, an empty or foreign result, a bad body and a timeout", async () => {
    for (const status of [401, 429, 503]) {
      handler = () => ({status});
      expect((await failsClosed(trm().screen(ADDR))).status).toBe(status);
    }
    handler = () => ({json: []});
    await failsClosed(trm().screen(ADDR));
    handler = () => ({json: row({address: "0x2222222222222222222222222222222222222222"})});
    await failsClosed(trm().screen(ADDR));
    handler = () => ({json: {error: "x"}});
    await failsClosed(trm().screen(ADDR));
    handler = () => ({hang: true});
    await failsClosed(trm().screen(ADDR));
  });
});

describe("CP-R3 provider selection and startup (Q5, CP-R8)", () => {
  it("CP_R3 SANCTIONS_PROVIDER picks the adapter; unknown names and missing keys are refused; the deny list runs first", async () => {
    expect(sanctionsFromEnv({}).name).toBe("deny-list");
    expect(() => sanctionsFromEnv({SANCTIONS_PROVIDER: "chainanalysis"})).toThrow(/must be one of/);
    expect(() => sanctionsFromEnv({SANCTIONS_PROVIDER: "trm"})).toThrow(/SANCTIONS_API_KEY/);
    expect(() => sanctionsFromEnv({SANCTIONS_PROVIDER: "trm", SANCTIONS_API_KEY: KEY, SANCTIONS_API_URL: "http://api.example.com"})).toThrow(/https/);
    expect(() => sanctionsFromEnv({SANCTIONS_PROVIDER: "trm", SANCTIONS_API_KEY: KEY, SANCTIONS_TIMEOUT_MS: "5"})).toThrow(/TIMEOUT/);

    const s = sanctionsFromEnv({SANCTIONS_PROVIDER: "TRM", SANCTIONS_API_KEY: KEY, SANCTIONS_API_URL: `${base}/public/v2/screening/addresses`, SANCTIONS_DENY_LIST: ADDR, SANCTIONS_TRM_CHAIN: "base"});
    expect(s).toBeInstanceOf(LayeredScreen);
    expect(s.name).toBe("trm");
    handler = () => ({json: [{address: "0x3333333333333333333333333333333333333333", entities: []}]});
    expect(await s.screen(ADDR.toUpperCase().replace("0X", "0x"))).toMatchObject({sanctioned: true, provider: "deny-list"});
    expect(seen).toHaveLength(0); // a deny-list hit never calls the provider
    expect((await s.screen("0x3333333333333333333333333333333333333333")).sanctioned).toBe(false);
    expect(JSON.parse(seen[0].body)[0].chain).toBe("base");
  });

  it("CP_R8 mainnet (4663) refuses a missing key, an unknown provider and a plain-http API URL", () => {
    expect(() => assertStartupConfig({PROXY_SECRET: SECRET, SANCTIONS_PROVIDER: "chainalysis"}, "4663")).toThrow(/SANCTIONS_API_KEY/);
    expect(() => assertStartupConfig({PROXY_SECRET: SECRET, SANCTIONS_PROVIDER: "elliptic", SANCTIONS_API_KEY: KEY}, "4663")).toThrow(/must be one of/);
    expect(() => assertStartupConfig({PROXY_SECRET: SECRET, SANCTIONS_PROVIDER: "trm", SANCTIONS_API_KEY: KEY, SANCTIONS_API_URL: `${base}/x`}, "4663")).toThrow(/https/);
    expect(() => assertStartupConfig({PROXY_SECRET: SECRET, SANCTIONS_PROVIDER: "trm", SANCTIONS_API_KEY: KEY}, "4663")).not.toThrow();
    expect(() => assertStartupConfig({PROXY_SECRET: SECRET, SANCTIONS_PROVIDER: "chainalysis", SANCTIONS_API_KEY: KEY}, "4663")).not.toThrow();
    expect(() => assertStartupConfig({SANCTIONS_PROVIDER: "nope"}, "31337")).toThrow(/must be one of/);
  });
});

describe("CP-R3 / CP-R4 a provider outage fails the entry closed and touches no exit", () => {
  const terms: Terms = {version: "test", text: "", hash: "0x00"};
  const stubClient = {} as PublicClient; // attest() must refuse before any chain or store call
  const stubStore = {accepted: async () => ({signedAt: new Date()})} as unknown as TermsStore;
  const svc = (sanctions: ConstructorParameters<typeof LayeredScreen>[1]) =>
    new ComplianceService({
      signer: {kind: "env-key", address: "0x4444444444444444444444444444444444444444", signTypedData: async () => "0x"},
      client: stubClient,
      chainId: 31337,
      router: "0x5555555555555555555555555555555555555555",
      restricted: {countries: [], regions: []},
      ipReputation: new StaticRangeReputation([]),
      sanctions: new LayeredScreen(new DenyListScreen([]), sanctions),
      terms,
      store: stubStore,
    });

  it("CP_R3 CP_R4 /attest answers 403 SCREEN_UNAVAILABLE when TRM times out or Chainalysis errors; /health names the provider, not the key", async () => {
    const o = {trustProxy: false, attestRpm: 100, allowedOrigins: []};
    const req = () => new Request("http://x/v1/compliance/attest", {method: "POST", headers: {"content-type": "application/json", "x-geo-country": "DE"}, body: JSON.stringify({address: ADDR})});
    for (const [screen, h] of [
      [trm(), (() => ({hang: true})) as Handler],
      [chainalysis(), (() => ({status: 502})) as Handler],
    ] as const) {
      handler = h;
      const app = createComplianceApp(svc(screen), terms, o);
      const r = await app.request(req());
      expect(r.status).toBe(403);
      const body = (await r.json()) as {code: string; error: string};
      expect(body.code).toBe("SCREEN_UNAVAILABLE");
      expect(body.error).toMatch(/exits are not affected/);
      expect(JSON.stringify(body)).not.toContain(KEY);
      const health = (await (await app.request(new Request("http://x/health"))).json()) as {sanctions: string};
      expect(health.sanctions).toBe(screen.name);
      expect(JSON.stringify(health)).not.toContain(KEY);
    }
    // Exits (repay, close, withdraw, unwrap) have no compliance endpoint at all; CP_R4 in compliance.test.ts runs them
    // on anvil with no attestation signer and the guard tripped.
  });
});
