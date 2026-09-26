"""WS-C.3: reference share prices for SPY, NVDA, AAPL.

Source: Yahoo Finance via `yfinance` (unofficial API; Yahoo's terms allow personal, non-commercial use, so these files
are research inputs only and are not redistributed in the product). Daily adjusted closes cover ≥ 5 years for
σ_annual; hourly bars (incl. pre/post market) cover the last ~730 days, which Yahoo caps.

Output: sim/data/reference/<SYM>_daily.csv, <SYM>_1h.csv (UTC index).
Run: sim/.venv/bin/python sim/phase0/fetch_reference.py
"""

from __future__ import annotations

from rpc import ROOT

import yfinance as yf

OUT = ROOT / "sim" / "data" / "reference"
SYMBOLS = ["SPY", "NVDA", "AAPL"]


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for s in SYMBOLS:
        t = yf.Ticker(s)
        d = t.history(period="10y", interval="1d", auto_adjust=False, actions=True)
        d.index = d.index.tz_convert("UTC")
        d.to_csv(OUT / f"{s}_daily.csv")
        h = t.history(period="730d", interval="1h", prepost=True, auto_adjust=False)
        h.index = h.index.tz_convert("UTC")
        h.to_csv(OUT / f"{s}_1h.csv")
        print(s, "daily", len(d), d.index[0].date(), "→", d.index[-1].date(), "| 1h", len(h))


if __name__ == "__main__":
    main()
