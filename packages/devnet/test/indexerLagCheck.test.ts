import {spawn, spawnSync} from "node:child_process";
import {createServer, type Server} from "node:http";
import {mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {afterAll, beforeAll, describe, expect, it} from "vitest";

const CHECK = resolve(__dirname, "../../../scripts/lib/indexer-lag-check.sh");

/** T41: the supervisor's indexer check fails only when the indexer is far behind and not catching up. */
describe("T41 indexer lag check (scripts/lib/indexer-lag-check.sh)", () => {
  const state = {indexed: 1000, head: 1000};
  let ponder: Server;
  let rpc: Server;
  const port = (s: Server) => (s.address() as {port: number}).port;
  beforeAll(async () => {
    ponder = createServer((_, res) => res.end(JSON.stringify({lendora: {id: 46630, block: {number: state.indexed, timestamp: 1}}})));
    rpc = createServer((_, res) => res.end(JSON.stringify({jsonrpc: "2.0", id: 1, result: `0x${state.head.toString(16)}`})));
    await Promise.all([new Promise<void>((r) => ponder.listen(0, r)), new Promise<void>((r) => rpc.listen(0, r))]);
  });
  afterAll(() => (ponder.close(), rpc.close()));
  const dir = mkdtempSync(join(tmpdir(), "lag-"));
  // Async: the fake servers live in this process, so the event loop must keep running while the script calls them.
  const run = () =>
    new Promise<number | null>((ok) =>
      spawn("bash", [CHECK], {env: {...process.env, RPC_URL: `http://127.0.0.1:${port(rpc)}`, PONDER_URL: `http://127.0.0.1:${port(ponder)}`, INDEXER_MAX_LAG: "3000", INDEXER_LAG_STATE: join(dir, "state")}}).on("exit", ok),
    );

  it("passes when current, and while catching up from far behind; fails when far behind and not shrinking", async () => {
    state.head = 1_000_000;
    state.indexed = 999_990;
    expect(await run()).toBe(0); // current
    state.indexed = 900_000;
    expect(await run()).toBe(1); // 100k behind and it grew since the last check
    state.indexed = 950_000;
    expect(await run()).toBe(0); // catching up (lag shrank by 50k)
    state.head += 240; // one minute later, nothing indexed
    expect(await run()).toBe(1);
  });
  it("can't tell (Ponder or the RPC unreachable) is not a failure: the process-exit path covers a dead indexer", () => {
    const r = spawnSync("bash", [CHECK], {env: {...process.env, RPC_URL: "http://127.0.0.1:9", PONDER_URL: "http://127.0.0.1:9", INDEXER_LAG_STATE: join(dir, "s2")}, encoding: "utf8"});
    expect(r.status).toBe(0);
  });
});
