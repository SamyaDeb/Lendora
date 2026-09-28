# Sim task · Event-buffer timing (OR-R14, open decision Q2)

**Status: done (Phase 3 task 8, 2026-09-28): keep release-on-round; report [event-timing.md](../reports/event-timing.md). Risk owner to confirm.** Originally a stub (remediation 2026-09-27). The launch design stays as built: the event buffer is released on the first
good round with `updatedAt ≥ endTs` (OR-R14). Before mainnet parameters are proposed, the risk owner runs this study
to decide whether to switch to the anchored design. **The contracts are unchanged.**

## Question

A single-stock earnings print can move the stock more than Morpho's instant-drop bound (1 − LLTV·LIF = 17.29% at
LLTV 77%, i.e. a stock move above +20.9% in one round; NVDA's largest 10y close→open gap was +26.2%, D5). Which design
keeps the move in `price()` inside the bound across realistic **timing errors** of `endTs`?

| Design | During the window | Timing sensitivity |
|---|---|---|
| **Release-on-round** (built) | `P_eff = P_feed · (1 + b)`; `b` released on the first round with `updatedAt ≥ endTs` | `endTs` too **early** (a pre-print round releases) or too **late** (the jump round arrives before `endTs`, buffer released one round later): the jump hits unbuffered |
| **Anchored** (proposal) | `P_eff = max(P_feed, P_pre · (1 + b))`, `P_pre` stored when the window starts | The jump moves `price()` by `P_new / (P_pre·(1+b))` whatever the print time; costs one stored price per window and a new oracle deployment (new Morpho markets) |

## Method

For each earnings event `e` with pre-print price `P_pre` and first post-print price `P_new` (gap `g = P_new/P_pre − 1`),
buffer `b` (NVDA ≥ 10%, AAPL ≥ 8%, D5) and timing error `δ ∈ {early, on time, late}`:

- release-on-round: on time → instant stock move `(1+g)/(1+b) − 1`; early or late → `g`;
- anchored: `max(0, (1+g)/(1+b) − 1)` in every case (downward gaps only lower `price()`'s loan value: safe side).

Report, per stock and design, the share of events whose instant move exceeds +20.9% (Morpho bound) and the worst move,
for `δ` probabilities from the calendar's history (how often the confirmed print time differed from the scheduled
`endTs`, A10).

## Inputs

- `sim/data/reference/<TICKER>_daily.csv` (10y daily, Phase 0) for close→open gaps.
- `sim/data/earnings_dates.csv` (**to be provided by risk**: `ticker,date,session` with `session ∈ {bmo, amc}`), so the
  gap is measured on the right close→open pair. Without it, the script uses the largest |close→open| gaps per year as a
  labelled **proxy** (earnings days dominate the tail for single stocks), which is enough to size the question, not to
  decide it.
- Later: 1h data around each print (`*_1h.csv`, from 2023) for the intraday path, to model when the jump round lands
  relative to `endTs`.

## Run

```sh
sim/.venv/bin/python sim/event_timing/compare.py            # → sim/reports/event-timing.md
sim/.venv/bin/python sim/event_timing/compare.py --buffer NVDA=0.10 --buffer AAPL=0.08
```

## Done (Phase 3 task 8)

1. `sim/data/earnings_dates.csv`: 80 prints (NVDA, AAPL, 2016-10 → 2026-08) from Yahoo (`get_earnings_dates`,
   research use); every one is after the close (`amc`).
2. Timing error: the two prints inside the onchain history (AAPL 2026-07-30 16:30 ET, NVDA 2026-08-26 16:20 ET) were
   on time (first post-print round 34–36 s after `endTs`); the single-jump table is shown for p_err 0–50%.
3. Instead of the 1h path, the onchain Chainlink rounds at the two prints show the real path: ≤ 1.5% steps.
   Recommendation: keep release-on-round ([event-timing.md](../reports/event-timing.md)).
