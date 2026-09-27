import {readFileSync} from "node:fs";
import {createWalletClient, http, verifyTypedData, type Hex, type PublicClient, type Chain} from "viem";
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

// ---------------------------------------------------------------------- typed data (Phase 2: compliance signer)

/** EIP-712 signer for the compliance attestations (RT-R2, CP-R3). Same rule as the tx senders: no key material in
 * code; the key comes from the environment (a secret manager), a key file, or a remote signer (KMS/HSM). */
export interface TypedDataSigner {
  readonly kind: "env-key" | "remote";
  readonly address: `0x${string}`;
  signTypedData(typedData: {domain: Record<string, unknown>; types: Record<string, readonly {name: string; type: string}[]>; primaryType: string; message: Record<string, unknown>}): Promise<Hex>;
}

/** Key from `<PREFIX>_KEY`, or read from the file named by `<PREFIX>_KEY_FILE` (never logged). */
export function envKeyTypedDataSigner(prefix: string, env: NodeJS.ProcessEnv = process.env, readFile: (p: string) => string = (p) => readFileSync(p, "utf8")): TypedDataSigner {
  const raw = env[`${prefix}_KEY`] ?? (env[`${prefix}_KEY_FILE`] ? readFile(env[`${prefix}_KEY_FILE`]!).trim() : undefined);
  if (!raw) throw new Error(`${prefix}_KEY or ${prefix}_KEY_FILE is not set`);
  const account = privateKeyToAccount(raw as Hex);
  return {
    kind: "env-key",
    address: account.address,
    signTypedData: (t) => account.signTypedData(t as Parameters<typeof account.signTypedData>[0]),
  };
}

/**
 * A remote signer (KMS/HSM bridge) reached over HTTPS: POST `{typedData}` → `{signature}`. The signature is checked
 * against the expected address before use, so a misconfigured remote cannot hand out attestations for another key.
 */
export function remoteTypedDataSigner(url: string, address: `0x${string}`, auth?: string): TypedDataSigner {
  return {
    kind: "remote",
    address,
    async signTypedData(t) {
      const body = JSON.stringify({typedData: t}, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
      const r = await fetch(url, {method: "POST", headers: {"content-type": "application/json", ...(auth ? {authorization: auth} : {})}, body});
      if (!r.ok) throw new Error(`remote signer ${r.status}`);
      const {signature} = (await r.json()) as {signature: Hex};
      const ok = await verifyTypedData({...(t as Parameters<typeof verifyTypedData>[0]), address, signature});
      if (!ok) throw new Error("remote signer returned a signature for another address");
      return signature;
    },
  };
}
