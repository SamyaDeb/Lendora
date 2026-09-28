import {notFound} from "next/navigation";

/** Dev-only pages (component gallery, page previews on mock data). Off in production unless NEXT_PUBLIC_DEV_PAGES=1. */
export default function DevLayout({children}: {children: React.ReactNode}) {
  if (process.env.NODE_ENV === "production" && process.env.NEXT_PUBLIC_DEV_PAGES !== "1") notFound();
  return children;
}
