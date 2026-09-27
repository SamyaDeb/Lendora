import {spawn, type ChildProcess} from "node:child_process";
import {readFileSync} from "node:fs";
import {createServer} from "node:net";
import {createPublicClient, createTestClient, createWalletClient, http, type Hex, type PublicClient} from "viem";
import {anvil} from "viem/chains";
import {getDeployment, type ChainDeployment} from "@stockline/sdk";

/** Anvil loaded with the task-7 deployment (contracts/script/DeployLocal.s.sol, state in fixtures/anvil-state.hex),
 * matching `@stockline/sdk` addresses.json["31337"]. Accounts are anvil's unlocked defaults or impersonated: no keys. */
export interface Anvil {
  url: string;
  client: PublicClient;
  test: ReturnType<typeof createTestClient>;
  d: ChainDeployment;
  stop(): void;
  /** Send a tx from any address (impersonated), wait, throw on revert. */
  send(from: `0x${string}`, to: `0x${string}`, data: Hex): Promise<void>;
  setTime(ts: bigint): Promise<void>;
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

export async function startAnvil(): Promise<Anvil> {
  const port = await freePort();
  const proc: ChildProcess = spawn("anvil", ["--port", String(port), "--silent"], {stdio: "ignore"});
  const url = `http://127.0.0.1:${port}`;
  const client = createPublicClient({chain: anvil, transport: http(url)}) as PublicClient;
  // Anvil can take a while to bind under load (e.g. CI running other suites); wait up to 30 s.
  let up = false;
  for (let i = 0; i < 300 && !up; i++) {
    try {
      await client.getBlockNumber();
      up = true;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  if (!up) throw new Error(`anvil did not start on port ${port}`);
  const test = createTestClient({chain: anvil, mode: "anvil", transport: http(url)});
  const state = readFileSync(new URL("./fixtures/anvil-state.hex", import.meta.url), "utf8").trim() as Hex;
  await test.loadState({state});
  const wallet = createWalletClient({chain: anvil, transport: http(url)});
  const d = getDeployment(31337)!;
  return {
    url,
    client,
    test,
    d,
    stop: () => proc.kill(),
    async send(from, to, data) {
      await test.impersonateAccount({address: from});
      await test.setBalance({address: from, value: 10n ** 20n});
      const hash = await wallet.sendTransaction({account: from, to, data, chain: anvil});
      const r = await client.waitForTransactionReceipt({hash});
      if (r.status !== "success") throw new Error(`tx reverted ${hash}`);
    },
    async setTime(ts: bigint) {
      await test.setNextBlockTimestamp({timestamp: ts});
      await test.mine({blocks: 1});
    },
  };
}
