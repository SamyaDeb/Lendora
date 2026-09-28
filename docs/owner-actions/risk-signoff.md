# Risk owner sign-off (04 acceptance, 10 launch parameters)

Sign each line (name, date) or write the change. Engineering will not propose mainnet parameters before this is complete.

| Parameter / evidence | Current value | Source | Evidence (engineering, Phase 3 task 8) | Sign-off |
|---|---|---|---|---|
| σ_annual SPY / NVDA / AAPL | 17% / 52% / 28% | 5y realized (WS-C, GO-NO-GO) | [mainnet-params §1–2](../../sim/reports/mainnet-params.md): 5y 17.2% / 51.6% / 28.0%; 1y 13.0% / 37.6% / 24.6% (all within ±1% of launch) | |
| z | 2.5 | 99.9% of 10y weekend gaps need z ≤ 2.35 | [mainnet-params §1–2](../../sim/reports/mainnet-params.md): on 65.5h close→open data the z that covers the 99.9% up-gap in the 48h freeze is SPY 3.11 / AAPL 3.16 ⚑ / NVDA 1.80 ⚑; proposal: keep 2.5 and cover the excess with caps vs depth | |
| B_MIN / B_MAX | 1% / 20% | OR-R8 (20% keeps the step inside Morpho's 17.29% bound) | [mainnet-params §1](../../sim/reports/mainnet-params.md): unchanged | |
| Earnings buffers NVDA / AAPL | ≥ 10% / ≥ 8% | 10y close→open gaps (D5); timing study `sim/event_timing` (Q2) | [mainnet-params §5](../../sim/reports/mainnet-params.md): worst 10y print NVDA +26.1%, AAPL +7.9%; single-jump minimum 4.3% / 0%; launch buffers kept | |
| LLTV | 77% | D5 | [mainnet-params §2](../../sim/reports/mainnet-params.md): underwater gap 24.7% / 32.5% / 27.2% vs 99.9% up-gap 3.9% / 6.9% / 6.6% | |
| Vault caps SPY / NVDA / AAPL | $1M / $1M / $250k (start at 25%) | 2% DEX depth (D8) | [mainnet-params §3](../../sim/reports/mainnet-params.md): launch caps (25%) fit for all three; at the full D8 target the 99.9% $0-bad-debt cap is SPY $323k ⚑ (−68%), AAPL $147k ⚑ (−41%), NVDA not depth-bound. Not changed; decide before the first ×2 step | |
| Per-address caps | $75k / $250k / $35k | ≈ 25% of 2% depth | [mainnet-params §3](../../sim/reports/mainnet-params.md): 25% of min depth = $75.6k / **$166k ⚑ (−33%, weekday)** / $35.2k | |
| Global clUSDG cap | $4M | D8 | [mainnet-params §1](../../sim/reports/mainnet-params.md): collateral behind launch-cap borrows ≈ $657k | |
| U_MAX | 90% | LM-R30 | Input to [mainnet-params §3](../../sim/reports/mainnet-params.md) | |
| Weekday DEX depth run within ±25% of weekends | done 2026-09-28 17:02 UTC (block 74961179) | WS-C §6 | [WS-C §6](../../sim/reports/phase0-weekend-gaps.md): SPY +3% / +8%, AAPL −1% / +2%, **NVDA −47% / −37% ⚑** (push-up, both pools); rerun on 2 more weekday sessions | |
| Event-timing study conclusion (keep release-on-round or switch to anchored) | keep release-on-round (proposed) | `sim/event_timing` | [event-timing](../../sim/reports/event-timing.md): 0 of 40 NVDA / 0 of 40 AAPL prints over Morpho's bound when on time; onchain prints arrive as ≤ 1.5% steps, 2/2 on time | |
