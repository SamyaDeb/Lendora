import {test as base, expect, type BrowserContext, type Page} from "@playwright/test";
import {createPublicClient, createWalletClient, getAddress, hexToString, http, isAddress, parseEther, type Hex, type PublicClient, type TransactionReceipt, type WalletClient} from "viem";
import {generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount} from "viem/accounts";
import {chainFor, getDeployment} from "@lendora/sdk";

/**
 * A browser wallet that really signs, on Robinhood Chain testnet (46630) only. The page gets an EIP-1193 provider
 * (window.ethereum and an EIP-6963 announcement) whose signing methods are forwarded to this node process through
 * `__lendoraSign`: the key stays here, the page only ever receives signatures and transaction hashes.
 *
 * Guards: a send while the wallet is on any chain but 46630 is refused and recorded as a violation (the test fails at
 * teardown); so is a send to an address outside the 46630 deployment (router, tokens, vaults, faucet, Morpho, the DN
 * vault) and the wallet's own accounts. Edge-case controls: rejectNext(method), setChain(id), delay(ms), disconnect(),
 * useAccount(i).
 */
export const TESTNET = 46630;
export const RPC = "https://rpc.testnet.chain.robinhood.com";
const chain = chainFor(TESTNET, RPC);
const d = getDeployment(TESTNET)!;

/** Every contract address in addresses.json["46630"] (nested objects included), lower-cased. */
function deploymentAddresses(): Set<string> {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === "string" && isAddress(v)) out.add(v.toLowerCase());
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(d);
  return out;
}

export interface WalletRequest {
  t: number;
  method: string;
  chainId: number;
  account: `0x${string}`;
  outcome: "ok" | "rejected" | "refused" | "error";
  to?: `0x${string}`;
  hash?: Hex;
  note?: string;
}

export interface GasRecord {
  hash: Hex;
  to?: `0x${string}`;
  label: string;
  gasLimit: bigint;
  gasUsed?: bigint;
  status?: TransactionReceipt["status"];
}

type RpcError = {code: number; message: string};
type Reply = {result: unknown} | {error: RpcError};

const SIGNING = new Set(["eth_requestAccounts", "wallet_requestPermissions", "wallet_switchEthereumChain", "wallet_addEthereumChain", "eth_sendTransaction", "personal_sign", "eth_sign", "eth_signTypedData_v4"]);

export class TestnetWallet {
  readonly pc: PublicClient;
  readonly accounts: PrivateKeyAccount[];
  private wcs: WalletClient[];
  private active = 0;
  private chainId = TESTNET;
  private connected = false;
  private rejects = new Map<string, number>();
  private delayMs = 0;
  private allowed: Set<string>;
  private sendLock: Promise<unknown> = Promise.resolve();
  private nonces = new Map<string, number>();
  readonly log: WalletRequest[] = [];
  readonly violations: string[] = [];
  readonly gas: GasRecord[] = [];
  /** personal_sign messages, decoded (what the user reads in the wallet). */
  readonly messages: string[] = [];
  /** Called right after each send is broadcast (reload-mid-flow tests). */
  onSend?: (hash: Hex) => void | Promise<void>;
  /** Label for the next sends' gas records (set by the test before each row). */
  label = "";
  private ctx?: BrowserContext;

  constructor(key: Hex, extraKeys: Hex[] = []) {
    this.pc = createPublicClient({chain, transport: http(RPC)}) as PublicClient;
    this.accounts = [privateKeyToAccount(key), ...extraKeys.map((k) => privateKeyToAccount(k))];
    this.wcs = this.accounts.map((account) => createWalletClient({account, chain, transport: http(RPC)}));
    this.allowed = deploymentAddresses();
    for (const a of this.accounts) this.allowed.add(a.address.toLowerCase());
  }

  /** A throwaway account (fresh key, kept in memory only) the wallet can switch to with `useAccount`. */
  static throwawayKey(): Hex {
    return generatePrivateKey();
  }

  get address(): `0x${string}` {
    return this.accounts[this.active].address;
  }
  get currentChain() {
    return this.chainId;
  }
  get isConnected() {
    return this.connected;
  }
  /** Transaction hashes the page sent (in order). */
  get sends() {
    return this.log.filter((r) => r.method === "eth_sendTransaction" && r.outcome === "ok");
  }

  async install(ctx: BrowserContext) {
    this.ctx = ctx;
    await ctx.exposeFunction("__lendoraSign", (method: string, params: unknown) => this.handle(method, params as unknown[]));
    await ctx.addInitScript(PAGE_PROVIDER);
  }

  // ---- controls -------------------------------------------------------------------------------------------------
  /** The next request of this method fails with EIP-1193 4001 (user rejected). */
  rejectNext(method: string, times = 1) {
    this.rejects.set(method, (this.rejects.get(method) ?? 0) + times);
  }
  /** Every signing request waits this long before it is answered (a slow wallet). */
  delay(ms: number) {
    this.delayMs = ms;
  }
  /** The wallet moves to another chain on its own (as when the user switches in the extension). */
  async setChain(id: number) {
    this.chainId = id;
    await this.emit("chainChanged", `0x${id.toString(16)}`);
  }
  /** The wallet disconnects the site. */
  async disconnect() {
    this.connected = false;
    await this.emit("accountsChanged", []);
  }
  /** The user switches to another account in the wallet. */
  async useAccount(i: number) {
    this.active = i;
    if (this.connected) await this.emit("accountsChanged", [this.address]);
  }
  /** Connected without a prompt (as a wallet that already trusts the site). */
  preconnect() {
    this.connected = true;
  }

  private async emit(event: string, arg: unknown) {
    for (const p of this.ctx?.pages() ?? []) await p.evaluate(([e, a]) => (window as unknown as {__lendoraEmit?: (e: string, a: unknown) => void}).__lendoraEmit?.(e, a), [event, arg] as const).catch(() => {});
  }

  // ---- the node side of the provider ----------------------------------------------------------------------------
  private record(r: Omit<WalletRequest, "t" | "chainId" | "account">) {
    this.log.push({t: Date.now(), chainId: this.chainId, account: this.address, ...r});
  }

  private rejected(method: string): boolean {
    const n = this.rejects.get(method) ?? 0;
    if (n <= 0) return false;
    this.rejects.set(method, n - 1);
    return true;
  }

  async handle(method: string, params: unknown[] = []): Promise<Reply> {
    if (SIGNING.has(method) && this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (SIGNING.has(method) && this.rejected(method)) {
      this.record({method, outcome: "rejected"});
      return {error: {code: 4001, message: "User rejected the request."}};
    }
    try {
      switch (method) {
        case "eth_chainId":
          return {result: `0x${this.chainId.toString(16)}`};
        case "net_version":
          return {result: String(this.chainId)};
        case "eth_accounts":
          return {result: this.connected ? [this.address] : []};
        case "eth_requestAccounts":
          this.connected = true;
          this.record({method, outcome: "ok"});
          return {result: [this.address]};
        case "wallet_requestPermissions":
          this.connected = true;
          this.record({method, outcome: "ok"});
          return {result: [{parentCapability: "eth_accounts", caveats: [{type: "restrictReturnedAccounts", value: [this.address]}]}]};
        case "wallet_getPermissions":
          return {result: this.connected ? [{parentCapability: "eth_accounts", caveats: [{type: "restrictReturnedAccounts", value: [this.address]}]}] : []};
        case "wallet_revokePermissions":
          this.connected = false;
          return {result: null};
        case "wallet_switchEthereumChain":
        case "wallet_addEthereumChain": {
          const id = Number(BigInt((params[0] as {chainId: string}).chainId));
          if (id !== TESTNET) {
            this.record({method, outcome: "refused", note: `chain ${id}`});
            return {error: {code: 4902, message: `Unrecognized chain ${id}`}};
          }
          this.chainId = id;
          this.record({method, outcome: "ok"});
          await this.emit("chainChanged", `0x${id.toString(16)}`);
          return {result: null};
        }
        case "personal_sign": {
          const [msg, from] = params as [Hex, string];
          this.assertFrom(from);
          const sig = await this.accounts[this.active].signMessage({message: {raw: msg}});
          this.messages.push(hexToString(msg));
          this.record({method, outcome: "ok"});
          return {result: sig};
        }
        case "eth_signTypedData_v4": {
          const [from, json] = params as [string, string];
          this.assertFrom(from);
          const td = typeof json === "string" ? JSON.parse(json) : json;
          const types = {...td.types};
          delete types.EIP712Domain;
          const sig = await this.accounts[this.active].signTypedData({domain: td.domain, types, primaryType: td.primaryType, message: td.message});
          this.record({method, outcome: "ok"});
          return {result: sig};
        }
        case "eth_sendTransaction":
          return await this.send(params[0] as {from: string; to?: string; data?: Hex; value?: Hex; gas?: Hex});
        case "eth_sign":
          this.record({method, outcome: "refused"});
          return {error: {code: 4200, message: "eth_sign is not supported"}};
        default: {
          // Reads: straight to the 46630 RPC.
          const r = (await (await fetch(RPC, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({jsonrpc: "2.0", id: 1, method, params})})).json()) as {result?: unknown; error?: RpcError};
          return r.error ? {error: r.error} : {result: r.result};
        }
      }
    } catch (e) {
      this.record({method, outcome: "error", note: String((e as Error).message).split("\n")[0]});
      return {error: {code: (e as {code?: number}).code ?? -32603, message: String((e as Error).message).split("\n")[0]}};
    }
  }

  /** Like MetaMask: a request for an account the site can't use now is EIP-1193 4100 (unauthorized). */
  private assertFrom(from: string) {
    if (!this.connected || getAddress(from) !== this.address) throw Object.assign(new Error("The requested account and/or method has not been authorized by the user."), {code: 4100});
  }

  private async send(tx: {from: string; to?: string; data?: Hex; value?: Hex; gas?: Hex; chainId?: Hex}): Promise<Reply> {
    const to = tx.to ? (getAddress(tx.to) as `0x${string}`) : undefined;
    // As a real wallet: a transaction built for 46630 while the wallet sits on another chain is refused (not the
    // app's fault: it asked for 46630). One with no chain id, or another one, while off 46630 is a violation.
    if (this.chainId !== TESTNET && tx.chainId !== undefined && Number(BigInt(tx.chainId)) === TESTNET) {
      this.record({method: "eth_sendTransaction", outcome: "refused", to, note: `built for 46630, wallet on ${this.chainId}`});
      return {error: {code: 4901, message: `The wallet is on chain ${this.chainId}, not Robinhood Chain Testnet.`}};
    }
    if (this.chainId !== TESTNET || (tx.chainId !== undefined && Number(BigInt(tx.chainId)) !== TESTNET)) {
      const v = `send on chain ${this.chainId} (to ${to})`;
      this.violations.push(v);
      this.record({method: "eth_sendTransaction", outcome: "refused", to, note: v});
      return {error: {code: 4901, message: "The wallet is not on Robinhood Chain Testnet."}};
    }
    if (!to || !this.allowed.has(to.toLowerCase())) {
      const v = `send to ${to ?? "(contract creation)"}, outside addresses.json["46630"]`;
      this.violations.push(v);
      this.record({method: "eth_sendTransaction", outcome: "refused", to, note: v});
      return {error: {code: 4100, message: "Refused: recipient not in the testnet deployment."}};
    }
    this.assertFrom(tx.from);
    // One send at a time, so each gets its own nonce (a double-click shows as two sends in the log, not a nonce clash).
    const run = async () => {
      const wc = this.wcs[this.active];
      const acct = this.accounts[this.active];
      const gas = tx.gas ? BigInt(tx.gas) : undefined;
      // Nonces are tracked here, as a wallet does: the public RPC is load-balanced and can report a stale pending
      // nonce right after a send. Resynced from the chain after a nonce error.
      const send = async () => {
        const chainNonce = await this.pc.getTransactionCount({address: acct.address, blockTag: "pending"});
        const nonce = Math.max(chainNonce, this.nonces.get(acct.address) ?? 0);
        const h = await wc.sendTransaction({account: acct, chain, to, data: tx.data, value: tx.value ? BigInt(tx.value) : undefined, gas, nonce});
        this.nonces.set(acct.address, nonce + 1);
        return h;
      };
      const hash = await send().catch(async (e) => {
        if (!/nonce/i.test(String((e as Error).message))) throw e;
        this.nonces.delete(acct.address);
        await new Promise((r) => setTimeout(r, 1500));
        return send();
      });
      const rec: GasRecord = {hash, to, label: this.label, gasLimit: gas ?? 0n};
      this.gas.push(rec);
      void this.pc
        .waitForTransactionReceipt({hash, pollingInterval: 500, timeout: 120_000})
        .then((r) => {
          rec.gasUsed = r.gasUsed;
          rec.status = r.status;
          if (!gas) rec.gasLimit = r.gasUsed; // unknown limit (the app didn't set one): recorded as used
        })
        .catch(() => {});
      this.record({method: "eth_sendTransaction", outcome: "ok", to, hash});
      if (this.onSend) void Promise.resolve(this.onSend(hash)).catch(() => {});
      return hash;
    };
    const p = this.sendLock.then(run, run);
    this.sendLock = p.catch(() => {});
    return {result: await p};
  }

  /** The tester (account 0) sends ETH to account i from node (funding a throwaway; not a page action). */
  async fund(i: number, eth: string) {
    const hash = await this.wcs[0].sendTransaction({account: this.accounts[0], chain, to: this.accounts[i].address, value: parseEther(eth)});
    await this.pc.waitForTransactionReceipt({hash});
    return hash;
  }

  /** Sends account i's ETH back to the tester, less the fee (a throwaway leaves nothing behind). */
  async sweep(i: number) {
    const a = this.accounts[i];
    const balance = await this.pc.getBalance({address: a.address});
    const gasPrice = await this.pc.getGasPrice();
    const fee = 21_000n * gasPrice * 3n; // the limit also covers the L1 data fee on Orbit; the rest is refunded
    if (balance <= fee * 2n) return;
    const hash = await this.wcs[i].sendTransaction({account: a, chain, to: this.accounts[0].address, value: balance - fee * 2n, gas: 100_000n});
    await this.pc.waitForTransactionReceipt({hash});
  }

  /** Gas records whose limit is under 1.3 × used (T1). */
  lowHeadroom() {
    return this.gas.filter((g) => g.gasUsed !== undefined && g.gasLimit * 10n < g.gasUsed * 13n);
  }
}

/**
 * The page side: an EIP-1193 provider whose every request goes to node through `__lendoraSign`; errors keep their
 * EIP-1193 code (4001 user rejected…). Events come back through `__lendoraEmit`.
 */
const PAGE_PROVIDER = `(() => {
  if (window.__lendoraWallet) return;
  const listeners = {};
  const provider = {
    isMetaMask: false,
    isLendoraTest: true,
    async request({method, params}) {
      const r = await window.__lendoraSign(method, params ?? []);
      if (r && r.error) { const e = new Error(r.error.message); e.code = r.error.code; throw e; }
      return r.result;
    },
    on(e, f) { (listeners[e] ||= new Set()).add(f); return provider; },
    removeListener(e, f) { listeners[e]?.delete(f); return provider; },
    off(e, f) { return provider.removeListener(e, f); },
  };
  window.__lendoraEmit = (e, a) => { for (const f of listeners[e] ?? []) { try { f(a); } catch {} } };
  window.__lendoraWallet = provider;
  Object.defineProperty(window, "ethereum", {value: provider, configurable: true, writable: false});
  const info = {uuid: "5b0e1c52-6b32-4c69-9d25-4c1e2d0a4630", name: "Lendora Test Wallet", rdns: "xyz.lendora.testwallet",
    icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxIDEiPjxyZWN0IHdpZHRoPSIxIiBoZWlnaHQ9IjEiIGZpbGw9IiM4ZDdmZjIiLz48L3N2Zz4="};
  const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", {detail: Object.freeze({info, provider})}));
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
})();`;

/** Refuses to run without TESTNET_GO=yes and SMOKE_KEY (the tester key, from the environment only). */
export function testnetKey(): Hex {
  if (process.env.TESTNET_GO !== "yes") throw new Error("TESTNET_GO=yes is required (this suite sends real transactions on 46630).");
  const k = process.env.SMOKE_KEY;
  if (!k || !/^0x[0-9a-fA-F]{64}$/.test(k)) throw new Error("SMOKE_KEY (the 46630 tester key) is required.");
  return k as Hex;
}

/** Playwright fixtures: one wallet and one page per worker (the suite is serial). */
export const test = base.extend<object, {wallet: TestnetWallet; ctx: BrowserContext; app: Page}>({
  wallet: [
    // eslint-disable-next-line no-empty-pattern -- Playwright fixtures take their dependencies as a destructured object
    async ({}, use) => {
      const w = new TestnetWallet(testnetKey(), [TestnetWallet.throwawayKey()]);
      await use(w);
      expect(w.violations, "the app tried a send the wallet refused").toEqual([]);
    },
    {scope: "worker"},
  ],
  ctx: [
    async ({browser, wallet}, use) => {
      const ctx = await browser.newContext({baseURL: "http://127.0.0.1:3000", viewport: {width: 1280, height: 900}});
      await wallet.install(ctx);
      // A returning visitor: the first-visit welcome modal was dismissed before (it has its own check in the spec).
      await ctx.addInitScript(() => {
        try {
          localStorage.setItem("lendora.onboarded.v1", "1");
        } catch {
          /* storage blocked: the modal shows, and the spec closes it */
        }
      });
      await use(ctx);
      await ctx.close();
    },
    {scope: "worker"},
  ],
  app: [
    async ({ctx}, use) => {
      await use(await ctx.newPage());
    },
    {scope: "worker"},
  ],
});
export {expect};
