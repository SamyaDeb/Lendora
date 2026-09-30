import {encodeFunctionData, maxUint256, type Hex} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {deltaNeutralVaultAbi, erc20Abi, navOracleAbi, type ChainDeployment} from "@lendora/sdk";
import type {Anvil} from "./anvil.js";

export type Attest = (user: `0x${string}`) => Promise<{expiry: bigint; signature: Hex}>;

/**
 * Attestations the way the app gets them: terms signed by the wallet (APP-R10), then `POST /attest` through the
 * compliance service. `base` is the path prefix: `<service>/v1/compliance` directly (with the proxy secret, env only)
 * or `<web>/api/compliance` through the web app's proxy (which adds the geo and the secret itself).
 */
export function complianceAttestationProvider(base: string, key: Hex, headers: Record<string, string> = {}): Attest {
  const account = privateKeyToAccount(key);
  return async (user) => {
    const h = {"content-type": "application/json", ...headers};
    const t = (await (await fetch(`${base}/terms?address=${user}`, {headers: h})).json()) as {version: string; message: string};
    const acc = await fetch(`${base}/terms`, {method: "POST", headers: h, body: JSON.stringify({address: user, signature: await account.signMessage({message: t.message}), version: t.version})});
    if (!acc.ok) throw new Error(`compliance terms: ${acc.status} ${(await acc.text()).slice(0, 200)}`);
    const r = await fetch(`${base}/attest`, {method: "POST", headers: h, body: JSON.stringify({address: user})});
    const j = (await r.json()) as {expiry: string; signature: Hex; error?: string};
    if (!r.ok) throw new Error(`compliance attest: ${r.status} ${j.error ?? ""}`);
    return {expiry: BigInt(j.expiry), signature: j.signature};
  };
}

export interface VaultSmokeResult {
  kind: "deposit" | "withdraw" | "requestRedeem" | "settle" | "claim" | "skip";
  note: string;
  hash?: Hex;
}

const call = (abi: readonly unknown[], functionName: string, args: readonly unknown[] = []) => (encodeFunctionData as (p: unknown) => Hex)({abi, functionName, args});

/**
 * USDG Earn by one wallet with its own USDG (faucet): attested deposit, instant withdrawal, queued request, settle
 * (permissionless; needs a fresh NAV) and claim. Skips with a reason when the vault is not deployed, its cap is 0
 * (Q11: testnet caps stay 0 unless the owner says so), or the wallet has too little USDG.
 */
export async function vaultSmoke(a: Anvil, d: ChainDeployment, me: `0x${string}`, attest: Attest, amount = 100n * 10n ** 6n): Promise<VaultSmokeResult[]> {
  const dn = d.dnVault;
  if (!dn) return [{kind: "skip", note: "no dnVault in this deployment"}];
  const rd = <T,>(address: `0x${string}`, abi: readonly unknown[], functionName: string, args: readonly unknown[] = []) => (a.client.readContract as (p: unknown) => Promise<T>)({address, abi, functionName, args});
  const cap = await rd<bigint>(dn.vault, deltaNeutralVaultAbi, "totalCap");
  if (cap === 0n) return [{kind: "skip", note: "total cap 0 (Q11): deposits refused by design; flows need an owner-approved cap"}];
  const bal = await rd<bigint>(d.usdg, erc20Abi, "balanceOf", [me]);
  if (bal < amount) return [{kind: "skip", note: `USDG balance ${bal} < ${amount}: claim the faucet first`}];
  // DN-R5: no mint on a stale NAV. On a hosted stack this means the NAV reporter is down (MON-R23, dn-nav-stale.md).
  if (!(await rd<boolean>(dn.navOracle, navOracleAbi, "fresh"))) throw new Error("NAV stale (DN-R5): is the nav-reporter running? (dn-nav-stale.md)");
  const out: VaultSmokeResult[] = [];
  const send = async (kind: VaultSmokeResult["kind"], to: `0x${string}`, data: Hex, note: string) => {
    const r = await a.send(me, to, data);
    out.push({kind, note, hash: r.transactionHash});
  };
  if ((await rd<bigint>(d.usdg, erc20Abi, "allowance", [me, dn.vault])) < amount) await a.send(me, d.usdg, call(erc20Abi, "approve", [dn.vault, maxUint256]));
  const att = await attest(me);
  await send("deposit", dn.vault, call(deltaNeutralVaultAbi, "deposit", [amount, me, att]), `${amount} USDG raw, attested`);
  await send("withdraw", dn.vault, call(deltaNeutralVaultAbi, "withdraw", [amount / 10n, me, me]), "10% instant (no attestation, CP-R4)");
  const shares = await rd<bigint>(dn.vault, erc20Abi, "balanceOf", [me]);
  await send("requestRedeem", dn.vault, call(deltaNeutralVaultAbi, "requestRedeem", [shares / 2n, me, me]), "half the shares queued");
  const [, tail] = await rd<readonly [bigint, bigint]>(dn.vault, deltaNeutralVaultAbi, "queueBounds");
  const id = tail - 1n;
  try {
    await send("settle", dn.vault, call(deltaNeutralVaultAbi, "settle", [20n]), "permissionless settle");
  } catch (e) {
    out.push({kind: "settle", note: `not settleable now (${String(e).split("\n")[0].slice(0, 120)}); the rebalancer settles it within the deadline`});
    return out;
  }
  const req = await rd<{status: number}>(dn.vault, deltaNeutralVaultAbi, "request", [id]);
  if (req.status !== 2) return [...out, {kind: "claim", note: `request ${id} not claimable yet (status ${req.status})`}];
  await send("claim", dn.vault, call(deltaNeutralVaultAbi, "claim", [id]), `request ${id}`);
  return out;
}
