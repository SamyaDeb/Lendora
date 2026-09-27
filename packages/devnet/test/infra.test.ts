import {spawnSync} from "node:child_process";
import {createConnection} from "node:net";
import {describe, expect, it} from "vitest";
import {startPostgres, startRedis} from "../src/infra.js";

describe("ephemeral infra for tests (Phase 2 task 0)", () => {
  it("starts a Postgres that accepts queries", async () => {
    const pg = await startPostgres();
    try {
      const r = spawnSync("psql", [pg.url, "-tAc", "select 1"], {encoding: "utf8"});
      expect(r.stdout.trim()).toBe("1");
    } finally {
      pg.stop();
    }
  });

  it("starts a Redis that answers PING", async () => {
    const redis = await startRedis();
    try {
      const u = new URL(redis.url);
      const reply = await new Promise<string>((resolve, reject) => {
        const s = createConnection({host: u.hostname, port: Number(u.port)}, () => s.write("PING\r\n"));
        s.on("data", (d) => (s.end(), resolve(d.toString().trim())));
        s.on("error", reject);
      });
      expect(reply).toBe("+PONG");
    } finally {
      redis.stop();
    }
  });
});
