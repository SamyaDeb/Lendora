import {spawn, type ChildProcess} from "node:child_process";
import {fileURLToPath} from "node:url";
import {createServer} from "node:net";

/**
 * Runs the Ponder indexer as a subprocess for tests (indexer, API, web e2e, alerts) against any RPC + Postgres.
 * Each run gets its own schema and views schema, so parallel suites and reruns never collide.
 */
export const INDEXER_DIR = fileURLToPath(new URL("..", import.meta.url));

export interface IndexerHandle {
  port: number;
  schema: string;
  viewsSchema: string;
  /** Wall time from spawn to `/ready` (historical backfill complete). */
  backfillMs: number;
  /** Indexed head per Ponder's `/status`. */
  indexedBlock(): Promise<bigint>;
  waitForBlock(n: bigint, timeoutMs?: number): Promise<void>;
  stop(): Promise<void>;
  logs(): string;
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, () => {
      const port = (s.address() as {port: number}).port;
      s.close(() => resolve(port));
    });
  });
}

export interface StartIndexerOptions {
  rpcUrl: string;
  databaseUrl: string;
  network?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export async function startIndexer(o: StartIndexerOptions): Promise<IndexerHandle> {
  const port = await freePort();
  const id = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const schema = `idx_${id}`;
  const viewsSchema = `v_${id}`;
  let out = "";
  const t0 = Date.now();
  const proc: ChildProcess = spawn(
    "npx",
    ["ponder", "start", "--schema", schema, "--views-schema", viewsSchema, "-p", String(port), "--log-format", "json"],
    {
      cwd: INDEXER_DIR,
      env: {...process.env, DATABASE_URL: o.databaseUrl, RPC_URL: o.rpcUrl, STOCKLINE_NETWORK: o.network ?? "31337", ...o.env},
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  proc.stdout!.on("data", (d) => (out += d.toString()));
  proc.stderr!.on("data", (d) => (out += d.toString()));
  let exited = false;
  proc.on("exit", () => (exited = true));

  const until = Date.now() + (o.timeoutMs ?? 180_000);
  for (;;) {
    if (exited) throw new Error(`indexer exited before ready:\n${out.slice(-4000)}`);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/ready`);
      if (r.ok) break;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > until) throw new Error(`indexer not ready in time:\n${out.slice(-4000)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  const backfillMs = Date.now() - t0;

  const indexedBlock = async () => {
    const r = await fetch(`http://127.0.0.1:${port}/status`);
    const j = (await r.json()) as Record<string, {block?: {number: number}}>;
    return BigInt(j.stockline?.block?.number ?? 0);
  };
  return {
    port,
    schema,
    viewsSchema,
    backfillMs,
    indexedBlock,
    async waitForBlock(n, timeoutMs = 60_000) {
      const end = Date.now() + timeoutMs;
      while ((await indexedBlock()) < n) {
        if (Date.now() > end) throw new Error(`indexer did not reach block ${n}:\n${out.slice(-2000)}`);
        await new Promise((r) => setTimeout(r, 50));
      }
    },
    async stop() {
      if (exited) return;
      proc.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 500));
      if (!exited) proc.kill("SIGKILL");
    },
    logs: () => out,
  };
}
