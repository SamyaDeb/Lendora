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
} else if (cmd === "smoke") {
  // Live chains: TESTNET_GO=yes is required on 46630 (the owner's go); the key comes from env, never from the repo.
  const key = (process.env.SMOKE_KEY ?? process.env.TESTNET_DEPLOYER_KEY) as `0x${string}` | undefined;
  const {connectWallet} = await import("./anvil.js");
  const {smokeFlows} = await import("./smoke.js");
  const {privateKeyToAccount} = await import("viem/accounts");
  if (!key) throw new Error("set SMOKE_KEY (or TESTNET_DEPLOYER_KEY)");
  const a = await connectWallet(rpc, key);
  const chainId = await a.client.getChainId();
  if (chainId === 46630 && process.env.TESTNET_GO !== "yes") throw new Error("TESTNET_GO=yes is required to send on testnet");
  const me = privateKeyToAccount(key).address;
  const compliance = flag("compliance", "");
  const provider = compliance
    ? async (user: `0x${string}`) => {
        const account = privateKeyToAccount(key);
        const headers = {"content-type": "application/json", "x-geo-country": "DE", ...(process.env.PROXY_SECRET ? {"x-stockline-proxy": process.env.PROXY_SECRET} : {})};
        const t = (await (await fetch(`${compliance}/v1/compliance/terms?address=${user}`)).json()) as {version: string; message: string};
        await fetch(`${compliance}/v1/compliance/terms`, {method: "POST", headers, body: JSON.stringify({address: user, signature: await account.signMessage({message: t.message}), version: t.version})});
        const r = await fetch(`${compliance}/v1/compliance/attest`, {method: "POST", headers, body: JSON.stringify({address: user})});
        const j = (await r.json()) as {expiry: string; signature: `0x${string}`; error?: string};
        if (!r.ok) throw new Error(`compliance: ${j.error}`);
        return {expiry: BigInt(j.expiry), signature: j.signature};
      }
    : undefined;
  const drv = new ChainDriver(a, {log: console.log, attestationProvider: provider, attestationKey: process.env.ATTESTATION_SIGNER_KEY as `0x${string}` | undefined});
  const events = await smokeFlows(drv, me);
  console.log(`smoke flows done on chain ${chainId}: ${events.length} actions`);
} else if (cmd === "dump-state") {
  const a = await guardAnvil(rpc);
  const state = await a.test.dumpState();
  writeFileSync(FIXTURE_STATE, `${state}\n`);
  console.log(`wrote ${FIXTURE_STATE} (block ${await a.client.getBlockNumber()})`);
} else {
  console.error(`unknown command ${cmd}`);
  process.exit(1);
}
