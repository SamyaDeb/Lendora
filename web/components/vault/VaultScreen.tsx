"use client";
import {useState} from "react";
import {isFixtureSource} from "@/lib/vault";
import {useVaultAccount, useVaultOverview, useVaultSource, useVaultUser} from "@/lib/vault/hooks";
import {VaultView, type PanelMode} from "./VaultView";
import {VaultPanel} from "./VaultPanel";
import {DepositForm} from "./DepositForm";
import {useDepositFlow} from "@/lib/vault/useDepositFlow";

/** `/vault` container: overview and position from the selected vault source (lib/vault), the flows for the panel. */
export function VaultScreen() {
  const source = useVaultSource();
  const o = useVaultOverview();
  const u = useVaultUser();
  const {address} = useVaultAccount();
  const [mode, setMode] = useState<PanelMode>("deposit");
  const deposit = useDepositFlow();
  return (
    <VaultView
      o={o.data}
      u={address ? u.data : undefined}
      connected={Boolean(address)}
      error={o.isError}
      onRetry={() => o.refetch()}
      fixture={isFixtureSource(source)}
      fetchedAt={o.dataUpdatedAt}
      onMode={setMode}
      panel={<VaultPanel mode={mode} onMode={setMode} deposit={<DepositForm f={deposit} />} withdraw={<p className="text-[14px] text-muted">Withdraw form: step 5.</p>} />}
    />
  );
}
