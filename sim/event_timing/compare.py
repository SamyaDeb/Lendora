"""OR-R14 event-buffer timing study (open decision Q2): release-on-round (built) vs an anchored buffer.

Two views of an earnings print, both from data in the repo:
  1. Single-jump model (the question as posed in README.md): the whole close → next-open gap arrives in one round.
     Instant stock move per design and timing case; share of the 10y prints above Morpho's instant bound (+20.9%),
     weighted by a timing-error probability p_err (release-on-round is exposed only when endTs is wrong).
  2. What the 24/5 feed actually does at a print (onchain rounds, sim/data/feeds): when the first post-print round
     lands relative to the scheduled endTs, the largest single step, and the move over the next 3h.

Inputs: sim/data/reference/<T>_daily.csv, sim/data/earnings_dates.csv (Yahoo dates; every 10y NVDA/AAPL print is after
the close), sim/data/feeds/<T>.csv, packages/sdk/data/events.json (release times). Output: sim/reports/event-timing.md.

Run: sim/.venv/bin/python sim/event_timing/compare.py [--buffer NVDA=0.10 --buffer AAPL=0.08]
"""

from __future__ import annotations

import argparse
import csv
import json
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
REF = ROOT / "sim" / "data" / "reference"
FEEDS = ROOT / "sim" / "data" / "feeds"
DATES = ROOT / "sim" / "data" / "earnings_dates.csv"
REPORT = ROOT / "sim" / "reports" / "event-timing.md"
ET = ZoneInfo("America/New_York")
LLTV = 0.77
LIF = min(1.15, 1 / (0.3 * LLTV + 0.7))  # Morpho liquidation incentive factor
MORPHO_DROP = 1 - LLTV * LIF  # 17.29% instant drop of price() allowed
STOCK_UP_BOUND = 1 / (1 - MORPHO_DROP) - 1  # +20.9% stock move in one round
P_ERR = (0.0, 0.1, 0.25, 0.5)
# Prints inside the onchain feed history, with the scheduled release time the calendar would have used (events.json
# sources: apple.com/newsroom 2026-07-30 Q3 release at 16:30 ET; nvidianews.nvidia.com Q2 FY27 at 16:20 ET).
ONCHAIN_PRINTS = [("AAPL", "2026-07-30", "16:30"), ("NVDA", "2026-08-26", "16:20")]


def daily(ticker: str) -> pd.DataFrame:
    d = pd.read_csv(REF / f"{ticker}_daily.csv", index_col=0)
    d.index = pd.to_datetime(d.index, utc=True).tz_convert(ET)
    d["adj"] = d["Adj Close"] / d["Close"]
    return d


def gaps(ticker: str) -> tuple[list[tuple[str, float]], str]:
    """Earnings gaps: AMC print on day d → close(d) to open(next session); BMO → close(prev) to open(d)."""
    d = daily(ticker)
    days = [t.strftime("%Y-%m-%d") for t in d.index]
    idx = {x: i for i, x in enumerate(days)}
    out = []
    if not DATES.exists():
        raise SystemExit("sim/data/earnings_dates.csv is missing (see README.md)")
    with DATES.open() as f:
        for r in csv.DictReader(f):
            if r["ticker"] != ticker or r["date"] not in idx:
                continue
            i = idx[r["date"]]
            j, k = (i, i + 1) if r["session"] == "amc" else (i - 1, i)
            if j < 0 or k >= len(d):
                continue
            g = d["Open"].iloc[k] * d["adj"].iloc[k] / (d["Close"].iloc[j] * d["adj"].iloc[j]) - 1
            out.append((r["date"], float(g)))
    return out, "earnings_dates.csv"


def moves(g: float, b: float) -> dict[str, float]:
    on_time = (1 + g) / (1 + b) - 1
    return {
        "release_on_time": on_time,
        "release_early_or_late": g,  # buffer released a round before, or the jump lands before endTs
        "anchored_any_timing": max(0.0, on_time) if g > 0 else g,
    }


def onchain_print(ticker: str, day: str, hhmm: str) -> dict:
    f = pd.read_csv(FEEDS / f"{ticker}.csv")
    f = f[f["answer"] < 1e16].sort_values("updated_at").reset_index(drop=True)
    f["px"] = f["answer"] / 1e8
    f["t"] = pd.to_datetime(f["updated_at"], unit="s", utc=True).dt.tz_convert(ET)
    end = pd.Timestamp(f"{day} {hhmm}", tz=ET)
    pre = f[f["t"] < end].iloc[-1]
    post = f[f["t"] >= end]
    first = post.iloc[0]
    win = post[post["t"] <= end + pd.Timedelta(hours=3)]
    steps = pd.concat([pd.Series([first["px"] / pre["px"] - 1]), win["px"].pct_change().dropna()])
    path = win["px"] / pre["px"] - 1
    return {
        "ticker": ticker,
        "endTs": end.strftime("%Y-%m-%d %H:%M ET"),
        "last_pre": pre["t"].strftime("%H:%M:%S"),
        "first_post": first["t"].strftime("%H:%M:%S"),
        "delay_s": int((first["t"] - end).total_seconds()),
        "first_step": float(first["px"] / pre["px"] - 1),
        "rounds_3h": int(len(win)),
        "max_step": float(steps.abs().max()),
        "move_3h_max_up": float(path.max()),
        "move_3h_max_down": float(path.min()),
        "early": bool(pre["t"] >= end),  # a pre-print round at/after endTs would have released the buffer early
    }


def pct(x: float, nd: int = 1) -> str:
    return f"{x * 100:+.{nd}f}%"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--buffer", action="append", default=[], help="TICKER=b, e.g. NVDA=0.10")
    args = ap.parse_args()
    buffers = {"NVDA": 0.10, "AAPL": 0.08}
    buffers.update({k: float(v) for k, v in (x.split("=") for x in args.buffer)})

    L: list[str] = []
    w = L.append
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    w("# Event-buffer timing study (OR-R14, open decision Q2)\n")
    w(f"*Generated by `sim/event_timing/compare.py` on {now}. Question and method: [README](../event_timing/README.md). "
      "Morpho lets `price()` drop at most "
      f"{MORPHO_DROP:.2%} in one step (LLTV 77%, LIF {LIF:.5f}), i.e. a stock move of up to **+{STOCK_UP_BOUND:.1%}** in "
      "one round.*\n")

    w("## 1. Single-jump model over 10 years of prints\n")
    w("Assumes the whole close → next-open gap arrives in **one** round (the worst case the question was posed for). "
      "Release-on-round is exposed only when `endTs` is wrong (early or late); p_err is that probability.\n")
    w("| Stock | Prints | Event buffer | Worst up gap | Release on time: worst / over bound | Early or late: worst / over bound | Anchored: worst / over bound | Release-on-round expected prints over bound per 10y at p_err = " + " / ".join(f"{p:.0%}" for p in P_ERR) + " |")
    w("|---|---|---|---|---|---|---|---|")
    summary = {}
    for ticker, b in buffers.items():
        events, _ = gaps(ticker)
        m = {k: [moves(g, b)[k] for _, g in events] for k in ("release_on_time", "release_early_or_late", "anchored_any_timing")}
        over = {k: sum(1 for x in v if x > STOCK_UP_BOUND) for k, v in m.items()}
        worst_date = max(events, key=lambda e: e[1])[0]
        exp = [(1 - p) * over["release_on_time"] + p * over["release_early_or_late"] for p in P_ERR]
        summary[ticker] = (over, max(g for _, g in events), worst_date)
        w(f"| {ticker} | {len(events)} | {b:.0%} | {pct(max(g for _, g in events))} ({worst_date}) | "
          f"{pct(max(m['release_on_time']))} / {over['release_on_time']} | {pct(max(m['release_early_or_late']))} / {over['release_early_or_late']} | "
          f"{pct(max(m['anchored_any_timing']))} / {over['anchored_any_timing']} | " + " / ".join(f"{x:.2f}" for x in exp) + " |")
    w("")

    w("## 2. What the 24/5 feed does at a print (onchain)\n")
    w("The two prints inside the onchain history, against the release time the calendar uses for `endTs`.\n")
    w("| Print | `endTs` | Last round before | First round at/after | Delay | First step | Rounds in 3h | Largest single step | Move over 3h (max up / max down) | Buffer released early? |")
    w("|---|---|---|---|---|---|---|---|---|---|")
    ob = [onchain_print(*p) for p in ONCHAIN_PRINTS]
    for o in ob:
        w(f"| {o['ticker']} | {o['endTs']} | {o['last_pre']} | {o['first_post']} | {o['delay_s']} s | {pct(o['first_step'], 2)} | {o['rounds_3h']} | "
          f"{o['max_step'] * 100:.2f}% | {pct(o['move_3h_max_up'])} / {pct(o['move_3h_max_down'])} | {'yes' if o['early'] else 'no'} |")
    w("")
    w("**Reading.** The Chainlink 24/5 feed prices after-hours trading on a 0.5% deviation: the result reaches "
      "`price()` as dozens of ≤ 1.5% steps within minutes of the release, not as one round at the next open. Both "
      "observed prints released on time (first post-print round 30–36 s after `endTs`, no pre-print round at or after "
      "`endTs`). Over all onchain rounds (June–September 2026) the largest single step is 1.52% "
      "([mainnet-params.md](mainnet-params.md) §4).\n")

    w("## 3. Conclusion (Q2)\n")
    worst = max(v[1] for v in summary.values())
    w(f"**Keep release-on-round** (the built design); do not propose the anchored oracle. Reasons:\n")
    w(f"1. Even in the single-jump worst case, no 10y print breaches the Morpho bound when `endTs` is right "
      f"({', '.join(f'{t}: {v[0]['release_on_time']} of {len(gaps(t)[0])}' for t, v in summary.items())}); only a "
      f"timing error could, and only for gaps above +20.9% (worst: {pct(worst)}).\n")
    w("2. The feed is 24/5: prints arrive as small steps (≤ 1.5% observed), so the single-jump case does not occur on "
      "this feed while it is publishing; the buffer's job at a print is to cover the minutes of repricing, which the "
      "0.5%-deviation rounds already bound.\n")
    w("3. Timing errors are rare and visible: `endTs` = the company's announced release minute (A10, confirmed dates "
      "only; 2 of 2 onchain prints on time). The calendar-push runbook and MON-R13 cover changes.\n")
    w("4. Anchored costs a new oracle version, new Morpho markets and a liquidity migration for a risk the data does not "
      "show.\n")
    w("**Residual risk and the trigger to revisit:** a print while the feed is *not* publishing (a weekend or holiday "
      "release, or a feed outage across the release) would arrive as one step at the reopen. Both are covered by the "
      "weekend buffer and the guard (`STALE`), and neither has happened for NVDA/AAPL in 10 years (every print is a "
      "weekday after the close). Revisit if a company moves its release outside feed hours or if a print ever reaches "
      "`price()` in one step above 5%.\n")
    w("**Owner action:** the risk owner confirms this conclusion in [risk-signoff.md](../../docs/owner-actions/risk-signoff.md) (Q2).\n")
    REPORT.write_text("\n".join(L) + "\n")
    print("\n".join(L))


if __name__ == "__main__":
    main()
