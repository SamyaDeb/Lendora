"use client";
import Link from "next/link";
import {usePathname} from "next/navigation";
import {ConnectButton} from "./ConnectButton";

const NAV = [
  {href: "/", label: "Markets"},
  {href: "/short-interest", label: "Short interest"},
  {href: "/portfolio", label: "Portfolio"},
  {href: "/alerts", label: "Alerts"},
];

export function Header() {
  const path = usePathname();
  return (
    <header className="border-b border-[var(--color-line)] bg-[var(--color-surface)]">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-3 px-4 py-3">
        <Link href="/" className="mr-2 text-lg font-bold tracking-tight">
          Stockline
        </Link>
        <nav aria-label="Main" className="order-3 flex w-full gap-1 overflow-x-auto sm:order-none sm:w-auto">
          {NAV.map((n) => {
            const active = n.href === "/" ? path === "/" : path.startsWith(n.href);
            return (
              <Link
                key={n.href}
                href={n.href}
                aria-current={active ? "page" : undefined}
                className={`whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium ${active ? "bg-[var(--color-info-bg)]" : "text-[var(--color-muted)] hover:text-[var(--color-ink)]"}`}
              >
                {n.label}
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto">
          <ConnectButton />
        </div>
      </div>
    </header>
  );
}
