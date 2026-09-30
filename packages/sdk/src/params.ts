/**
 * Launch constants mirrored from the contracts and the deploy script (docs/prd/10-risk-compliance.md). Changing one
 * means a contract or deployment change first; the SDK only mirrors.
 */

/** `LendoraRouter.HF_MIN_OPEN` (RT-R1). */
export const HF_MIN_OPEN_WAD = 11n * 10n ** 17n;
/** `LendoraRouter.HORIZON`: the RT-R1 health check looks 24h ahead. */
export const OPEN_HORIZON_SEC = 24n * 3600n;
/** Utilization cap `U_MAX` (Vault V2 relative cap, allocator, LM-R23 / LM-R30). */
export const U_MAX_WAD = 9n * 10n ** 17n;
/** Vault V2 performance fee at launch (10%, → FeeSplitter). */
export const PERFORMANCE_FEE_WAD = 10n ** 17n;
/** Morpho price scale exponent of the launch markets: 36 + 18 (wSTOCK) − 6 (clUSDG) + 8 − 8 (feeds). */
export const STOCK_LOAN_SCALE_EXP = 48n;
/** `clUSDG.valuePerToken()` for the USDG-backed v1 (CL-R4). */
export const CLUSDG_VALUE_PER_TOKEN = 10n ** 18n;
/** Feed decimals of the Robinhood Chain Stock Token and USDG/USD feeds (01-chain-facts §4). */
export const FEED_DECIMALS = 8;
/** Health-factor color bands (APP-R6): ≥ 1.5 green, 1.1–1.5 amber, < 1.1 red; liquidation at 1.0. */
export const HF_GREEN_WAD = 15n * 10n ** 17n;
export const HF_AMBER_WAD = 11n * 10n ** 17n;
