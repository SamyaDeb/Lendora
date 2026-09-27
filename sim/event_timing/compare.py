"""OR-R14 event-buffer timing study (open decision Q2): release-on-round (built) vs an anchored buffer.

Stub: computes the instant stock move each design lets through at an earnings print, per timing case, from the 10y
daily reference data. Uses sim/data/earnings_dates.csv when present; otherwise the largest close→open gaps per year as a
labelled proxy. See sim/event_timing/README.md.

Run: sim/.venv/bin/python sim/event_timing/compare.py [--buffer NVDA=0.10 --buffer AAPL=0.08]
"""

from __future__ import annotations

import argparse
import csv
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
REF = ROOT / "sim" / "data" / "reference"
DATES = ROOT / "sim" / "data" / "earnings_dates.csv"
LLTV = 0.77
LIF = min(1.15, 1 / (0.3 * LLTV + 0.7))  # Morpho liquidation incentive factor
MORPHO_DROP = 1 - LLTV * LIF  # 17.29% instant drop of price() allowed
STOCK_UP_BOUND = 1 / (1 - MORPHO_DROP) - 1  # +20.9% stock move in one round


def daily(ticker: str) -> list[tuple[str, float, float]]:
    with (REF / f"{ticker}_daily.csv").open() as f:
        return [(r["Date"][:10], float(r["Open"]), float(r["Close"])) for r in csv.DictReader(f)]


def gaps(ticker: str) -> tuple[list[tuple[str, float]], str]:
    rows = daily(ticker)
    close_to_open = [(rows[i][0], rows[i][1] / rows[i - 1][2] - 1) for i in range(1, len(rows))]
    if DATES.exists():
        with DATES.open() as f:
            dates = {r["date"] for r in csv.DictReader(f) if r["ticker"] == ticker}
        # TODO(risk): use `session` (bmo/amc) to pick the right close→open pair; amc prints gap on the next open.
        return [g for g in close_to_open if g[0] in dates], "earnings_dates.csv"
    by_year: dict[str, list[tuple[str, float]]] = defaultdict(list)
    for d, g in close_to_open:
        by_year[d[:4]].append((d, g))
    proxy = [e for ys in by_year.values() for e in sorted(ys, key=lambda x: -abs(x[1]))[:4]]  # ~4 prints a year
    return proxy, "PROXY (largest |gap| per year)"


def moves(g: float, b: float) -> dict[str, float]:
    on_time = (1 + g) / (1 + b) - 1
    return {
        "release_on_time": on_time,
        "release_early_or_late": g,  # buffer released a round before, or the jump lands before endTs
        "anchored_any_timing": max(0.0, on_time) if g > 0 else g,
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--buffer", action="append", default=[], help="TICKER=b, e.g. NVDA=0.10")
    args = ap.parse_args()
    buffers = {"NVDA": 0.10, "AAPL": 0.08}
    buffers.update({k: float(v) for k, v in (x.split("=") for x in args.buffer)})
    print(f"Morpho bound: price() may drop {MORPHO_DROP:.2%} at once, i.e. a stock move up to +{STOCK_UP_BOUND:.1%}")
    for ticker, b in buffers.items():
        events, source = gaps(ticker)
        print(f"\n{ticker}: {len(events)} events ({source}), event buffer b = {b:.0%}")
        print(f"  largest gap: {max(g for _, g in events):+.1%} on {max(events, key=lambda e: e[1])[0]}")
        for design in ("release_on_time", "release_early_or_late", "anchored_any_timing"):
            m = [moves(g, b)[design] for _, g in events]
            breach = sum(1 for x in m if x > STOCK_UP_BOUND)
            print(f"  {design:24s} worst {max(m):+.1%}   events over the bound: {breach}/{len(m)}")
        # TODO(risk): weight release_on_time vs release_early_or_late by the measured timing-error probability.


if __name__ == "__main__":
    main()
