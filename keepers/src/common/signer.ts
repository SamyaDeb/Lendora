import {createWalletClient, http, type Hex, type PublicClient, type Chain} from "viem";
import {privateKeyToAccount} from "viem/accounts";

/** Sends keeper transactions. Implementations: dry run (default), a key from the environment, or an unlocked RPC
 * account (anvil tests). No key material lives in code. */
export interface TxSender {
  readonly kind: "dry-run" | "env-key" | "rpc-unlocked";
  readonly address: `0x${string}` | undefined;
  /** Returns the tx hash, or undefined in dry-run mode. Waits for the receipt and throws if it reverted. */
  send(to: `0x${string}`, data: Hex, label: string): Promise<Hex | undefined>;
}

export class DryRunSender implements TxSender {
  readonly kind = "dry-run" as const;
  readonly sent: {to: string; data: Hex; label: string}[] = [];
  constructor(readonly address: `0x${string}` | undefined = undefined, private log: (m: string) => void = console.log) {}
  async send(to: `0x${string}`, data: Hex, label: string): Promise<undefined> {
    this.sent.push({to, data, label});
    this.log(`[dry-run] ${label} -> ${to}`);
    return undefined;
  }
}

class ClientSender implements TxSender {
  constructor(
    readonly kind: "env-key" | "rpc-unlocked",
    readonly address: `0x${string}`,
    private readonly sendRaw: (to: `0x${string}`, data: Hex) => Promise<Hex>,
    private readonly client: PublicClient,
  ) {}
  async send(to: `0x${string}`, data: Hex, label: string): Promise<Hex> {
    const hash = await this.sendRaw(to, data);
    const receipt = await this.client.waitForTransactionReceipt({hash});
    if (receipt.status !== "success") throw new Error(`${label} reverted: ${hash}`);
    return hash;
  }
}

/** Account unlocked on the node (anvil `anvil_impersonateAccount` or default accounts). Tests only. */
export function rpcUnlockedSender(client: PublicClient, rpcUrl: string, chain: Chain, address: `0x${string}`): TxSender {
  const wallet = createWalletClient({chain, transport: http(rpcUrl)});
  return new ClientSender("rpc-unlocked", address, (to, data) => wallet.sendTransaction({account: address, to, data, chain}), client);
}

/** Key from `KEEPER_PRIVATE_KEY` (a secret manager should inject it). */
export function envKeySender(client: PublicClient, rpcUrl: string, chain: Chain, env: NodeJS.ProcessEnv = process.env): TxSender {
  const pk = env.KEEPER_PRIVATE_KEY as Hex | undefined;
  if (!pk) throw new Error("KEEPER_PRIVATE_KEY is not set");
  const account = privateKeyToAccount(pk);
  const wallet = createWalletClient({account, chain, transport: http(rpcUrl)});
  return new ClientSender("env-key", account.address, (to, data) => wallet.sendTransaction({account, to, data, chain}), client);
}
