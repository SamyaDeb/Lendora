"use client";
import Image from "next/image";
import Link from "next/link";
import {usePathname} from "next/navigation";
import * as Menu from "@radix-ui/react-dropdown-menu";
import logo from "@/public/logo.png";
import {FEATURES} from "@/lib/features";
import {cn} from "@/lib/cn";
import {Icon} from "@/components/ui";
import {ConnectButton} from "./ConnectButton";
import {SessionBar} from "./SessionBar";

export const NAV = [
  {href: "/markets", label: "Markets"},
  {href: "/portfolio", label: "Portfolio"},
  ...(FEATURES.vault ? [{href: "/vault", label: "Vault"}] : []),
  {href: "/data", label: "Short interest"},
  ...(FEATURES.backstop ? [{href: "/backstop", label: "Backstop"}] : []),
  {href: "/alerts", label: "Alerts"},
];

const isActive = (path: string, href: string) => (href === "/markets" ? path === "/markets" || path.startsWith("/stock") : path.startsWith(href));

/** Sticky app header: session bar, brand (as on the landing page), navigation and wallet. */
export function Header() {
  const path = usePathname();
  return (
    <header className="sticky top-0 z-30 bg-[color-mix(in_srgb,var(--bg)_82%,transparent)] backdrop-blur-md">
      <SessionBar />
      <div className="border-b border-line">
        <div className="mx-auto flex h-16 max-w-[1320px] items-center gap-6 px-4 md:px-6">
          <Link href="/markets" className="inline-flex shrink-0 items-center gap-[9px] text-[19px] font-semibold tracking-[-0.01em]" aria-label="Lendora markets">
            <Image src={logo} alt="" width={26} height={23} priority />
            <span className="relative top-px">Lendora</span>
          </Link>
          <nav aria-label="Main" className="hidden items-center gap-1 md:flex">
            {NAV.map((n) => {
              const active = isActive(path, n.href);
              return (
                <Link
                  key={n.href}
                  href={n.href}
                  aria-current={active ? "page" : undefined}
                  className={cn("pressable rounded-full px-3.5 py-2 text-[15px]", active ? "bg-white/[0.08] text-fg shadow-[inset_0_0_0_1px_var(--border)]" : "text-dim hover:text-fg")}
                >
                  {n.label}
                </Link>
              );
            })}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <ConnectButton />
            <Menu.Root>
              <Menu.Trigger className="pressable grid size-10 place-items-center rounded-sm shadow-[inset_0_0_0_1px_var(--border-strong)] md:hidden" aria-label="Open menu">
                <Icon name="menu" size={20} />
              </Menu.Trigger>
              <Menu.Portal>
                <Menu.Content align="end" sideOffset={8} className="z-50 w-[min(92vw,280px)] rounded-sm bg-overlay p-1.5 shadow-[var(--shadow-pop),inset_0_0_0_1px_var(--border-strong)]">
                  {NAV.map((n) => (
                    <Menu.Item key={n.href} asChild>
                      <Link
                        href={n.href}
                        aria-current={isActive(path, n.href) ? "page" : undefined}
                        className="flex rounded-[7px] px-3 py-3 text-[16px] text-dim outline-none aria-[current=page]:text-fg data-[highlighted]:bg-white/[0.07]"
                      >
                        {n.label}
                      </Link>
                    </Menu.Item>
                  ))}
                </Menu.Content>
              </Menu.Portal>
            </Menu.Root>
          </div>
        </div>
      </div>
    </header>
  );
}
