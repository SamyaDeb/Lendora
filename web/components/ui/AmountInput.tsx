"use client";
import {useId, type ReactNode} from "react";
import {formatUnits, parseUnits} from "viem";
import {cn} from "@/lib/cn";
import {num} from "@/lib/format";
import {AssetIcon} from "./AssetIcon";

export function parseAmount(s: string, decimals: number): bigint | undefined {
  if (!/^\d*\.?\d*$/.test(s.trim()) || s.trim() === "" || s.trim() === ".") return undefined;
  try {
    return parseUnits(s.trim(), decimals);
  } catch {
    return undefined;
  }
}

/**
 * Amount field: token tile, MAX, balance, live USD value and inline validation. `max` is what the action allows
 * (balance, withdrawable…), labelled by `maxLabel`. `error` overrides the built-in messages.
 */
export function AmountInput(p: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  decimals: number;
  unit: string;
  unitKind?: "stock" | "receipt" | "usd";
  max?: bigint;
  maxLabel?: string;
  usdPrice?: number;
  testId?: string;
  hint?: ReactNode;
  error?: string;
  disabled?: boolean;
}) {
  const id = useId();
  const parsed = parseAmount(p.value, p.decimals);
  const over = parsed !== undefined && p.max !== undefined && parsed > p.max;
  const bad = p.value !== "" && parsed === undefined;
  const error = p.error ?? (bad ? "Enter a number, like 12.5." : over ? `That's more than your ${(p.maxLabel ?? "balance").toLowerCase()}.` : undefined);
  const usd = parsed !== undefined && p.usdPrice ? Number(formatUnits(parsed, p.decimals)) * p.usdPrice : undefined;
  const maxText = p.max !== undefined ? Number(formatUnits(p.max, p.decimals)).toLocaleString("en-US", {maximumFractionDigits: 4}) : undefined;
  const describedBy = [p.hint ? `${id}-hint` : "", error ? `${id}-err` : ""].filter(Boolean).join(" ") || undefined;
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-[13px] font-medium text-dim">
          {p.label}
        </label>
        {maxText !== undefined && (
          <span className="num text-[12.5px] text-muted">
            {p.maxLabel ?? "Balance"} {maxText} {p.unit}
          </span>
        )}
      </div>
      <div
        className={cn(
          "flex items-center gap-3 rounded-xs bg-sunken px-3 py-2.5 shadow-[inset_0_0_0_1px_var(--border)] transition-shadow focus-within:shadow-[inset_0_0_0_1px_var(--accent)]",
          error && "shadow-[inset_0_0_0_1px_var(--danger)] focus-within:shadow-[inset_0_0_0_1px_var(--danger)]",
          p.disabled && "opacity-50",
        )}
      >
        <AssetIcon ticker={p.unit} size="sm" kind={p.unitKind ?? (p.unit === "USDG" ? "usd" : p.unit.startsWith("r") ? "receipt" : "stock")} />
        <div className="min-w-0 flex-1">
          <input
            id={id}
            className="num no-spin w-full bg-transparent text-xl font-medium outline-none placeholder:text-white/30 focus-visible:outline-none"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            value={p.value}
            disabled={p.disabled}
            onChange={(e) => p.onChange(e.target.value.replace(",", "."))}
            aria-invalid={Boolean(error)}
            aria-describedby={describedBy}
            data-testid={p.testId}
          />
          <p className="num h-4 text-[12px] text-muted" aria-live="polite">
            {usd !== undefined ? `≈ $${num(usd)}` : ""}
          </p>
        </div>
        <span className="text-[14px] font-medium text-dim">{p.unit}</span>
        {p.max !== undefined && (
          <button
            type="button"
            className="pressable h-7 rounded-[6px] bg-accent-soft px-2.5 text-[12px] font-semibold text-accent-text hover:bg-accent/25 disabled:opacity-40"
            onClick={() => p.onChange(formatUnits(p.max!, p.decimals))}
            disabled={p.disabled || p.max === 0n}
            aria-label={`Use max: ${maxText} ${p.unit}`}
          >
            Max
          </button>
        )}
      </div>
      {error ? (
        <p id={`${id}-err`} className="text-[12.5px] text-danger" role="alert">
          {error}
        </p>
      ) : (
        p.hint && (
          <p id={`${id}-hint`} className="text-[12.5px] text-muted">
            {p.hint}
          </p>
        )
      )}
    </div>
  );
}
