import {spawn, spawnSync, type ChildProcess} from "node:child_process";
import {readFileSync} from "node:fs";
import {createServer} from "node:net";
import {fileURLToPath} from "node:url";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  decodeErrorResult,
  http,
  type Hex,
  type PublicClient,
  type TestClient,
  type TransactionReceipt,
  type WalletClient,
} from "viem";
import {anvil} from "viem/chains";
import {
  collateralTokenAbi,
  getDeployment,
  mockSwapAggregatorAbi,
  morphoAbi,
  stocklineOracleAbi,
  stocklineRouterAbi,
  stockWrapperAbi,
  vaultV2FullAbi,
  type ChainDeployment,
} from "@stockline/sdk";

/** The DeployLocal state (contracts/script/DeployLocal.s.sol), matching `@stockline/sdk` addresses.json["31337"].
 * Regenerate with `pnpm --filter @stockline/devnet state:dump` after changing the deployment. */
export const FIXTURE_STATE = fileURLToPath(new URL("../fixtures/anvil-state.hex", import.meta.url));
export const CONTRACTS_DIR = fileURLToPath(new URL("../../../contracts", import.meta.url));
/** Anvil's first default account: the DeployLocal deployer and the mocks' admin. Address only; anvil holds the key. */
export const DEPLOYER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;

/** A connection to an anvil node with the Stockline deployment. Every tx is sent from an impersonated or unlocked
 * account: no key material. */
export interface Anvil {
  url: string;
  client: PublicClient;
  test: TestClient<"anvil">;
  wallet: WalletClient;
  d: ChainDeployment;
  /** Kills the node if this process started it. */
  stop(): void;
  /** Send a tx from any address (impersonated, funded with ETH), wait, throw on revert. */
  send(from: `0x${string}`, to: `0x${string}`, data: Hex): Promise<TransactionReceipt>;
  /** Mine one block at `ts`. */
  setTime(ts: bigint): Promise<void>;
}

export async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, () => {
      const port = (s.address() as {port: number}).port;
      s.close(() => resolve(port));
    });
  });
}

function clients(url: string) {
  // viem polls receipts every 4 s by default; on automining anvil a receipt that is not ready on the first read then
  // costs a full interval per tx (the Phase 1 guard-keeper flake, fixed in Phase 2 task 0).
  const client = createPublicClient({chain: anvil, transport: http(url), pollingInterval: 50, cacheTime: 0}) as PublicClient;
  const test = createTestClient({chain: anvil, mode: "anvil", transport: http(url), pollingInterval: 50});
  const wallet = createWalletClient({chain: anvil, transport: http(url), pollingInterval: 50});
  return {client, test, wallet};
}

async function waitUp(client: PublicClient, what: string): Promise<void> {
  // Anvil can take a while to bind under load (e.g. CI running other suites); wait up to 30 s.
  for (let i = 0; i < 300; i++) {
    try {
      await client.getBlockNumber();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`anvil did not start (${what})`);
}

/** Wrap an existing node (e.g. the docker-compose anvil or `scripts/dev.sh`). */
export async function connectAnvil(url: string, stop: () => void = () => {}): Promise<Anvil> {
  const {client, test, wallet} = clients(url);
  await waitUp(client, url);
  const d = getDeployment(31337);
  if (!d) throw new Error("no 31337 deployment in @stockline/sdk addresses.json");
  return {
    url,
    client,
    test,
    wallet,
    d,
    stop,
    async send(from, to, data) {
      await test.impersonateAccount({address: from});
      await test.setBalance({address: from, value: 10n ** 20n});
      // Gas is estimated on a pending block whose timestamp can be one second off the mined one; interest accrual
      // (Morpho, Vault V2) then runs extra code, so estimates alone make sends flaky. Anvil gas is free: add headroom.
      const estimate = await client.estimateGas({account: from, to, data}).catch(() => 5_000_000n);
      const hash = await wallet.sendTransaction({account: from, to, data, chain: anvil, gas: (estimate * 3n) / 2n + 100_000n});
      const r = await client.waitForTransactionReceipt({hash});
      if (r.status !== "success") throw new Error(`tx reverted ${hash}: ${await revertReason(client, from, to, data)}`);
      return r;
    },
    async setTime(ts: bigint) {
      await test.setNextBlockTimestamp({timestamp: ts});
      await test.mine({blocks: 1});
    },
  };
}

const decodeAbis = [stocklineRouterAbi, morphoAbi, stocklineOracleAbi, vaultV2FullAbi, stockWrapperAbi, collateralTokenAbi, mockSwapAggregatorAbi];

/** Replays a reverted call (state is unchanged by a revert) and decodes the error against Stockline ABIs. */
export async function revertReason(client: PublicClient, from: `0x${string}`, to: `0x${string}`, data: Hex): Promise<string> {
  try {
    await client.call({account: from, to, data});
    return "(no revert on replay)";
  } catch (e) {
    const raw = (e as {data?: Hex; cause?: {data?: Hex}}).cause?.data ?? (e as {data?: Hex}).data;
    if (raw && raw.length >= 10) {
      for (const abi of decodeAbis) {
        try {
          const d = decodeErrorResult({abi: abi as never, data: raw});
          return `${d.errorName}(${(d.args ?? []).map(String).join(", ")})`;
        } catch {
          /* try the next ABI */
        }
      }
    }
    return (e as Error).message.split("\n")[0];
  }
}

export interface StartOptions {
  port?: number;
  /** "fixture" (default): load `FIXTURE_STATE`. "deploy": run `forge script DeployLocal` (slow, ~300 txs). "empty". */
  state?: "fixture" | "deploy" | "empty";
  /** Extra anvil flags, e.g. ["--block-time", "1"]. */
  args?: string[];
}

/** Start anvil with the Stockline deployment. Without an explicit port, anvil binds port 0 and we read the port it
 * chose from its output: picking a "free" port first races when suites run in parallel (`pnpm -r test`), and a
 * suite could end up talking to another suite's chain. */
export async function startAnvil(opts: StartOptions = {}): Promise<Anvil> {
  const proc: ChildProcess = spawn("anvil", ["--port", String(opts.port ?? 0), ...(opts.args ?? [])], {stdio: ["ignore", "pipe", "ignore"]});
  const port = await new Promise<number>((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error(`anvil did not report a port: ${buf.slice(-500)}`)), 30_000);
    proc.stdout!.on("data", (d: Buffer) => {
      buf += d.toString();
      const m = /Listening on [\d.]+:(\d+)/.exec(buf);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    proc.on("exit", (code) => reject(new Error(`anvil exited (${code}): ${buf.slice(-500)}`)));
  });
  proc.stdout!.resume(); // keep draining so anvil never blocks on a full pipe
  const url = `http://127.0.0.1:${port}`;
  const a = await connectAnvil(url, () => proc.kill());
  const state = opts.state ?? "fixture";
  if (state === "fixture") await loadFixture(a);
  else if (state === "deploy") deployLocal(url);
  return a;
}

export async function loadFixture(a: Anvil, path = FIXTURE_STATE): Promise<void> {
  const state = readFileSync(path, "utf8").trim() as Hex;
  await a.test.loadState({state});
}

/** `forge script DeployLocal` against `rpcUrl` from anvil's unlocked deployer (writes addresses.json["31337"]). */
export function deployLocal(rpcUrl: string): void {
  const r = spawnSync(
    "forge",
    ["script", "script/DeployLocal.s.sol", "--rpc-url", rpcUrl, "--broadcast", "--slow", "--unlocked", "--sender", DEPLOYER],
    {cwd: CONTRACTS_DIR, stdio: "inherit"},
  );
  if (r.status !== 0) throw new Error("DeployLocal failed");
}
