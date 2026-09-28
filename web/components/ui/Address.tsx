"use client";
import {useState} from "react";
import {explorer} from "@/lib/env";
import {short} from "@/lib/format";
import {Icon} from "./Icon";

/** Shortened address with copy and an explorer link. */
export function Address({address, kind = "address", full = false}: {address: string; kind?: "address" | "tx"; full?: boolean}) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <span className="num truncate font-mono text-[13px] text-dim" title={address}>
        {full ? address : short(address)}
      </span>
      <button
        type="button"
        className="pressable grid size-6 shrink-0 place-items-center rounded-[6px] text-muted hover:bg-white/[0.06] hover:text-fg"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(address);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            /* clipboard blocked: nothing to do */
          }
        }}
        aria-label={copied ? "Copied" : "Copy address"}
      >
        <Icon name={copied ? "check" : "copy"} size={13} className={copied ? "text-success" : undefined} />
      </button>
      {explorer && (
        <a className="grid size-6 shrink-0 place-items-center rounded-[6px] text-muted hover:bg-white/[0.06] hover:text-fg" href={`${explorer}/${kind}/${address}`} target="_blank" rel="noreferrer" aria-label="Open in explorer">
          <Icon name="external" size={13} />
        </a>
      )}
      <span className="sr-only" aria-live="polite">
        {copied ? "Address copied" : ""}
      </span>
    </span>
  );
}
