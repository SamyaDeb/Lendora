import {spawn, spawnSync, type ChildProcess} from "node:child_process";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createConnection} from "node:net";
import {freePort} from "./anvil.js";

/**
 * Throwaway Postgres and Redis for tests and the dev stack (Phase 2 task 0). `DATABASE_URL` / `REDIS_URL` win when set
 * (CI services, docker-compose); otherwise a local `postgres` / `redis-server` binary is started on a free port with
 * its data in a temp dir, and removed on `stop()`. No passwords: trust auth on 127.0.0.1 only.
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
  if (process.env.DATABASE_URL) return {url: process.env.DATABASE_URL, stop: () => {}};
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
