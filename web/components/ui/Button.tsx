import Link from "next/link";
import type {ButtonHTMLAttributes, ReactNode} from "react";
import {cn} from "@/lib/cn";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "supply" | "borrow" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const VARIANT: Record<ButtonVariant, string> = {
  // Landing "Trade now": hero blue fill, white text (6.4:1)
  primary: "bg-accent-strong text-fg hover:brightness-110 shadow-[0_8px_24px_rgba(40,24,150,0.35)]",
  // Landing tabs / "Explore more": faint glass with a hairline
  secondary: "bg-white/[0.05] text-fg shadow-[inset_0_0_0_1px_var(--border-strong)] hover:bg-white/[0.09]",
  ghost: "bg-transparent text-dim hover:text-fg hover:bg-white/[0.06]",
  // Semantic actions: tinted fill + colored text so meaning survives without color (the label says the verb)
  supply: "bg-supply text-[#0b0a18] hover:brightness-105",
  borrow: "bg-borrow text-[#0b0a18] hover:brightness-105",
  danger: "bg-danger-soft text-danger shadow-[inset_0_0_0_1px_rgba(255,122,134,0.4)] hover:bg-danger/20",
};
const SIZE: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-[13px] rounded-xs gap-1.5",
  md: "h-10 px-4 text-[15px] rounded-sm gap-2",
  lg: "h-12 px-6 text-base rounded-sm gap-2",
};

export function buttonClass(variant: ButtonVariant = "primary", size: ButtonSize = "md", className?: string) {
  return cn(
    "pressable inline-flex select-none items-center justify-center whitespace-nowrap font-medium tracking-[-0.01em]",
    "disabled:cursor-not-allowed disabled:opacity-45 disabled:shadow-none disabled:hover:brightness-100",
    VARIANT[variant],
    SIZE[size],
    className,
  );
}

export function Button({variant, size, className, type = "button", ...rest}: {variant?: ButtonVariant; size?: ButtonSize} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type={type} className={buttonClass(variant, size, className)} {...rest} />;
}

export function ButtonLink({href, variant, size, className, children, ...rest}: {href: string; variant?: ButtonVariant; size?: ButtonSize; className?: string; children: ReactNode; "data-testid"?: string; "aria-label"?: string}) {
  return (
    <Link href={href} className={buttonClass(variant, size, className)} {...rest}>
      {children}
    </Link>
  );
}
