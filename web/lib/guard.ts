/** Oracle guard reasons (StocklineOracleBase bitmask) in plain language (APP-R4, OR-R33). */
const REASONS: [bigint, string][] = [
  [1n, "manual pause by the guardian"],
  [2n, "DEX price deviates from the oracle"],
  [4n, "chain block gap"],
  [8n, "stale price feed"],
  [16n, "price feed rejected by the sanity check"],
  [32n, "USDG price feed problem"],
  [64n, "issuer paused the price feed"],
  [128n, "issuer paused the Stock Token"],
  [256n, "issuer blocked the wrapper"],
  [512n, "unexpected multiplier change"],
  [1024n, "sequencer down"],
  [2048n, "market calendar needs an update"],
];

export function guardReasonList(mask: bigint): string[] {
  return REASONS.filter(([bit]) => (mask & bit) !== 0n).map(([, t]) => t);
}

export function guardReasonText(mask: bigint): string {
  const l = guardReasonList(mask);
  return l.length ? l.join(", ") : "no reason reported";
}

/** Whether exits that move the Stock Token are blocked by the issuer (A25). */
export const tokenPaused = (mask: bigint) => (mask & 128n) !== 0n;
