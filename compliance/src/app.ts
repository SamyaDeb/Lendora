import {Hono, type Context} from "hono";
import {cors} from "hono/cors";
import type {HttpBindings} from "@hono/node-server";
import {z} from "zod";
import {isAddress, type Address} from "viem";
import {Denied, type ComplianceService, type Terms} from "./service.js";
import {HeaderGeoResolver} from "./checks.js";

/**
 * Compliance HTTP API used by the web app (docs/prd/10 CP-R1…R4, APP-R2, APP-R10, RT-R2):
 *   GET  /v1/compliance/connection            → geo + restricted + datacenter for this connection (block page)
 *   GET  /v1/compliance/terms[?address=0x…]   → current terms (version, hash, text, the message to sign)
 *   GET  /v1/compliance/terms/{address}       → whether the wallet accepted the current terms
 *   POST /v1/compliance/terms                 → {address, signature, version}: store an acceptance
 *   POST /v1/compliance/attest                → {address}: the router attestation for borrow/openShort
 * There is deliberately no endpoint for exits: repay, close, withdraw and unwrap never need one (CP-R4).
 */
type Env = {Bindings: HttpBindings};

export interface AppOptions {
  trustProxy: boolean;
  /** When set, geo and client-IP headers are trusted only on requests carrying `x-stockline-proxy: <secret>` (the
   * web app's server-side proxy at the edge, which sets them from the platform). Without it, geo is unknown. */
  proxySecret?: string;
  /** Local anvil only: the country assumed when no geo header is present (never set on testnet/mainnet). */
  devDefaultCountry?: string;
  /** Attestation requests per minute, counted separately per client IP and per wallet (CP-R8). */
  attestRpm: number;
  allowedOrigins: string[];
}

const addr = z.string().refine((a) => isAddress(a), "invalid address");

export function createComplianceApp(svc: ComplianceService, terms: Terms, o: AppOptions) {
  const app = new Hono<Env>();
  const geo = new HeaderGeoResolver();
  const hits = new Map<string, {n: number; reset: number}>();
  /** Fixed one-minute window per key ("ip:…" or "wallet:…"); expired entries are dropped as the map grows. */
  const overLimit = (key: string, now: number) => {
    if (hits.size > 10_000) for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
    const h = hits.get(key);
    if (!h || h.reset <= now) {
      hits.set(key, {n: 1, reset: now + 60});
      return false;
    }
    return ++h.n > o.attestRpm;
  };
  const trusted = (c: Context<Env>) => !o.proxySecret || c.req.header("x-stockline-proxy") === o.proxySecret;
  const geoOf = (c: Context<Env>) => {
    const g = trusted(c) ? geo.resolve((n) => c.req.header(n)) : {country: null, region: null};
    return g.country || !o.devDefaultCountry ? g : {country: o.devDefaultCountry, region: null};
  };
  const ipOf = (c: Context<Env>) => {
    if (o.trustProxy && trusted(c)) {
      const xff = c.req.header("x-forwarded-for");
      if (xff) return xff.split(",")[0].trim();
    }
    return c.env?.incoming?.socket?.remoteAddress ?? "unknown";
  };

  app.use("*", cors({origin: o.allowedOrigins.length ? o.allowedOrigins : "*", allowHeaders: ["Content-Type"], allowMethods: ["GET", "POST", "OPTIONS"]}));
  app.onError((err, c) => {
    if (err instanceof Denied) return c.json({code: err.code, error: err.message}, 403);
    console.error(`[compliance] ${c.req.method} ${c.req.path}: ${String(err)}`);
    return c.json({error: "internal error"}, 500);
  });
  app.get("/health", (c) => c.json({ok: true, signer: svc.signerAddress}));

  app.get("/v1/compliance/connection", async (c) => c.json(await svc.connectionCheck(geoOf(c), ipOf(c))));

  app.get("/v1/compliance/terms", (c) => {
    const a = c.req.query("address");
    const message = a && isAddress(a) ? svc.termsMessageFor(a as Address) : null;
    return c.json({version: terms.version, hash: terms.hash, text: terms.text, message});
  });

  app.get("/v1/compliance/terms/:address", async (c) => {
    const a = c.req.param("address");
    if (!isAddress(a)) return c.json({error: "invalid address"}, 400);
    return c.json(await svc.termsStatus(a as Address));
  });

  app.post("/v1/compliance/terms", async (c) => {
    const body = z.object({address: addr, signature: z.string().regex(/^0x[0-9a-fA-F]+$/), version: z.string()}).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({error: "expected {address, signature, version}"}, 400);
    await svc.acceptTerms(body.data.address as Address, body.data.signature as `0x${string}`, body.data.version);
    return c.json({accepted: true, version: body.data.version});
  });

  app.post("/v1/compliance/attest", async (c) => {
    const ip = ipOf(c);
    const now = Math.floor(Date.now() / 1000);
    if (overLimit(`ip:${ip}`, now)) return c.json({error: "too many attestation requests"}, 429);
    const body = z.object({address: addr}).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({error: "expected {address}"}, 400);
    // CP-R8: also per wallet, so rotating IPs (or a shared proxy IP) cannot farm attestations for one address.
    if (overLimit(`wallet:${body.data.address.toLowerCase()}`, now)) return c.json({error: "too many attestation requests"}, 429);
    return c.json(await svc.attest(body.data.address as Address, geoOf(c), ip));
  });

  return app;
}
