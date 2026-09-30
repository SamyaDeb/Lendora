import {safeErrorLine} from "@lendora/sdk";
import {Hono} from "hono";
import type {PublicClient} from "viem";
import {isAddress} from "viem";
import type {AlertSettings, Address} from "@lendora/sdk";
import type {Health} from "../common/health.js";
import {masked, SettingsError, validateSettings, verifySave, type SettingsStore} from "./settings.js";

/** Settings API behind the app's `/api/alerts/*` proxy, plus `/health` (LM-R33-style liveness for this keeper). */
export function alertsApp(store: SettingsStore, client: PublicClient, health: Health, o: {allowHttpWebhooks: boolean}) {
  const app = new Hono();
  app.onError((err, c) => {
    if (err instanceof SettingsError) return c.json({error: err.message}, err.status);
    console.error(`[alerts] ${safeErrorLine(err, process.env)}`); // OFF-1
    return c.json({error: "internal error"}, 500);
  });
  app.get("/health", (c) => {
    const r = health.report();
    return c.json(r, r.healthy ? 200 : 503);
  });
  app.get("/v1/alerts/settings/:address", async (c) => {
    const a = c.req.param("address");
    if (!isAddress(a)) return c.json({error: "invalid address"}, 400);
    const s = await store.get(a as Address);
    return c.json({settings: s ? masked(s.settings) : null, issuedAt: s?.issuedAt ?? null});
  });
  app.post("/v1/alerts/settings", async (c) => {
    const b = (await c.req.json().catch(() => null)) as {address?: string; settings?: AlertSettings; issuedAt?: string; signature?: string} | null;
    if (!b?.address || !isAddress(b.address) || !b.settings || !b.issuedAt || !b.signature) return c.json({error: "expected {address, settings, issuedAt, signature}"}, 400);
    // The signature covers exactly what the user sent; validation runs on the same object.
    await verifySave(client, b.address as Address, b.settings, b.issuedAt, b.signature as `0x${string}`);
    const settings = validateSettings(b.settings, o.allowHttpWebhooks);
    await store.save(b.address as Address, settings, b.issuedAt);
    return c.json({saved: true});
  });
  return app;
}
