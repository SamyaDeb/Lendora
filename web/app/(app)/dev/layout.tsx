import {notFound} from "next/navigation";
import {devPagesEnabled} from "@/lib/network";

/** Dev-only pages (component gallery, page previews on mock data). Off in production unless NEXT_PUBLIC_DEV_PAGES=1,
 * and never on mainnet (MN-R6). */
export default function DevLayout({children}: {children: React.ReactNode}) {
  if (!devPagesEnabled(process.env)) notFound();
  return children;
}
