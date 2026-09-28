import {VAULT_STATES, type VaultState} from "@/lib/fixtures";
import {createFixtureSource, type FixtureControls, type VaultSource} from "./source";

export type {VaultSource, FixtureControls} from "./source";
export * from "./types";
export {earnings, hedgeStatus, nextUsOpen, PAUSE_COPY, settleTime, splitFor, splitTotal, splitWithdraw, APY_KEY, QUEUE_HOURS} from "./math";

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

/**
 * The one place the vault's data source is chosen.
 * TODO(task 16): return `apiSource` (reads `/v1/vault/*` + the user's balances and requests from `DeltaNeutralVault`
 * by multicall; sends deposit / withdraw / requestRedeem / claim through `useWriter`, and the entry gate through
 * `lib/compliance`) once the contracts (task 14) and the API are deployed; keep the fixtures for /dev and tests.
 */
export function vaultSource(): VaultSource {
  return fixtureSourceFor(VAULT_FIXTURE_STATE);
}

/** True while the vault screens run on fixtures (the page shows a "Preview" badge). */
export const isFixtureSource = (s: VaultSource) => s.kind === "fixture";
