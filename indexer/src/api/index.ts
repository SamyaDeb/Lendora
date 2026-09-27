import {Hono} from "hono";

/** Ponder requires an API entry. The public API is the separate `api/` service (SI-R10…R14), which reads this
 * indexer's tables through the `--views-schema` views; this server only exposes Ponder's own /health, /ready and
 * /status (used for readiness and the head-lag measurement). */
const app = new Hono();

export default app;
