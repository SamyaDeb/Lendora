# Risk owner sign-off (04 acceptance, 10 launch parameters)

Sign each line (name, date) or write the change. Engineering will not propose mainnet parameters before this is complete.

| Parameter / evidence | Current value | Source | Sign-off |
|---|---|---|---|
| σ_annual SPY / NVDA / AAPL | 17% / 52% / 28% | 5y realized (WS-C, GO-NO-GO) | |
| z | 2.5 | 99.9% of 10y weekend gaps need z ≤ 2.35 | |
| B_MIN / B_MAX | 1% / 20% | OR-R8 (20% keeps the step inside Morpho's 17.29% bound) | |
| Earnings buffers NVDA / AAPL | ≥ 10% / ≥ 8% | 10y close→open gaps (D5); timing study `sim/event_timing` (Q2) | |
| LLTV | 77% | D5 | |
| Vault caps SPY / NVDA / AAPL | $1M / $1M / $250k (start at 25%) | 2% DEX depth (D8); weekday run pending | |
| Per-address caps | $75k / $250k / $35k | ≈ 25% of 2% depth | |
| Global clUSDG cap | $4M | D8 | |
| U_MAX | 90% | LM-R30 | |
| Weekday DEX depth run within ±25% of weekends | pending (first slot Mon 13:30 UTC) | WS-C §6 | |
| Event-timing study conclusion (keep release-on-round or switch to anchored) | pending | `sim/event_timing` | |
