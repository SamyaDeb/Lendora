"use client";
import {useVaultOverview, useVaultUser} from "@/lib/vault/hooks";
import {Button, EmptyState, Skeleton} from "@/components/ui";
import {VaultView} from "./VaultView";

/** `/vault` container: the overview and the wallet's position from the selected vault source (lib/vault). */
export function VaultScreen() {
  const o = useVaultOverview();
  const u = useVaultUser();
  if (o.data) return <VaultView v={o.data} user={u.data} />;
  if (o.isError)
    return (
      <EmptyState title="Vault data didn't load" tone="danger" icon="alert" action={<Button variant="secondary" onClick={() => o.refetch()}>Try again</Button>}>
        The vault&apos;s data source didn&apos;t respond. Your balance is unchanged.
      </EmptyState>
    );
  return <Skeleton className="block h-96 w-full" />;
}
