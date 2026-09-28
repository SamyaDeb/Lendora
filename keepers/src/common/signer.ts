import {readFileSync} from "node:fs";
import {createWalletClient, http, parseTransaction, recoverTransactionAddress, serializeTransaction, verifyTypedData, type Hex, type PublicClient, type Chain, type TransactionSerializableEIP1559} from "viem";
import {privateKeyToAccount} from "viem/accounts";

/** Sends keeper transactions. Implementations: dry run (default), a key from the environment, or an unlocked RPC
 * account (anvil tests). No key material lives in code. */
export interface TxSender {
  readonly kind: "dry-run" | "env-key" | "rpc-unlocked" | "remote";
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
    readonly kind: "env-key" | "rpc-unlocked" | "remote",
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

/**
 * A remote transaction signer (KMS/HSM bridge) over HTTPS: POST `{chainId, transaction}` (an unsigned EIP-1559
 * transaction, hex-serialized) → `{signedTransaction}`. The keeper builds the transaction (nonce from the node's
 * `pending` count, fees and gas from the node) and only accepts a signed transaction that recovers to the expected
 * address **and** has the same chain, nonce, recipient, value and calldata, so a misconfigured or compromised remote
 * cannot swap the payload or sign with another key. No key material in this process.
 */
export function remoteTxSender(client: PublicClient, chain: Chain, url: string, address: `0x${string}`, auth?: string, fetchImpl: typeof fetch = fetch): TxSender {
  const sendRaw = async (to: `0x${string}`, data: Hex): Promise<Hex> => {
    const [nonce, fees, gas] = await Promise.all([
      client.getTransactionCount({address, blockTag: "pending"}),
      client.estimateFeesPerGas(),
      client.estimateGas({account: address, to, data}),
    ]);
    const unsigned: TransactionSerializableEIP1559 = {type: "eip1559", chainId: chain.id, nonce, to, data, value: 0n, gas: (gas * 12n) / 10n, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas};
    const r = await fetchImpl(url, {method: "POST", headers: {"content-type": "application/json", ...(auth ? {authorization: auth} : {})}, body: JSON.stringify({chainId: chain.id, transaction: serializeTransaction(unsigned)})});
    if (!r.ok) throw new Error(`remote signer ${r.status}`);
    const {signedTransaction} = (await r.json()) as {signedTransaction: Hex};
    const tx = parseTransaction(signedTransaction);
    const signer = await recoverTransactionAddress({serializedTransaction: signedTransaction as never});
    if (signer.toLowerCase() !== address.toLowerCase()) throw new Error("remote signer signed with another key");
    if (tx.chainId !== chain.id || tx.nonce !== nonce || tx.to?.toLowerCase() !== to.toLowerCase() || (tx.value ?? 0n) !== 0n || tx.data !== data) {
      throw new Error("remote signer returned a different transaction");
    }
    return client.sendRawTransaction({serializedTransaction: signedTransaction});
  };
  return new ClientSender("remote", address, sendRaw, client);
}

/** The sender a keeper's config asks for: dry run (default), env key, remote signer, or anvil-unlocked (tests). */
export function senderFromConfig(
  cfg: {signer: "dry-run" | "env-key" | "rpc-unlocked" | "remote"; rpcUrl: string; unlockedAddress?: `0x${string}`; remoteSignerUrl?: string; remoteSignerAuth?: string},
  client: PublicClient,
  chain: Chain,
  env: NodeJS.ProcessEnv = process.env,
): TxSender {
  switch (cfg.signer) {
    case "env-key":
      return envKeySender(client, cfg.rpcUrl, chain, env);
    case "rpc-unlocked":
      return rpcUnlockedSender(client, cfg.rpcUrl, chain, cfg.unlockedAddress!);
    case "remote":
      if (!cfg.remoteSignerUrl || !cfg.unlockedAddress) throw new Error("KEEPER_SIGNER=remote needs KEEPER_REMOTE_SIGNER_URL and KEEPER_ADDRESS");
      return remoteTxSender(client, chain, cfg.remoteSignerUrl, cfg.unlockedAddress, cfg.remoteSignerAuth);
    default:
      return new DryRunSender(cfg.unlockedAddress);
  }
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
