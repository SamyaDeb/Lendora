import {notFound} from "next/navigation";
import {FEATURES} from "@/lib/features";
import {VaultScreen} from "@/components/vault/VaultScreen";

export const metadata = {title: "USDG Earn"};

/** 08 (Phase 4) behind NEXT_PUBLIC_FEATURE_VAULT. No contracts yet: runs on the fixture source (lib/vault). */
export default function VaultPage() {
  if (!FEATURES.vault) notFound();
  return <VaultScreen />;
}
