/**
 * Chain driver CLI (Phase 2 task 0). Anvil only: it refuses any other chain id.
 *
 *   pnpm --filter @stockline/devnet drive seed [--rpc URL]       # the seed week (tests reuse the same scenario)
 *   pnpm --filter @stockline/devnet drive live [--rpc URL]       # fresh rounds + allocator pass every 15 s (dev stack)
 *   pnpm --filter @stockline/devnet drive serve [--port 8545]    # anvil with the DeployLocal fixture, foreground
 *   pnpm --filter @stockline/devnet drive dump-state [--rpc URL] # write the node's state to fixtures/anvil-state.hex
 */
import {writeFileSync} from "node:fs";
import {connectAnvil, FIXTURE_STATE, startAnvil} from "./anvil.js";
import {ChainDriver} from "./driver.js";
import {seedWeek} from "./scenario.js";

const [cmd = "seed", ...rest] = process.argv.slice(2);
const flag = (name: string, dflt: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : dflt;
};
const rpc = flag("rpc", process.env.RPC_URL ?? "http://127.0.0.1:8545");

async function guardAnvil(url: string) {
  const a = await connectAnvil(url);
  const id = await a.client.getChainId();
  if (id !== 31337) throw new Error(`refusing to drive chain ${id}: the driver is for anvil (31337) only`);
  return a;
}

if (cmd === "serve") {
  const port = Number(flag("port", "8545"));
  const a = await startAnvil({port, args: ["--host", "0.0.0.0"]});
  console.log(`anvil with the DeployLocal fixture on http://127.0.0.1:${port} (block ${await a.client.getBlockNumber()})`);
  process.on("SIGINT", () => (a.stop(), process.exit(0)));
  process.on("SIGTERM", () => (a.stop(), process.exit(0)));
  await new Promise(() => {});
} else if (cmd === "seed") {
  const drv = new ChainDriver(await guardAnvil(rpc), {log: console.log, attestationKey: process.env.ATTESTATION_SIGNER_KEY as `0x${string}` | undefined});
  const r = await seedWeek(drv);
  console.log(`seed week done: ${r.events.length} actions, last block ${r.lastBlock}`);
} else if (cmd === "live") {
  const a = await guardAnvil(rpc);
  const drv = new ChainDriver(a, {log: console.log});
  const every = Number(flag("interval", "15000"));
  console.log(`live driver: fresh rounds (random walk, ±0.3%) and an allocator pass every ${every} ms while the feed is open`);
  for (;;) {
    try {
      const block = await a.client.getBlock();
      await a.setTime(BigInt(Math.max(Number(block.timestamp) + 1, Math.floor(Date.now() / 1000))));
      if (await drv.isOpen()) {
        const next: Record<string, bigint> = {};
        for (const t of drv.tickers) next[t] = (drv.prices[t] * BigInt(10_000 + Math.round((Math.random() - 0.5) * 60))) / 10_000n;
        await drv.rounds(next);
      }
      await drv.allocate();
    } catch (e) {
      console.error(`[live] ${String(e)}`);
    }
    await new Promise((r) => setTimeout(r, every));
  }
} else if (cmd === "dump-state") {
  const a = await guardAnvil(rpc);
  const state = await a.test.dumpState();
  writeFileSync(FIXTURE_STATE, `${state}\n`);
  console.log(`wrote ${FIXTURE_STATE} (block ${await a.client.getBlockNumber()})`);
} else {
  console.error(`unknown command ${cmd}`);
  process.exit(1);
}
