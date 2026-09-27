"use client";
import {useId} from "react";
import {formatUnits, parseUnits} from "viem";

export function parseAmount(s: string, decimals: number): bigint | undefined {
  if (!/^\d*\.?\d*$/.test(s.trim()) || s.trim() === "" || s.trim() === ".") return undefined;
  try {
    return parseUnits(s.trim(), decimals);
  } catch {
    return undefined;
  }
}

export function AmountInput(p: {label: string; value: string; onChange: (v: string) => void; decimals: number; unit: string; max?: bigint; testId?: string; hint?: string}) {
  const id = useId();
  const parsed = parseAmount(p.value, p.decimals);
  const over = parsed !== undefined && p.max !== undefined && parsed > p.max;
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="flex justify-between text-sm font-medium">
        <span>{p.label}</span>
        {p.max !== undefined && (
          <button type="button" className="text-xs underline" onClick={() => p.onChange(formatUnits(p.max!, p.decimals))}>
            Max {Number(formatUnits(p.max, p.decimals)).toLocaleString("en-US", {maximumFractionDigits: 4})}
          </button>
        )}
      </label>
      <div className="flex items-center gap-2">
        <input
          id={id}
          className="input num"
          inputMode="decimal"
          autoComplete="off"
          placeholder="0.0"
          value={p.value}
          onChange={(e) => p.onChange(e.target.value.replace(",", "."))}
          aria-invalid={over || (p.value !== "" && parsed === undefined)}
          aria-describedby={p.hint ? `${id}-hint` : undefined}
          data-testid={p.testId}
        />
        <span className="w-14 text-sm font-semibold">{p.unit}</span>
      </div>
      {p.hint && (
        <p id={`${id}-hint`} className="text-xs text-[var(--color-muted)]">
          {p.hint}
        </p>
      )}
      {over && <p className="text-xs text-[var(--color-danger)]">More than available.</p>}
    </div>
  );
}
