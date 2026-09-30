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

/** EIP-1559 fees for one transaction, already checked against the cap. */
export interface Fees {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

/**
 * Gas headroom over the node's estimate, for every sender. On Robinhood Chain (Arbitrum Orbit) the gas limit also pays
 * the L1 data fee, which moves before inclusion: a bare estimate ran out of gas on 46630 (326,005 of 332,112).
 */
export const GAS_HEADROOM_PCT = 30n;
const withHeadroom = (gas: bigint) => (gas * (100n + GAS_HEADROOM_PCT)) / 100n;

/** OFF-2: the node's fee estimate is above `MAX_FEE_PER_GAS_GWEI`; the tick is skipped, nothing is sent. */
export class GasPriceTooHigh extends Error {
  constructor(
    readonly maxFeePerGas: bigint,
    readonly cap: bigint,
  ) {
    super(`gas price ${maxFeePerGas} wei is above the cap ${cap} wei (MAX_FEE_PER_GAS_GWEI)`);
  }
}

/** Default remote-signer timeout (OFF-3): a hung KMS bridge fails the tick instead of stalling the keeper forever. */
export const REMOTE_SIGNER_TIMEOUT_MS = 15_000;

class ClientSender implements TxSender {
  constructor(
    readonly kind: "env-key" | "rpc-unlocked" | "remote",
    readonly address: `0x${string}`,
    private readonly sendRaw: (to: `0x${string}`, data: Hex, fees: Fees) => Promise<Hex>,
    private readonly client: PublicClient,
    private readonly maxFeePerGas?: bigint,
  ) {}
  async send(to: `0x${string}`, data: Hex, label: string): Promise<Hex> {
    // OFF-2: every transaction carries explicit fees, checked against the cap before anything is signed.
    const est = await this.client.estimateFeesPerGas();
    if (this.maxFeePerGas !== undefined && est.maxFeePerGas > this.maxFeePerGas) throw new GasPriceTooHigh(est.maxFeePerGas, this.maxFeePerGas);
    const fees = {maxFeePerGas: est.maxFeePerGas, maxPriorityFeePerGas: est.maxPriorityFeePerGas};
    const hash = await this.sendRaw(to, data, fees);
    const receipt = await this.client.waitForTransactionReceipt({hash});
    if (receipt.status !== "success") throw new Error(`${label} reverted: ${hash}${await this.replay(to, data, receipt.blockNumber)}`);
    return hash;
  }
  /** Why a mined transaction reverted: the same call on the block before (automine / one tx per block: exact). */
  private async replay(to: `0x${string}`, data: Hex, block: bigint): Promise<string> {
    try {
      await this.client.call({account: this.address, to, data, blockNumber: block - 1n});
      return " (the replay on the previous block succeeds: the state or the timestamp changed in between)";
    } catch (e) {
      const m = e instanceof Error ? ((e as {shortMessage?: string}).shortMessage ?? e.message) : String(e);
      return ` (${m.split("\n")[0].slice(0, 200)})`;
    }
  }
}

/** Account unlocked on the node (anvil `anvil_impersonateAccount` or default accounts). Tests only. */
export function rpcUnlockedSender(client: PublicClient, rpcUrl: string, chain: Chain, address: `0x${string}`, maxFeePerGas?: bigint): TxSender {
  const wallet = createWalletClient({chain, transport: http(rpcUrl)});
  return new ClientSender("rpc-unlocked", address, async (to, data, fees) => wallet.sendTransaction({account: address, to, data, chain, ...fees, gas: withHeadroom(await client.estimateGas({account: address, to, data}))}), client, maxFeePerGas);
}

/** Key from `KEEPER_PRIVATE_KEY` (a secret manager should inject it). */
export function envKeySender(client: PublicClient, rpcUrl: string, chain: Chain, env: NodeJS.ProcessEnv = process.env, maxFeePerGas?: bigint): TxSender {
  const pk = env.KEEPER_PRIVATE_KEY as Hex | undefined;
  if (!pk) throw new Error("KEEPER_PRIVATE_KEY is not set");
  const account = privateKeyToAccount(pk);
  const wallet = createWalletClient({account, chain, transport: http(rpcUrl)});
  return new ClientSender("env-key", account.address, async (to, data, fees) => wallet.sendTransaction({account, to, data, chain, ...fees, gas: withHeadroom(await client.estimateGas({account, to, data}))}), client, maxFeePerGas);
}

/**
 * A remote transaction signer (KMS/HSM bridge) over HTTPS: POST `{chainId, transaction}` (an unsigned EIP-1559
 * transaction, hex-serialized) → `{signedTransaction}`. The keeper builds the transaction (nonce from the node's
 * `pending` count, fees and gas from the node) and only accepts a signed transaction that recovers to the expected
 * address **and** has the same chain, nonce, recipient, value and calldata, so a misconfigured or compromised remote
 * cannot swap the payload or sign with another key. No key material in this process.
 */
export function remoteTxSender(
  client: PublicClient,
  chain: Chain,
  url: string,
  address: `0x${string}`,
  auth?: string,
  fetchImpl: typeof fetch = fetch,
  opts: {maxFeePerGas?: bigint; timeoutMs?: number} = {},
): TxSender {
  const sendRaw = async (to: `0x${string}`, data: Hex, fees: Fees): Promise<Hex> => {
    const [nonce, gas] = await Promise.all([client.getTransactionCount({address, blockTag: "pending"}), client.estimateGas({account: address, to, data})]);
    const unsigned: TransactionSerializableEIP1559 = {type: "eip1559", chainId: chain.id, nonce, to, data, value: 0n, gas: withHeadroom(gas), maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas};
    const r = await fetchImpl(url, {
      method: "POST",
      headers: {"content-type": "application/json", ...(auth ? {authorization: auth} : {})},
      body: JSON.stringify({chainId: chain.id, transaction: serializeTransaction(unsigned)}),
      signal: AbortSignal.timeout(opts.timeoutMs ?? REMOTE_SIGNER_TIMEOUT_MS), // OFF-3
    });
    if (!r.ok) throw new Error(`remote signer ${r.status}`);
    const {signedTransaction} = (await r.json()) as {signedTransaction: Hex};
    const tx = parseTransaction(signedTransaction);
    const signer = await recoverTransactionAddress({serializedTransaction: signedTransaction as never});
    if (signer.toLowerCase() !== address.toLowerCase()) throw new Error("remote signer signed with another key");
    if (
      tx.chainId !== chain.id ||
      tx.nonce !== nonce ||
      tx.to?.toLowerCase() !== to.toLowerCase() ||
      (tx.value ?? 0n) !== 0n ||
      tx.data !== data ||
      (tx.maxFeePerGas ?? 0n) > fees.maxFeePerGas || // OFF-2: the remote cannot raise the fee past what the keeper checked
      (tx.gas ?? 0n) > unsigned.gas!
    ) {
      throw new Error("remote signer returned a different transaction");
    }
    return client.sendRawTransaction({serializedTransaction: signedTransaction});
  };
  return new ClientSender("remote", address, sendRaw, client, opts.maxFeePerGas);
}

/** The sender a keeper's config asks for: dry run (default), env key, remote signer, or anvil-unlocked (tests). */
/**
 * The sender a keeper's config asks for: dry run (default), env key, remote signer, or anvil-unlocked (tests). Every
 * signing keeper's `main.ts` goes through this (OFF-4: before, four of them built their own sender and silently ran
 * dry with `KEEPER_SIGNER=remote`). `roleAddress` is the deployment's role for this keeper, used for dry runs and the
 * anvil-unlocked account when `KEEPER_ADDRESS` is unset.
 */
export function senderFromConfig(
  cfg: {
    signer: "dry-run" | "env-key" | "rpc-unlocked" | "remote";
    rpcUrl: string;
    unlockedAddress?: `0x${string}`;
    remoteSignerUrl?: string;
    remoteSignerAuth?: string;
    maxFeePerGasWei?: bigint;
    remoteSignerTimeoutMs?: number;
  },
  client: PublicClient,
  chain: Chain,
  env: NodeJS.ProcessEnv = process.env,
  roleAddress?: `0x${string}`,
): TxSender {
  const cap = cfg.maxFeePerGasWei;
  switch (cfg.signer) {
    case "env-key":
      return envKeySender(client, cfg.rpcUrl, chain, env, cap);
    case "rpc-unlocked": {
      const a = cfg.unlockedAddress ?? roleAddress;
      if (!a) throw new Error("KEEPER_SIGNER=rpc-unlocked needs KEEPER_ADDRESS");
      return rpcUnlockedSender(client, cfg.rpcUrl, chain, a, cap);
    }
    case "remote":
      if (!cfg.remoteSignerUrl || !cfg.unlockedAddress) throw new Error("KEEPER_SIGNER=remote needs KEEPER_REMOTE_SIGNER_URL and KEEPER_ADDRESS");
      return remoteTxSender(client, chain, cfg.remoteSignerUrl, cfg.unlockedAddress, cfg.remoteSignerAuth, fetch, {maxFeePerGas: cap, timeoutMs: cfg.remoteSignerTimeoutMs});
    default:
      return new DryRunSender(cfg.unlockedAddress ?? roleAddress);
  }
}

// ---------------------------------------------------------------------- typed data (Phase 2: compliance signer)

/** EIP-712 signer for the compliance attestations (RT-R2, CP-R3). Same rule as the tx senders: no key material in
 * code; the key comes from the environment (a secret manager), a key file, or a remote signer (KMS/HSM). */
export interface TypedDataSigner {
  readonly kind: "env-key" | "remote" | "rpc-unlocked";
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
export function remoteTypedDataSigner(url: string, address: `0x${string}`, auth?: string, fetchImpl: typeof fetch = fetch, timeoutMs = REMOTE_SIGNER_TIMEOUT_MS): TypedDataSigner {
  return {
    kind: "remote",
    address,
    async signTypedData(t) {
      const body = JSON.stringify({typedData: t}, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
      const r = await fetchImpl(url, {method: "POST", headers: {"content-type": "application/json", ...(auth ? {authorization: auth} : {})}, body, signal: AbortSignal.timeout(timeoutMs)}); // OFF-3
      if (!r.ok) throw new Error(`remote signer ${r.status}`);
      const {signature} = (await r.json()) as {signature: Hex};
      const ok = await verifyTypedData({...(t as Parameters<typeof verifyTypedData>[0]), address, signature});
      if (!ok) throw new Error("remote signer returned a signature for another address");
      return signature;
    },
  };
}

/** An account unlocked on the node (anvil's dev accounts) signs through `eth_signTypedData_v4`. Anvil and tests only:
 * refused on any other chain id. */
export function rpcUnlockedTypedDataSigner(rpcUrl: string, address: `0x${string}`, chainId: number): TypedDataSigner {
  if (chainId !== 31337) throw new Error("rpc-unlocked typed-data signing is for anvil (31337) only");
  const wallet = createWalletClient({transport: http(rpcUrl)});
  return {
    kind: "rpc-unlocked",
    address,
    signTypedData: (t) => wallet.signTypedData({account: address, ...(t as Omit<Parameters<typeof wallet.signTypedData>[0], "account">)}),
  };
}

/** The typed-data signer a service's env asks for: `<PREFIX>_SIGNER=env-key|remote|rpc-unlocked`, with
 * `<PREFIX>_KEY`/`_KEY_FILE`, `<PREFIX>_REMOTE_URL` + `<PREFIX>_ADDRESS` (+ `_REMOTE_AUTH`), or `<PREFIX>_ADDRESS`. */
export function typedDataSignerFromEnv(prefix: string, env: NodeJS.ProcessEnv, rpcUrl: string, chainId: number): TypedDataSigner {
  const kind = env[`${prefix}_SIGNER`] ?? "env-key";
  const address = env[`${prefix}_ADDRESS`] as `0x${string}` | undefined;
  switch (kind) {
    case "env-key":
      return envKeyTypedDataSigner(prefix, env);
    case "remote":
      if (!env[`${prefix}_REMOTE_URL`] || !address) throw new Error(`${prefix}_SIGNER=remote needs ${prefix}_REMOTE_URL and ${prefix}_ADDRESS`);
      return remoteTypedDataSigner(env[`${prefix}_REMOTE_URL`]!, address, env[`${prefix}_REMOTE_AUTH`]);
    case "rpc-unlocked":
      if (!address) throw new Error(`${prefix}_SIGNER=rpc-unlocked needs ${prefix}_ADDRESS`);
      return rpcUnlockedTypedDataSigner(rpcUrl, address, chainId);
    default:
      throw new Error(`${prefix}_SIGNER must be env-key, remote or rpc-unlocked (got "${kind}")`);
  }
}
