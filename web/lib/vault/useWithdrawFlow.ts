"use client";
import {useEffect, useRef, useState} from "react";
import {useQuery} from "@tanstack/react-query";
import type {Step} from "@/lib/tx";
import {amt, planned, useTxRunner} from "@/lib/flows/common";
import {parseAmount, useToast} from "@/components/ui";
import {withdrawBlocker} from "./rules";
import {usdgAmt} from "./math";
import type {VaultUser, WithdrawRequest} from "./types";
import {useVaultAccount, useVaultOverview, useVaultRefresh, useVaultSource, useVaultUser} from "./hooks";

/**
 * Withdraw from USDG Earn (an exit, CP-R4: never gated by region or pause). The source splits the amount: instant
 * up to the cash buffer ("Withdraw 3,000 USDG now"), the rest as a queued request ("Request 2,000 USDG").
 */
export function useWithdrawFlow() {
  const source = useVaultSource();
  const {address, pinned} = useVaultAccount();
  const oq = useVaultOverview();
  const o = oq.data;
  const u = useVaultUser().data;
  const refresh = useVaultRefresh();
  const lastHash = useRef<`0x${string}` | undefined>(undefined);
  const steps = useTxRunner("vault:withdraw", lastHash);
  const [amount, setAmount] = useState("");
  const parsed = parseAmount(amount, 6);
  const assets = parsed !== undefined ? Number(parsed) / 1e6 : 0;
  const invalid = amount.trim() !== "" && parsed === undefined;
  const all = Boolean(u && assets >= u.value - 0.005);

  const split = useQuery({queryKey: ["vault", source.id, "previewWithdraw", assets, o?.instantCapacity], queryFn: () => source.previewWithdraw(assets), enabled: assets > 0});
  const pv = assets > 0 ? split.data : undefined;
  const blocker = withdrawBlocker({connected: Boolean(address), o, u, assets, invalid}) ?? (assets > 0 && !pv ? "Working out what can be paid now…" : undefined);

  function list(): Step[] {
    if (!pv || !o) return [];
    const out: Step[] = [];
    if (pv.instant > 0) out.push({id: "withdraw", label: `Withdraw ${usdgAmt(pv.instant)} USDG now`, kind: "execute", run: async () => void (lastHash.current = (await source.withdraw(address!, pv.instant)).hash)});
    if (pv.queued > 0)
      out.push({
        id: "request",
        label: `Request ${usdgAmt(pv.queued)} USDG`,
        kind: "execute",
        run: async () => {
          const fresh = await source.user(address!);
          const shares = all ? fresh.shares : Math.min(fresh.shares, pv.queued / o.sharePrice);
          lastHash.current = (await source.requestRedeem(address!, shares)).hash;
        },
      });
    return out;
  }
  const plan = address ? planned(list()) : [];

  async function confirm() {
    if (blocker || !pv) return false;
    const now = usdgAmt(pv.instant);
    const q = usdgAmt(pv.queued);
    const copy =
      pv.queued === 0
        ? {pending: `Withdrawing ${now} USDG`, done: `Withdrew ${now} USDG`}
        : pv.instant === 0
          ? {pending: `Requesting ${q} USDG`, done: `Requested ${q} USDG`}
          : {pending: `Withdrawing ${now} USDG and requesting ${q} USDG`, done: `Withdrew ${now} USDG · ${q} USDG queued`};
    const ok = await steps.run(list(), {...copy, failed: "Couldn't withdraw"});
    await refresh();
    if (ok) setAmount("");
    return ok;
  }

  return {amount, setAmount, assets, all, invalid, o, u, pv, address, pinned, blocker, plan, steps, confirm, fetchedAt: oq.dataUpdatedAt, a: amt(amount)};
}

export type WithdrawFlow = ReturnType<typeof useWithdrawFlow>;

/** Claim a settled request: one step, "Claimed 2,000 USDG". The target is a snapshot, so the review survives the card. */
export function useClaimFlow() {
  const source = useVaultSource();
  const {address} = useVaultAccount();
  const refresh = useVaultRefresh();
  const lastHash = useRef<`0x${string}` | undefined>(undefined);
  const steps = useTxRunner("vault:claim", lastHash);
  const [target, setTarget] = useState<WithdrawRequest | null>(null);
  const [open, setOpen] = useState(false);
  const list = (): Step[] => (target ? [{id: "claim", label: `Claim ${usdgAmt(target.assets)} USDG`, kind: "execute", run: async () => void (lastHash.current = (await source.claim(address!, target.id)).hash)}] : []);
  async function confirm() {
    if (!target || !address) return false;
    const a = usdgAmt(target.assets);
    const ok = await steps.run(list(), {pending: `Claiming ${a} USDG`, done: `Claimed ${a} USDG`, failed: "Couldn't claim"});
    await refresh();
    return ok;
  }
  return {
    target,
    open,
    start: (r: WithdrawRequest) => (steps.reset(), setTarget(r), setOpen(true)),
    setOpen,
    plan: planned(list()),
    steps,
    confirm,
  };
}

export type ClaimFlow = ReturnType<typeof useClaimFlow>;

const TOASTED = "vault-ready-toasted";

/** A toast when a request becomes claimable, once per request per session. */
export function useReadyToasts(u: VaultUser | undefined) {
  const toast = useToast();
  useEffect(() => {
    if (!u) return;
    let seen: string[] = [];
    try {
      seen = JSON.parse(sessionStorage.getItem(TOASTED) ?? "[]");
    } catch {
      /* storage blocked: toast anyway */
    }
    const fresh = u.requests.filter((r) => r.status === "ready" && !seen.includes(r.id));
    if (!fresh.length) return;
    for (const r of fresh) toast.push({status: "info", title: `${usdgAmt(r.assets)} USDG is ready to claim`, body: "Claim it from USDG Earn or your portfolio."});
    try {
      sessionStorage.setItem(TOASTED, JSON.stringify([...seen, ...fresh.map((r) => r.id)]));
    } catch {
      /* ignore */
    }
  }, [u, toast]);
}
