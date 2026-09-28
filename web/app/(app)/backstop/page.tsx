import {notFound} from "next/navigation";
import {FEATURES} from "@/lib/features";
import {BackstopScreen} from "@/components/backstop/BackstopScreen";

export const metadata = {title: "Backstop"};

/** 09 §2 (Phase 5) behind NEXT_PUBLIC_FEATURE_BACKSTOP. No contracts yet: labelled preview data, actions disabled. */
export default function BackstopPage() {
  if (!FEATURES.backstop) notFound();
  return <BackstopScreen />;
}
