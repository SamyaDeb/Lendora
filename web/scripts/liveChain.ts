/**
 * Moves the live stack's chain (scripts/liveStack.ts) into a market state, as the keepers would:
 *
 *   tsx scripts/liveChain.ts weekend   # warp past Friday's close: feeds frozen, weekend buffer in force
 *   tsx scripts/liveChain.ts open      # warp to the next session open (Monday 14:00 UTC)
 *   tsx scripts/liveChain.ts fresh     # fresh feed rounds, clear the guard, poke the oracles (after a warp)
 *   tsx scripts/liveChain.ts nav       # … then a NAV report signed by both dev NAV signers (the reporter keeper's job)
 *
 * Every command ends with `fresh`, so the oracle guard doesn't trip on the block gap a warp creates.
 */
import {readFileSync} from "node:fs";
import {feedSessions} from "@lendora/sdk";
import {ChainDriver, connectAnvil, DnDriver} from "@lendora/devnet";

const {rpc} = JSON.parse(readFileSync(new URL("./.live-stack.json", import.meta.url), "utf8")) as {rpc: string};
const drv = new ChainDriver(await connectAnvil(rpc));
const cmd = process.argv[2] ?? "fresh";
const now = Number(await drv.now());
const next = feedSessions.find((s) => s.closeTs > now);
if (cmd === "weekend" && next) await drv.warp(BigInt((next.openTs <= now ? next.closeTs : now) + 7200));
if (cmd === "open" && next) await drv.warp(BigInt(Math.max(now, next.openTs) + 14 * 3600));
await drv.rounds();
for (const t of drv.tickers) await drv.guardian(t, "clear").catch(() => {});
await drv.poke();
if (cmd === "nav") await new DnDriver(drv).report();
console.log(`[chain] ${new Date(Number(await drv.now()) * 1000).toISOString()} · feed ${(await drv.isOpen()) ? "open" : "closed (weekend mode)"}`);
process.exit(0);
