"use client";
import {useRef, useState} from "react";
import {useQuery} from "@tanstack/react-query";
import {useSignMessage} from "wagmi";
import type {Step} from "@/lib/tx";
import {amt, planned, useTxRunner} from "@/lib/flows/common";
import {useRestricted} from "@/app/(app)/providers";
import {useWrongNetwork} from "@/components/shell/ConnectButton";
import {parseAmount} from "@/components/ui";
import {depositBlocker} from "./rules";
import type {Attestation} from "./types";
import {useVaultAccount, useVaultOverview, useVaultRefresh, useVaultSource, useVaultUser} from "./hooks";

/** A signature a pinned preview wallet "makes" (there is no wallet behind it; the fixture only checks the shape). */
const PREVIEW_SIGNATURE = `0x${"00".repeat(65)}` as const;

/**
 * Deposit USDG into USDG Earn: an entry, shaped like useBorrowFlow (approve USDG → accept terms, a signature with no
 * gas, first time only → compliance check → deposit). Blocked with the reason in restricted regions, while deposits
 * are closed or paused, and on a stale NAV.
 */
export function useDepositFlow() {
  const source = useVaultSource();
  const {address, pinned} = useVaultAccount();
  const o = useVaultOverview().data;
  const u = useVaultUser().data;
  const restricted = useRestricted();
  const wrong = useWrongNetwork() && !pinned;
  const refresh = useVaultRefresh();
  const {signMessageAsync} = useSignMessage();
  const lastHash = useRef<`0x${string}` | undefined>(undefined);
  const steps = useTxRunner("vault:deposit", lastHash);
  const [amount, setAmount] = useState("");
  const parsed = parseAmount(amount, 6);
  const assets = parsed !== undefined ? Number(parsed) / 1e6 : 0;
  const invalid = amount.trim() !== "" && parsed === undefined;

  const preview = useQuery({queryKey: ["vault", source.id, "previewDeposit", assets], queryFn: () => source.previewDeposit(assets), enabled: assets > 0});
  const terms = useQuery({queryKey: ["vault", source.id, "terms", address ?? null], queryFn: () => source.terms(address!), enabled: Boolean(address)});

  const blocker = depositBlocker({connected: Boolean(address), wrongNetwork: wrong, restricted, o, u, assets, invalid});

  function list(): Step[] {
    let att: Attestation | undefined;
    return [
      {id: "approve", label: "Approve USDG", kind: "approve", skip: u ? u.usdgAllowance >= assets : false, run: async () => void (lastHash.current = (await source.approve(address!, assets)).hash)},
      {
        id: "terms",
        label: "Accept the terms and risk disclosure (signature, no gas)",
        kind: "sign",
        skip: terms.data?.accepted,
        run: async () => {
          const t = await source.terms(address!);
          if (t.accepted) return;
          const signature = pinned ? PREVIEW_SIGNATURE : await signMessageAsync({message: t.message!});
          await source.acceptTerms(address!, signature, t.version);
        },
      },
      {id: "attest", label: "Compliance check (region, sanctions)", kind: "attest", run: async () => void (att = await source.attest(address!))},
      {id: "deposit", label: `Deposit ${amt(amount)} USDG`, kind: "execute", run: async () => void (lastHash.current = (await source.deposit(address!, assets, att!)).hash)},
    ];
  }
  const plan = address && assets > 0 ? planned(list()) : [];

  async function confirm() {
    if (blocker) return false;
    const a = amt(amount);
    const ok = await steps.run(list(), {pending: `Depositing ${a} USDG`, done: `Deposited ${a} USDG`, failed: "Couldn't deposit", doneBody: "Your shares are in your position."});
    await refresh();
    if (ok) setAmount("");
    return ok;
  }

  return {amount, setAmount, assets, invalid, o, u, preview: preview.data, address, pinned, blocker, plan, steps, confirm};
}

export type DepositFlow = ReturnType<typeof useDepositFlow>;
