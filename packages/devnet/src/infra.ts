import {spawn, spawnSync, type ChildProcess} from "node:child_process";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createConnection} from "node:net";
import pg from "pg";
import {freePort} from "./anvil.js";

/**
 * Throwaway Postgres and Redis for tests and the dev stack (Phase 2 task 0). `DATABASE_URL` / `REDIS_URL` win when set
 * (CI services, docker-compose); otherwise a local `postgres` / `redis-server` binary is started on a free port with
 * its data in a temp dir, and removed on `stop()`. No passwords: trust auth on 127.0.0.1 only.
 *
 * With `DATABASE_URL`, every call gets its **own database** on that server (dropped on `stop()`): Ponder keeps its RPC
 * cache in a fixed `ponder_sync` schema keyed by chain id and block, and parallel suites each run an anvil with chain
 * id 31337 but a different history, so a shared database mixed their cached reads (CI failure, 2026-09-28).
 */
export interface Service {
  url: string;
  stop(): void;
}

async function waitPort(port: number, timeoutMs = 30_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = createConnection({port, host: "127.0.0.1"}, () => (s.end(), resolve(true)));
      s.on("error", () => resolve(false));
    });
    if (ok) return;
    if (Date.now() > until) throw new Error(`port ${port} did not open`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

function has(bin: string): boolean {
  return spawnSync("which", [bin]).status === 0;
}

export async function startPostgres(): Promise<Service> {
  if (process.env.DATABASE_URL) return freshDatabase(process.env.DATABASE_URL);
  if (!has("postgres") || !has("initdb")) throw new Error("set DATABASE_URL or install postgres (initdb, postgres) on PATH");
  const dir = mkdtempSync(join(tmpdir(), "stockline-pg-"));
  const init = spawnSync("initdb", ["-D", dir, "-U", "stockline", "--auth=trust", "-E", "UTF8", "--no-instructions"], {stdio: "ignore"});
  if (init.status !== 0) throw new Error("initdb failed");
  const port = await freePort();
  const proc: ChildProcess = spawn("postgres", ["-D", dir, "-p", String(port), "-k", dir, "-h", "127.0.0.1", "-c", "fsync=off", "-c", "max_connections=200"], {stdio: "ignore"});
  await waitPort(port);
  // The server accepts TCP before it accepts logins; retry createdb until it does.
  for (let i = 0; i < 100; i++) {
    const r = spawnSync("createdb", ["-h", "127.0.0.1", "-p", String(port), "-U", "stockline", "stockline"], {stdio: "ignore"});
    if (r.status === 0) break;
    await new Promise((res) => setTimeout(res, 100));
  }
  // The data dir (~50–150 MB) must not outlive the test run. It is removed when the server exits, and a detached
  // watchdog stops the server and removes the dir once this process is gone (test runners kill their workers without
  // an "exit" event; an unref'd timer never fired either, which leaked one dir per run).
  const cleanup = () => rmSync(dir, {recursive: true, force: true});
  proc.on("exit", cleanup);
  spawn("sh", ["-c", `while kill -0 ${process.pid} 2>/dev/null; do sleep 2; done; kill -INT ${proc.pid} 2>/dev/null; sleep 3; kill -9 ${proc.pid} 2>/dev/null; rm -rf '${dir}'`], {detached: true, stdio: "ignore"}).unref();
  return {
    url: `postgres://stockline@127.0.0.1:${port}/stockline`,
    stop: () => {
      proc.kill("SIGINT");
    },
  };
}

export async function startRedis(): Promise<Service> {
  if (process.env.REDIS_URL) return {url: process.env.REDIS_URL, stop: () => {}};
  if (!has("redis-server")) throw new Error("set REDIS_URL or install redis-server on PATH");
  const port = await freePort();
  const proc = spawn("redis-server", ["--port", String(port), "--bind", "127.0.0.1", "--save", "", "--appendonly", "no"], {stdio: "ignore"});
  await waitPort(port);
  return {url: `redis://127.0.0.1:${port}`, stop: () => proc.kill()};
}

/** A new, empty database on the server of `serverUrl`; `stop()` drops it (best effort, connections forced closed). */
async function freshDatabase(serverUrl: string): Promise<Service> {
  const name = `stockline_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`;
  const admin = new pg.Client({connectionString: serverUrl});
  await admin.connect();
  try {
    await admin.query(`create database "${name}"`);
    // A test process can exit before its drop completes: sweep this helper's databases older than 6h.
    const {rows} = await admin.query(`select datname from pg_database where datname like 'stockline\\_%\\_%'`);
    for (const {datname} of rows as {datname: string}[]) {
      const born = parseInt(datname.split("_")[1] ?? "", 36);
      if (Number.isFinite(born) && Date.now() - born > 6 * 3600_000) {
        await admin.query(`drop database if exists "${datname}" with (force)`).catch(() => {});
      }
    }
  } finally {
    await admin.end();
  }
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    stop: () => {
      const c = new pg.Client({connectionString: serverUrl});
      void c
        .connect()
        .then(() => c.query(`drop database if exists "${name}" with (force)`))
        .catch(() => {})
        .finally(() => void c.end().catch(() => {}));
    },
  };
}
