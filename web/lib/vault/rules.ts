import {num} from "@/lib/format";
import {PAUSE_COPY} from "./math";
import type {VaultOverview, VaultUser} from "./types";

/**
 * Why a deposit can't be reviewed yet, in plain words (undefined = ready). Deposits are entries (APP-R2, CP-R3):
 * blocked in restricted regions, while closed or paused, and on a stale NAV (DN-R5).
 */
export function depositBlocker(p: {connected: boolean; wrongNetwork?: boolean; restricted?: boolean; o?: VaultOverview; u?: VaultUser; assets: number; invalid?: boolean}): string | undefined {
  if (!p.connected) return "Connect a wallet to deposit.";
  if (p.wrongNetwork) return "Switch your wallet to the right network to deposit.";
  if (p.restricted) return "USDG Earn isn't available in your region. Withdrawals and claims still work from your portfolio.";
  if (!p.o) return "Loading the vault…";
  if (p.o.nav.stale) return PAUSE_COPY.nav_stale;
  if (!p.o.depositsOpen) return PAUSE_COPY[p.o.pauseReason ?? "paused"];
  if (p.invalid) return "Enter a number, like 1,000 or 12.5.";
  if (!(p.assets > 0)) return "Enter how much USDG to deposit.";
  if (p.u && p.assets > p.u.usdgBalance + 1e-9) return "That's more USDG than you hold.";
  const room = Math.max(0, p.o.cap - p.o.tvl);
  if (p.assets > room + 1e-9) return `Only ${num(room)} USDG of room is left under the vault's cap.`;
  return undefined;
}

/** Withdrawals and claims are exits (CP-R4): never blocked by region or pause, only by the amount. */
export function withdrawBlocker(p: {connected: boolean; o?: VaultOverview; u?: VaultUser; assets: number; invalid?: boolean}): string | undefined {
  if (!p.connected) return "Connect a wallet to withdraw.";
  if (!p.o || !p.u) return "Loading your balance…";
  if (p.invalid) return "Enter a number, like 1,000 or 12.5.";
  if (!(p.assets > 0)) return "Enter how much USDG to withdraw.";
  if (p.assets > p.u.value + 0.005) return "That's more than your balance in the vault.";
  return undefined;
}
