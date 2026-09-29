import {encodeFunctionData, erc20Abi} from "viem";
import type {ChainDriver, DriverEvent} from "./driver.js";

const E18 = 10n ** 18n;
const E6 = 10n ** 6n;

/**
 * Smoke flows for a live deployment (testnet after the go, or anvil): every router flow of 05 §4 once, by one wallet,
 * at the current chain time (the feed mirror keeps prices fresh). Returns the recorded actions with tx hashes.
 * `allocate: false` for a wallet without the allocator role (the hosted stack's allocator keeper supplies liquidity).
 */
export async function smokeFlows(drv: ChainDriver, me: `0x${string}`, log: (m: string) => void = console.log, opts: {allocate?: boolean} = {}): Promise<DriverEvent[]> {
  const faucet = drv.d.mocks?.faucet;
  if (faucet) {
    const r = await drv.a.send(me, faucet, encodeFunctionData({abi: [{type: "function", name: "claim", stateMutability: "nonpayable", inputs: [{type: "address"}], outputs: []}] as const, functionName: "claim", args: [me]})).catch((e) => {
      log(`[smoke] faucet: ${String(e).split("\n")[0]} (already claimed today?)`);
      return undefined;
    });
    if (r) log(`[smoke] faucet claim ${r.transactionHash}`);
  }
  const start = drv.events.length;
  await drv.lend("NVDA", me, 2n * E18);
  await drv.lend("AAPL", me, 2n * E18);
  // The allocator role (the deployer on testnet, A27); a plain tester relies on the allocator keeper instead.
  if (opts.allocate !== false) await drv.allocate(["NVDA", "AAPL"]);
  await drv.openShort("NVDA", me, 2_000n * E6, E18 / 2n);
  await drv.addCollateral("NVDA", me, 100n * E6);
  await drv.repay("NVDA", me, E18 / 10n);
  await drv.closeShort("NVDA", me);
  await drv.borrow("AAPL", me, 1_500n * E6, E18 / 2n);
  await drv.repay("AAPL", me);
  await drv.withdrawCollateral("AAPL", me, (await drv.a.client.readContract({address: drv.d.morpho, abi: [{type: "function", name: "position", stateMutability: "view", inputs: [{type: "bytes32"}, {type: "address"}], outputs: [{type: "uint256"}, {type: "uint128"}, {type: "uint128"}]}] as const, functionName: "position", args: [drv.stock("AAPL").marketId, me]}))[2]);
  for (const t of ["NVDA", "AAPL"]) {
    const shares = await drv.a.client.readContract({address: drv.stock(t).vault, abi: erc20Abi, functionName: "balanceOf", args: [me]});
    await drv.withdrawLend(t, me, shares);
  }
  const done = drv.events.slice(start);
  for (const e of done) log(`[smoke] ${e.kind} ${e.ticker ?? ""} block ${e.block} ${e.hash ?? ""}`);
  return done;
}
