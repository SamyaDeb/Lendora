"use client";
import {useState} from "react";
import {isFixtureSource} from "@/lib/vault";
import {useVaultAccount, useVaultOverview, useVaultSource, useVaultUser} from "@/lib/vault/hooks";
import {useDepositFlow} from "@/lib/vault/useDepositFlow";
import {useClaimFlow, useReadyToasts, useWithdrawFlow} from "@/lib/vault/useWithdrawFlow";
import {VaultView, type PanelMode} from "./VaultView";
import {VaultPanel} from "./VaultPanel";
import {DepositForm} from "./DepositForm";
import {WithdrawForm} from "./WithdrawForm";
import {ClaimSheet} from "./ClaimSheet";

/** `/vault` container: overview and position from the selected vault source (lib/vault), the flows for the panel. */
export function VaultScreen() {
  const source = useVaultSource();
  const o = useVaultOverview();
  const u = useVaultUser();
  const {address} = useVaultAccount();
  const [mode, setMode] = useState<PanelMode>("deposit");
  const deposit = useDepositFlow();
  const withdraw = useWithdrawFlow();
  const claim = useClaimFlow();
  useReadyToasts(address ? u.data : undefined);
  return (
    <>
      <VaultView
        o={o.data}
        u={address ? u.data : undefined}
        connected={Boolean(address)}
        error={o.isError}
        onRetry={() => o.refetch()}
        fixture={isFixtureSource(source)}
        fetchedAt={o.dataUpdatedAt}
        onMode={setMode}
        panel={<VaultPanel mode={mode} onMode={setMode} deposit={<DepositForm f={deposit} />} withdraw={<WithdrawForm f={withdraw} />} />}
        onClaim={claim.start}
        claimBusy={claim.steps.busy}
      />
      <ClaimSheet f={claim} stale={o.data?.nav.stale} />
    </>
  );
}
