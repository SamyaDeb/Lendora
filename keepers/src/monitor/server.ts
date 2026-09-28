import {safeErrorLine} from "@stockline/sdk";
import {Hono} from "hono";
import type {Health} from "../common/health.js";
import type {Pager} from "./pager.js";
import type {MonitorStore} from "./store.js";
import {weekendReports} from "./weekend.js";

/** Monitor HTTP API: `/health` (LM-R33-style liveness), `GET /weekends` (weekend log, runbooks/testnet.md weekend
 * watch) and `GET /incidents` (open and recent incidents). Read-only; nothing here changes state. */
export function monitorApp(store: MonitorStore, health: Health, tickers: string[], pagers: Pager[]) {
  const app = new Hono();
  app.onError((err, c) => {
    console.error(`[monitor] ${safeErrorLine(err, process.env)}`); // OFF-1
    return c.json({error: "internal error"}, 500);
  });
  const big = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));
  app.get("/health", (c) => {
    const r = health.report();
    return c.json({...r, pagers: pagers.map((p) => p.name)}, r.healthy ? 200 : 503);
  });
  app.get("/weekends", async (c) => c.json({weekends: await weekendReports(store, tickers, Math.min(Number(c.req.query("limit") ?? 20), 100))}));
  app.get("/incidents", async (c) => c.json(big({open: await store.openIncidents(), recent: await store.recent(Math.min(Number(c.req.query("limit") ?? 100), 500))})));
  return app;
}
