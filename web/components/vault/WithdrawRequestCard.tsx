import type {WithdrawRequest} from "@/lib/vault";
import {et, num} from "@/lib/format";
import {cn} from "@/lib/cn";
import {Badge, Button, CountdownBadge} from "@/components/ui";

const STATUS = {
  queued: {label: "Queued", tone: "accent", icon: "clock"},
  ready: {label: "Ready to claim", tone: "supply", icon: "check"},
  claimed: {label: "Claimed", tone: "neutral", icon: "check"},
} as const;

/**
 * One withdrawal request (DN-R1 queue): amount, status in words, time left on chain time, queue position and Claim.
 * Claiming is an exit (CP-R4): never gated by region or pause.
 */
export function WithdrawRequestCard({r, asOf, fetchedAt, onClaim, busy, className}: {r: WithdrawRequest; asOf?: string; fetchedAt?: number; onClaim?: (r: WithdrawRequest) => void; busy?: boolean; className?: string}) {
  const s = STATUS[r.status];
  return (
    <article className={cn("flex flex-col gap-3 rounded-sm bg-sunken p-4 shadow-[inset_0_0_0_1px_var(--border)]", r.status === "ready" && "shadow-[inset_0_0_0_1px_rgba(89,217,122,0.4)]", className)} data-testid={`request-${r.id}`} data-status={r.status} aria-label={`Withdrawal request, ${num(r.assets)} USDG, ${s.label}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="num text-[17px] font-medium">{num(r.assets)} USDG</p>
        <Badge tone={s.tone} icon={s.icon}>
          {s.label}
        </Badge>
      </div>
      {r.status === "queued" && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px] text-muted">
          <CountdownBadge to={r.settlesAt} asOf={asOf} fetchedAt={fetchedAt} dueLabel="Settling" data-testid="request-countdown" />
          <span>
            Paid by <span className="text-dim">{et(Date.parse(r.settlesAt) / 1000)}</span>
          </span>
          <span className="num">#{r.position} in the queue</span>
        </div>
      )}
      {r.status === "ready" && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-[13px] text-muted">Settled {et(Date.parse(r.settlesAt) / 1000)}. The USDG is waiting for you.</p>
          {onClaim && (
            <Button variant="supply" size="sm" className="max-md:h-11 max-md:px-4" disabled={busy} onClick={() => onClaim(r)} data-testid={`claim-${r.id}`}>
              Claim {num(r.assets)} USDG
            </Button>
          )}
        </div>
      )}
      {r.status === "claimed" && <p className="text-[13px] text-muted">Paid to your wallet.</p>}
    </article>
  );
}
