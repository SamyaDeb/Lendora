"""Phase 4 task 13: cache the public Lighter (Robinhood Chain instance) series the DN-vault sim needs.

    sim/.venv/bin/python sim/dn_vault/fetch.py

Writes sim/data/lighter/{SYM}_funding.csv (hourly: ts, rate_frac, direction, value) and {SYM}_candles.csv (hourly
trade OHLC of the perp). Pages back from now until the API returns nothing, so the files hold the venue's whole
history. Public API only; no account, no key.

Funding semantics (checked 2026-09-29): `rate` is **percent per hour** (`value / price ≈ rate / 100`), `direction`
"long" = longs pay shorts. `rate_frac` below is the signed hourly fraction a **short** receives (+) or pays (−).
"""
from __future__ import annotations

import csv
import json
import time
import urllib.request
from pathlib import Path

API = "https://api.rh.lighter.xyz/api/v1"
MARKETS = {"SPY": 26, "NVDA": 15, "AAPL": 10}
OUT = Path(__file__).resolve().parents[1] / "data" / "lighter"
PAGE_H = 740


def get(url: str) -> dict:
    for attempt in range(5):
        try:
            with urllib.request.urlopen(url, timeout=30) as r:
                return json.loads(r.read())
        except Exception:  # noqa: BLE001 - public API hiccups: back off and retry
            time.sleep(1 + attempt)
    raise RuntimeError(f"GET failed: {url}")


def fundings(market: int) -> list[dict]:
    end = int(time.time())
    rows: dict[int, dict] = {}
    while True:
        d = get(f"{API}/fundings?market_id={market}&resolution=1h&start_timestamp={end - PAGE_H * 3600}&end_timestamp={end}&count_back={PAGE_H}")
        f = d.get("fundings") or []
        if not f:
            break
        for x in f:
            sign = 1.0 if x["direction"] == "long" else -1.0
            rows[int(x["timestamp"])] = {"ts": int(x["timestamp"]), "rate_frac": sign * float(x["rate"]) / 100.0, "direction": x["direction"], "value": x["value"]}
        end = min(rows) - 1
    return [rows[k] for k in sorted(rows)]


def candles(market: int) -> list[dict]:
    end = int(time.time())
    rows: dict[int, dict] = {}
    while True:
        d = get(f"{API}/candles?market_id={market}&resolution=1h&start_timestamp={end - PAGE_H * 3600}&end_timestamp={end}&count_back={PAGE_H}")
        c = d.get("c") or []
        if not c:
            break
        new = 0
        for x in c:
            t = int(x["t"]) // 1000
            if t not in rows:
                new += 1
            rows[t] = {"ts": t, "open": x["o"], "high": x["h"], "low": x["l"], "close": x["c"], "volume_usd": x["V"]}
        if new == 0:
            break
        end = min(rows) - 1
    return [rows[k] for k in sorted(rows)]


def write(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)


def main() -> None:
    for sym, mid in MARKETS.items():
        f = fundings(mid)
        c = candles(mid)
        write(OUT / f"{sym}_funding.csv", f)
        write(OUT / f"{sym}_candles.csv", c)
        span = (f[-1]["ts"] - f[0]["ts"]) / 86400 if f else 0
        print(f"{sym}: {len(f)} funding hours ({span:.1f} days from {time.strftime('%Y-%m-%d', time.gmtime(f[0]['ts']))}), {len(c)} candles")
    (OUT / "FETCHED").write_text(time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()) + "\n")


if __name__ == "__main__":
    main()
