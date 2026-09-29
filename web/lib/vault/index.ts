import {VAULT_STATES, type VaultState} from "@/lib/fixtures";
import {createFixtureSource, type FixtureControls, type VaultSource} from "./source";
import {createApiSource} from "./apiSource";
import {deployment, E2E} from "@/lib/env";

export type {VaultSource, FixtureControls} from "./source";
export * from "./types";
export {earnings, hedgeStatus, usdgAmt, nextUsOpen, PAUSE_COPY, settleTime, splitFor, splitTotal, splitWithdraw, APY_KEY, QUEUE_HOURS} from "./math";

/** Which fixture state `/vault` runs on while there is no `apiSource` (dev and e2e can pick another). */
const envState = process.env.NEXT_PUBLIC_VAULT_FIXTURE as VaultState | undefined;
export const VAULT_FIXTURE_STATE: VaultState = envState && VAULT_STATES.includes(envState) ? envState : "open";

const cache = new Map<VaultState, VaultSource & FixtureControls>();

/** One fixture source per state in the browser (its ledger is the "chain"); a fresh read-only one on the server. */
export function fixtureSourceFor(state: VaultState): VaultSource & FixtureControls {
  if (typeof window === "undefined") return createFixtureSource(state, {delayMs: 0, persist: false});
  let s = cache.get(state);
  if (!s) cache.set(state, (s = createFixtureSource(state)));
  return s;
}

/** `NEXT_PUBLIC_VAULT_SOURCE=api|fixture`; default: the real contracts wherever the deployment has a vault. */
export const VAULT_SOURCE: "api" | "fixture" =
  process.env.NEXT_PUBLIC_VAULT_SOURCE === "fixture" || process.env.NEXT_PUBLIC_VAULT_SOURCE === "api"
    ? process.env.NEXT_PUBLIC_VAULT_SOURCE
    : deployment().dnVault
      ? "api"
      : "fixture";

let api: VaultSource | undefined;

/** Dev and e2e builds only: a tab can pin the fixture source (`sessionStorage["vault-source"] = "fixture"`), so the
 * fixture flows and the on-chain flows run against one build. Never in a production build without E2E. */
function pinnedFixture(): boolean {
  if (typeof window === "undefined" || !(E2E || process.env.NODE_ENV !== "production")) return false;
  try {
    return window.sessionStorage.getItem("vault-source") === "fixture";
  } catch {
    return false;
  }
}

/**
 * The one place the vault's data source is chosen: the real contracts through `/v1/vault/*` and the wallet
 * (`apiSource`, Phase 4 task 16), or the fixture ledger for /dev previews, tests and deployments without a vault.
 */
export function vaultSource(): VaultSource {
  if (VAULT_SOURCE === "api" && !pinnedFixture()) return (api ??= createApiSource());
  return fixtureSourceFor(VAULT_FIXTURE_STATE);
}

/** True while the vault screens run on fixtures (the page shows a "Preview" badge). */
export const isFixtureSource = (s: VaultSource) => s.kind === "fixture";
export {depositBlocker, withdrawBlocker} from "./rules";
