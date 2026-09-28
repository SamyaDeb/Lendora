import {notFound} from "next/navigation";
import {FEATURES} from "@/lib/features";
import {FX_VAULT} from "@/lib/fixtures";
import {VaultView} from "@/components/vault/VaultView";

export const metadata = {title: "USDG vault"};

/** 08 (Phase 4) behind NEXT_PUBLIC_FEATURE_VAULT. No contracts yet: labelled preview data, actions disabled. */
export default function VaultPage() {
  if (!FEATURES.vault) notFound();
  return <VaultView v={FX_VAULT} />;
}
