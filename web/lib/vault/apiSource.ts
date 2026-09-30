import {formatUnits, maxUint256, parseUnits, type PublicClient, type WalletClient} from "viem";
import {getPublicClient, getWalletClient} from "wagmi/actions";
import {deltaNeutralVaultAbi, erc20Abi, type api} from "@lendora/sdk";
import {browserApi, serverApi} from "@/lib/api";
import {compliance} from "@/lib/compliance";
import {deployment} from "@/lib/env";
import {simulateAndSend} from "@/lib/tx";
import {wagmiConfig} from "@/lib/wagmi";
import type {VaultSource} from "./source";
import type {Attestation, DepositPreview, TxResult, VaultOverview, VaultUser, WithdrawPreview} from "./types";

type Addr = `0x${string}`;
const n = (s: string | null | undefined) => (s === null || s === undefined ? 0 : Number(s));
const nn = (s: string | null | undefined) => (s === null || s === undefined ? null : Number(s));
const usdgRaw = (x: number) => BigInt(Math.round(x * 1e6));

/** The API's overview (decimal strings) as the screens' `VaultOverview` (numbers). Exported for the view tests. */
export function overviewFromApi(r: api.VaultOverviewResponse): VaultOverview {
  const d = r.data;
  return {
    asOf: {block: r.asOfBlock, time: r.asOfTime},
    apy: {d7: nn(d.apy.d7), d30: nn(d.apy.d30), d90: nn(d.apy.d90)},
    apySeries: d.apySeries.map((p) => ({t: p.t, v: n(p.v)})),
    sharePriceSeries: d.sharePriceSeries.map((p) => ({t: p.t, v: n(p.v)})),
    split: d.split.map((s) => ({window: s.window, lending: n(s.lending), funding: n(s.funding), buffer: n(s.buffer), costs: n(s.costs)})),
    sharePrice: n(d.sharePrice),
    tvl: n(d.tvl),
    cap: n(d.cap),
    sleeves: d.sleeves.map((s) => ({symbol: s.symbol, weight: n(s.weight), cap: n(s.cap), delta: n(s.delta), marginRatio: nn(s.marginRatio), status: s.status})),
    allocation: {lent: n(d.allocation.lent), held: n(d.allocation.held), perpMargin: n(d.allocation.perpMargin), cash: n(d.allocation.cash)},
    instantCapacity: n(d.instantCapacity),
    nav: {ageSec: d.nav.ageSec, stale: d.nav.stale},
    venue: d.venue,
    killSwitch: d.killSwitch,
    lastRebalance: d.lastRebalance,
    bandPct: n(d.bandPct),
    marginTarget: n(d.marginTarget),
    marginTargetClosed: n(d.marginTargetClosed),
    marketClosed: d.marketClosed,
    depositsOpen: d.depositsOpen,
    pauseReason: d.pauseReason ?? undefined,
    contracts: d.contracts,
  };
}

/**
 * USDG Earn on the real contracts (Phase 4 task 16): history and positions from `/v1/vault/*`, balances, previews and
 * settlement dates from the chain, transactions through the connected wallet (simulated first, like every other flow),
 * and the entry gate (terms, attestation) through the same compliance proxy as borrowing. Deposits are entries;
 * withdrawals, requests and claims are exits and never ask for an attestation (CP-R4).
 */
export function createApiSource(): VaultSource {
  const vault = () => {
    const v = deployment().dnVault;
    if (!v) throw new Error("USDG Earn is not deployed on this network.");
    return v.vault;
  };
  const client = () => (typeof window === "undefined" ? serverApi() : browserApi());
  const pc = () => getPublicClient(wagmiConfig) as PublicClient;
  const read = <T>(functionName: string, args: readonly unknown[] = []) => (pc().readContract as (p: unknown) => Promise<T>)({address: vault(), abi: deltaNeutralVaultAbi, functionName, args});
  async function send(account: Addr, address: Addr, abi: readonly unknown[], functionName: string, args: readonly unknown[]): Promise<TxResult> {
    const wc = (await getWalletClient(wagmiConfig)) as WalletClient;
    const hash = await simulateAndSend(pc(), wc, account, {address, abi: abi as never, functionName, args} as never);
    return {hash};
  }

  return {
    id: "api",
    kind: "api",
    async overview() {
      return overviewFromApi(await client().vaultOverview());
    },
    async user(address): Promise<VaultUser> {
      const [acct, bal, allowance] = await Promise.all([
        client().vaultAccount(address),
        pc().readContract({address: deployment().usdg, abi: erc20Abi, functionName: "balanceOf", args: [address]}),
        pc().readContract({address: deployment().usdg, abi: erc20Abi, functionName: "allowance", args: [address, vault()]}),
      ]);
      const a = acct.data;
      // Queued requests are paid at the NAV of their settlement: until then, show them at today's share price.
      const price = n(a.shares) > 0 ? n(a.value) / n(a.shares) : Number(formatUnits(await read<bigint>("sharePrice"), 18));
      return {
        shares: n(a.shares),
        value: n(a.value),
        netDeposits: n(a.netDeposits),
        usdgBalance: Number(formatUnits(bal, 6)),
        usdgAllowance: Number(formatUnits(allowance > 10n ** 30n ? 10n ** 30n : allowance, 6)),
        requests: a.requests
          .filter((r) => r.owner.toLowerCase() === address.toLowerCase())
          .map((r) => ({id: r.id, assets: r.assets === null ? Math.round(n(r.shares) * price * 100) / 100 : n(r.assets), shares: n(r.shares), requestedAt: r.requestedAt, settlesAt: r.settlesAt, status: r.status, position: r.position})),
      };
    },
    async previewDeposit(assets): Promise<DepositPreview> {
      const [shares, price] = await Promise.all([read<bigint>("previewDeposit", [usdgRaw(assets)]), read<bigint>("sharePrice")]);
      return {shares: Number(formatUnits(shares, 18)), sharePrice: Number(formatUnits(price, 18))};
    },
    async previewWithdraw(assets): Promise<WithdrawPreview> {
      const block = await pc().getBlock();
      const [instantRaw, settleBy] = await Promise.all([read<bigint>("instantCapacity"), read<bigint>("settleByFor", [block.timestamp])]);
      const instant = Math.min(Math.max(0, assets), Number(formatUnits(instantRaw, 6)));
      const queued = Math.round((Math.max(0, assets) - instant) * 1e6) / 1e6;
      return {instant, queued, settlesAt: queued > 0 ? new Date(Number(settleBy) * 1000).toISOString() : undefined};
    },
    async terms(address) {
      const [status, t] = await Promise.all([compliance.termsStatus(address), compliance.terms(address)]);
      return {accepted: status.accepted, version: t.version, message: t.message ?? undefined};
    },
    async acceptTerms(address, signature, version) {
      await compliance.acceptTerms(address, signature, version);
    },
    async attest(address): Promise<Attestation> {
      return compliance.attest(address);
    },
    approve(address) {
      return send(address, deployment().usdg, erc20Abi, "approve", [vault(), maxUint256]);
    },
    deposit(address, assets, att) {
      return send(address, vault(), deltaNeutralVaultAbi, "deposit", [usdgRaw(assets), address, {expiry: BigInt(att.expiry), signature: att.signature}]);
    },
    async withdraw(address, assets) {
      // "Max" arrives as a float; within a cent of the exact limit, use the limit.
      const max = await read<bigint>("maxWithdraw", [address]);
      let raw = usdgRaw(assets);
      if (raw > max && raw - max <= 10_000n) raw = max;
      return send(address, vault(), deltaNeutralVaultAbi, "withdraw", [raw, address, address]);
    },
    async requestRedeem(address, shares) {
      const bal = await (pc().readContract as (p: unknown) => Promise<bigint>)({address: vault(), abi: erc20Abi, functionName: "balanceOf", args: [address]});
      let raw = parseUnits(shares.toFixed(12), 18);
      if (raw > bal || bal - raw < 10n ** 14n) raw = bal; // "all": the exact balance, no dust left behind
      const r = await send(address, vault(), deltaNeutralVaultAbi, "requestRedeem", [raw, address, address]);
      const [, tail] = await read<readonly [bigint, bigint]>("queueBounds");
      return {...r, id: String(tail - 1n)};
    },
    claim(address, id) {
      return send(address, vault(), deltaNeutralVaultAbi, "claim", [BigInt(id)]);
    },
  };
}
