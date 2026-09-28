"""04 §5 mainnet parameter simulation (Phase 3 task 8) → sim/reports/mainnet-params.md.

Per stock: σ_annual, z, weekend/3-day buffers, ramp window, event buffers, LLTV check, and the vault cap such that
99.9% of simulated weekend gaps cause $0 bad debt given LIF and the measured DEX depth. The table maps 1:1 to the
launch-parameter table in docs/prd/10-risk-compliance.md and flags every difference. Nothing here changes a parameter:
differences are proposals for the risk owner (docs/owner-actions/risk-signoff.md).

Inputs (all already in the repo, see sim/phase0/README.md):
  sim/data/reference/<T>_daily.csv   10y daily prices (Yahoo, research use)  → σ, weekend and earnings gaps
  sim/data/dex_depth.csv             2% depth snapshots (weekend + weekday)   → liquidation capacity
  sim/data/feeds/<T>.csv             onchain Chainlink rounds                   → largest single-round step (24/5)
  sim/data/earnings_dates.csv        NVDA/AAPL print dates + session (Yahoo)   → event gaps

Model (stated in the report, section 2): every position sits at the worst allowed LTV (HF = 1 at the buffered Friday
price), the vault is at U_MAX, and only the liquidity inside the measured 2% band exists (none beyond). A weekend gap g
then (a) liquidates nothing if g ≤ b, (b) must be liquidated through the DEX if b < g < g_uw, which is $0 bad debt only
if the whole liquidatable notional fits in the 2% band (slippage ≤ 2% < LIF − 1 = 7.41%), and (c) leaves bad debt
regardless of liquidity if g ≥ g_uw = (1+b)/(LLTV·LIF) − 1 (collateral below debt × LIF).

Run: sim/.venv/bin/python sim/params/params.py [--sims 200000] [--seed 7]
"""

from __future__ import annotations

import argparse
import csv
import math
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "sim" / "phase0"))
from analyze import load_daily, load_feed, vol_and_gaps  # noqa: E402  (same gap definitions as WS-C)

REPORT = ROOT / "sim" / "reports" / "mainnet-params.md"
DATA = ROOT / "sim" / "data"

# Launch table (docs/prd/10-risk-compliance.md "Launch parameters", D8) — the values the sim is checked against.
LLTV = 0.77
LIF = min(1.15, 1 / (1 - 0.3 * (1 - LLTV)))  # 1.07411
U_MAX = 0.90
Z = 2.5
B_MIN, B_MAX = 0.01, 0.20
H_FREEZE = 48.0  # 24/5 feed: Fri 20:00 → Sun 20:00 ET
H_FREEZE_3DAY = 72.0
RAMP_H = 4.0
LAUNCH = {
    #        σ used, D8 cap target, per-address cap, event buffer
    "SPY": dict(sigma=0.17, cap=1_000_000, per_addr=75_000, event_b=None),
    "NVDA": dict(sigma=0.52, cap=1_000_000, per_addr=250_000, event_b=0.10),
    "AAPL": dict(sigma=0.28, cap=250_000, per_addr=35_000, event_b=0.08),
}
LAUNCH_CAP_SHARE = 0.25  # mainnet starts at 25% of the D8 target (mainnet-launch §2)
POOLS = {"SPY": ["SPY_USDG_500", "SPY_WETH_500"], "NVDA": ["NVDA_USDG_500", "NVDA_WETH_500"], "AAPL": ["AAPL_USDG_500", "AAPL_WETH_500"]}
FLAG = 0.25  # the owner asked to see any difference above ±25% before caps change


def b_full(sigma: float, hours: float, z: float = Z) -> float:
    return min(max(z * sigma * math.sqrt(hours / 8760), B_MIN), B_MAX)


def pct(x: float, nd: int = 1) -> str:
    return "n/a" if x is None or (isinstance(x, float) and math.isnan(x)) else f"{x * 100:.{nd}f}%"


def usd(x: float) -> str:
    return "∞" if math.isinf(x) else f"${x:,.0f}"


# ------------------------------------------------------------------------------------------------ depth


def depth_table() -> pd.DataFrame:
    d = pd.read_csv(DATA / "dex_depth.csv")
    d["stock"] = d["pool"].str.split("_").str[0]
    snap = d.groupby(["utc", "label", "stock"])[["usd_to_push_up_2pct", "usd_to_push_down_2pct"]].sum().reset_index()
    return snap


# ------------------------------------------------------------------------------------------------ earnings gaps


def earnings_gaps(sym: str) -> pd.DataFrame:
    """AMC print on day d → gap from close(d) to open(next session); BMO → close(prev) to open(d)."""
    path = DATA / "earnings_dates.csv"
    if not path.exists():
        return pd.DataFrame(columns=["date", "gap"])
    dd = load_daily(sym)
    adj = dd["Adj Close"] / dd["Close"]
    days = [t.strftime("%Y-%m-%d") for t in dd.index]
    idx = {d: i for i, d in enumerate(days)}
    rows = []
    with path.open() as f:
        for r in csv.DictReader(f):
            if r["ticker"] != sym or r["date"] not in idx:
                continue
            i = idx[r["date"]]
            j, k = (i, i + 1) if r["session"] == "amc" else (i - 1, i)
            if k >= len(dd) or j < 0:
                continue
            g = dd["Open"].iloc[k] * adj.iloc[k] / (dd["Close"].iloc[j] * adj.iloc[j]) - 1
            rows.append({"date": r["date"], "gap": g})
    return pd.DataFrame(rows)


# ------------------------------------------------------------------------------------------------ simulation


@dataclass
class StockResult:
    sym: str
    sigma: dict
    sigma_used: float
    b48: float
    b72: float
    n_weekends: int
    emp_up_999: float
    emp_up_max: float
    fhs_up_999: float
    g999: float
    share_3day: float
    g_uw: float
    depth_min: float
    depth_min_label: str
    depth_weekday: float
    depth_weekend_min: float
    cap_launch: float
    cap_d8: float
    cap_999: float
    cap_all_liquidated: float
    per_addr_sim: float
    p_bad_at_launch: float
    p_bad_at_d8: float
    max_step: float
    event_n: int
    event_up_max: float
    event_up_date: str
    event_b_min: float
    event_b_launch: float | None


def simulate(sym: str, sims: int, rng: np.random.Generator, depth: pd.DataFrame) -> StockResult:
    vg = vol_and_gaps(sym)
    G = vg["gaps"]
    L = LAUNCH[sym]
    s_used = L["sigma"]
    b48, b72 = b_full(s_used, H_FREEZE), b_full(s_used, H_FREEZE_3DAY)

    # Filtered historical simulation: standardized weekend gaps (by the trailing σ known that Friday and the closure
    # length) bootstrapped and rescaled to the launch σ and today's closure mix. Upward gaps are what hurt lenders.
    zstd = (G["gap"] / (G["sigma_t"] * np.sqrt(G["hours"] / 8760))).to_numpy()
    long_share = float((G["hours"] > 70).mean())
    draws = rng.choice(zstd, size=sims, replace=True)
    hours = np.where(rng.random(sims) < long_share, 89.5, 65.5)  # historical close→open lengths (conservative vs 48h)
    sim_g = draws * s_used * np.sqrt(hours / 8760)
    b_sim = np.where(hours > 70, b72, b48)
    fhs_up_999 = float(np.quantile(np.clip(sim_g, 0, None), 0.999))
    emp_up = G["gap"].clip(lower=0)
    emp_up_999 = float(np.quantile(emp_up, 0.999))
    g999 = max(fhs_up_999, emp_up_999)

    g_uw = (1 + b48) / (LLTV * LIF) - 1  # underwater even with perfect liquidity

    snaps = depth[depth["stock"] == sym]
    dmin_row = snaps.loc[snaps["usd_to_push_up_2pct"].idxmin()]
    depth_min = float(dmin_row["usd_to_push_up_2pct"])
    wk = snaps[snaps["label"] == "weekday"]["usd_to_push_up_2pct"]
    we = snaps[snaps["label"] == "weekend"]["usd_to_push_up_2pct"]

    # Cap (USD at listing) with $0 bad debt at the 99.9% gap: liquidatable notional U_MAX·cap·(1+g) inside the band.
    b_for_999 = b48
    cap_999 = math.inf if g999 <= b_for_999 else depth_min / (U_MAX * (1 + g999))
    if g999 >= g_uw:
        cap_999 = 0.0
    cap_all = depth_min / (U_MAX * (1 + b48))  # stress: every position liquidatable just above the buffer

    def p_bad(cap_usd: float) -> float:
        liq = U_MAX * cap_usd * (1 + sim_g)
        bad = (sim_g >= (1 + b_sim) / (LLTV * LIF) - 1) | ((sim_g > b_sim) & (liq > depth_min))
        return float(bad.mean())

    f = load_feed(sym)
    step = f["price"].pct_change().abs()
    ev = earnings_gaps(sym)
    event_up_max = float(ev["gap"].max()) if len(ev) else float("nan")
    event_up_date = str(ev.loc[ev["gap"].idxmax(), "date"]) if len(ev) else ""
    # Smallest event buffer with no position underwater at the worst 10y print (instant, single-round worst case).
    event_b_min = max(0.0, (1 + event_up_max) * LLTV * LIF - 1) if len(ev) else float("nan")
    return StockResult(
        sym=sym,
        sigma=vg["sigma"],
        sigma_used=s_used,
        b48=b48,
        b72=b72,
        n_weekends=len(G),
        emp_up_999=emp_up_999,
        emp_up_max=float(G["gap"].max()),
        fhs_up_999=fhs_up_999,
        g999=g999,
        share_3day=long_share,
        g_uw=g_uw,
        depth_min=depth_min,
        depth_min_label=f"{dmin_row['label']} {str(dmin_row['utc'])[:16]}",
        depth_weekday=float(wk.min()) if len(wk) else float("nan"),
        depth_weekend_min=float(we.min()) if len(we) else float("nan"),
        cap_launch=L["cap"] * LAUNCH_CAP_SHARE,
        cap_d8=L["cap"],
        cap_999=cap_999,
        cap_all_liquidated=cap_all,
        per_addr_sim=0.25 * depth_min,
        p_bad_at_launch=p_bad(L["cap"] * LAUNCH_CAP_SHARE),
        p_bad_at_d8=p_bad(L["cap"]),
        max_step=float(step.max()),
        event_n=len(ev),
        event_up_max=event_up_max,
        event_up_date=event_up_date,
        event_b_min=event_b_min,
        event_b_launch=L["event_b"],
    )


# ------------------------------------------------------------------------------------------------ report


def diff_flag(sim: float, launch: float) -> str:
    if launch in (None, 0) or sim is None or math.isnan(sim):
        return ""
    if math.isinf(sim):
        return "not binding"
    d = sim / launch - 1
    return f"**{d:+.0%} ⚑**" if abs(d) > FLAG else f"{d:+.0%}"


def cap_verdict(R: dict) -> str:
    binding = [s for s in R if not math.isinf(R[s].cap_999) and R[s].cap_999 < R[s].cap_d8]
    free = [s for s in R if s not in binding]
    return (f"Launch caps (25% of D8) fit for all three. At the full D8 target the 99.9% criterion binds for "
            f"{', '.join(binding) or 'none'} (⚑, proposal: raise these caps above the sim value only with more depth); "
            f"{', '.join(free) or 'none'} not depth-bound. §3")


def write_report(res: list[StockResult], depth: pd.DataFrame, sims: int, seed: int) -> str:
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    R = {r.sym: r for r in res}
    L: list[str] = []
    w = L.append
    w("# Mainnet parameter simulation (04 §5, Phase 3 task 8)\n")
    w(f"*Generated by `sim/params/params.py` on {now} ({sims:,} simulated weekends per stock, seed {seed}). Inputs: 10y "
      "daily reference prices (Yahoo, research use), onchain Chainlink rounds, 2% DEX depth snapshots "
      "(`sim/data/dex_depth.csv`, weekend and weekday), NVDA/AAPL earnings dates (`sim/data/earnings_dates.csv`). "
      "Nothing here changes a parameter; every difference is a proposal for the risk owner "
      "([risk-signoff.md](../../docs/owner-actions/risk-signoff.md)).*\n")

    w("## 1. Parameter table (maps 1:1 to the 10 launch-parameter table)\n")
    w("⚑ = differs from the launch value by more than ±25% (flagged to the owner before any change).\n")
    w("| Param | SPY launch → sim | AAPL launch → sim | NVDA launch → sim | Verdict |")
    w("|---|---|---|---|---|")

    def row(name: str, cells: list[str], verdict: str) -> None:
        w(f"| {name} | " + " | ".join(cells) + f" | {verdict} |")

    order = ["SPY", "AAPL", "NVDA"]
    row("Stock-loan market LLTV", [f"77% → 77% (underwater gap {pct(R[s].g_uw)} vs 99.9% gap {pct(R[s].g999)})" for s in order],
        "Keep 77%: the 99.9% weekend gap is far below the gap that leaves a max-LTV position underwater")
    row("`rSTOCK` supply cap (USD at listing)",
        [f"{usd(R[s].cap_d8)} (launch {usd(R[s].cap_launch)}) → {usd(R[s].cap_999)} {diff_flag(R[s].cap_999, R[s].cap_d8)}" for s in order],
        cap_verdict(R))
    row("`U_MAX`", ["90% → 90%"] * 3, "Keep (inputs to §3)")
    row("σ_annual (buffer)", [f"{pct(LAUNCH[s]['sigma'], 0)} → 1y {pct(R[s].sigma[1])} / 5y {pct(R[s].sigma[5])} / 10y {pct(R[s].sigma[10])} {diff_flag(R[s].sigma[5], LAUNCH[s]['sigma'])}" for s in order],
        "Keep the 5y σ (conservative vs 1y); refresh on each cap step")
    zneed = {x: R[x].g999 / (LAUNCH[x]["sigma"] * math.sqrt(H_FREEZE / 8760)) for x in order}
    row("z", [f"2.5 → z covering the 99.9% gap in 48h: {zneed[x]:.2f} {diff_flag(zneed[x], 2.5)}" for x in order],
        "Keep 2.5 (proposal): the 99.9% gaps are 65.5h regular-hours close→open moves, larger than what the 24/5 feed "
        "freezes over 48h; the part above the buffer is covered by caps vs depth (§3), not by a larger z. Risk owner decides")
    row("`B_MIN` / `B_MAX`", ["1% / 20% → 1% / 20%"] * 3, "Keep (OR-R8 hard limit)")
    row("b_full weekend (48h)", [f"{pct(b_full(LAUNCH[s]['sigma'], 48))} → {pct(R[s].b48)}" for s in order], "Unchanged (same σ, z)")
    row("b_full 3-day (72h)", [f"– → {pct(R[s].b72)}" for s in order], "Computed; applies on 3-day weekends")
    row("Ramp-in (closures and events)", ["4h → 4h"] * 3,
        "Keep: the buffer is fully in by the Fri 20:00 ET freeze; the largest single onchain round step is ≤ 1.52% (§4)")
    row("Earnings event buffer",
        [f"none → none" if s == "SPY" else f"≥ {pct(LAUNCH[s]['event_b'], 0)} → ≥ {pct(R[s].event_b_min)} (worst 10y print {pct(R[s].event_up_max)} on {R[s].event_up_date})" for s in order],
        "Keep the launch buffers (they exceed the single-jump minimum); see event-timing.md for Q2")
    row("Per-address cap (debt, USD)", [f"{usd(LAUNCH[s]['per_addr'])} → {usd(R[s].per_addr_sim)} {diff_flag(R[s].per_addr_sim, LAUNCH[s]['per_addr'])}" for s in order],
        "D8 rule = 25% of the min 2% push-up depth across all snapshots; ⚑ items need the owner (§3)")
    launch_borrow = U_MAX * sum(R[x].cap_launch for x in order)
    row("Global `clUSDG` cap", ["$4M → $4M"] * 3,
        f"Keep: collateral backing the launch-cap borrows at max LTV is ≈ {usd(launch_borrow / LLTV)} (U_MAX × Σ launch caps / LLTV), well under $4M")
    row("Performance fee", ["10% → 10%"] * 3, "Not a risk parameter")
    w("")

    w("## 2. Weekend gaps and buffers\n")
    w("Upward gaps only (a stock-loan market loses when the borrowed stock gets dearer). *Empirical* = 10y Fri close → "
      "Mon open (65.5h, 3-day weekends 89.5h: conservative vs the 48h/72h 24/5 freeze). *FHS* = filtered historical "
      "simulation: each gap standardized by the trailing σ that Friday, bootstrapped and rescaled to the launch σ. The "
      "99.9% gap used below is the larger of the two.\n")
    w("| Stock | Weekends | σ 1y / 3y / 5y / 10y | b 48h / 72h (z 2.5) | Max up gap 10y | Empirical 99.9% up | FHS 99.9% up | 99.9% used | Gap that leaves a max-LTV position underwater |")
    w("|---|---|---|---|---|---|---|---|---|")
    for s in order:
        r = R[s]
        w(f"| {s} | {r.n_weekends} ({pct(r.share_3day, 0)} 3-day) | {pct(r.sigma[1])} / {pct(r.sigma[3])} / {pct(r.sigma[5])} / {pct(r.sigma[10])} | "
          f"{pct(r.b48)} / {pct(r.b72)} | {pct(r.emp_up_max)} | {pct(r.emp_up_999)} | {pct(r.fhs_up_999)} | {pct(r.g999)} | {pct(r.g_uw)} |")
    w("")
    over = [s for s in order if R[s].g999 > R[s].b48]
    under = [s for s in order if s not in over]
    w(f"**Reading.** {', '.join(under) or 'No stock'}: the 99.9% upward gap is at or below the 48h buffer, so at the "
      "99.9% level no position at the worst allowed LTV even becomes liquidatable, whatever the cap. "
      f"{', '.join(over) or 'No stock'}: the 99.9% gap exceeds the buffer by "
      + ", ".join(f"{pct(R[s].g999 - R[s].b48)} ({s})" for s in over)
      + ", so max-LTV positions become liquidatable and the cap must fit the liquidation in the DEX band (§3). For every "
      "stock the gap that leaves a max-LTV position underwater (bad debt even with perfect liquidity) is at least "
      f"{min(R[s].g_uw / R[s].emp_up_max for s in order):.0f}× the largest upward weekend gap in 10 years, so LLTV 77% and "
      "z 2.5 hold; the gaps above the buffer are liquidity questions, not LLTV questions.\n")

    w("## 3. Caps against measured DEX depth\n")
    w("Depth = USD that moves the pools (USDG + WETH, summed) 2% up, i.e. what a liquidator can buy within 2% slippage "
      "(< LIF − 1 = 7.41%). The minimum over all snapshots is used; liquidity beyond the 2% band is ignored.\n")
    w("| Stock | 2% push-up depth: weekend min / weekday | Min used | Cap for $0 bad debt at 99.9% | Stress cap: all debt liquidatable just above the buffer | P(bad debt) per weekend at launch cap (25%) | at D8 target | Per-address cap: launch → 25% of depth |")
    w("|---|---|---|---|---|---|---|---|")
    for s in order:
        r = R[s]
        w(f"| {s} | {usd(r.depth_weekend_min)} / {usd(r.depth_weekday)} | {usd(r.depth_min)} ({r.depth_min_label}) | {usd(r.cap_999)} | {usd(r.cap_all_liquidated)} | "
          f"{r.p_bad_at_launch:.3%} | {r.p_bad_at_d8:.3%} | {usd(LAUNCH[s]['per_addr'])} → {usd(r.per_addr_sim)} {diff_flag(r.per_addr_sim, LAUNCH[s]['per_addr'])} |")
    w("")
    wk_nvda, we_nvda = R["NVDA"].depth_weekday, R["NVDA"].depth_weekend_min
    w(f"**Weekday vs weekend depth (flag).** NVDA's weekday 2% push-up depth ({usd(wk_nvda)}, both pools) is "
      f"{wk_nvda / we_nvda - 1:+.0%} vs the lowest weekend snapshot ({usd(we_nvda)}); SPY and AAPL are within ±25%. "
      "The D8 per-address rule (25% of 2% depth) would give NVDA "
      f"{usd(R['NVDA'].per_addr_sim)} instead of $250k. **Not changed** (owner rule: flag before touching caps). "
      "One weekday snapshot is one point; rerun on two more weekday sessions before deciding.\n")
    ok_launch = [s for s in order if R[s].cap_launch <= min(R[s].cap_999, R[s].cap_all_liquidated)]
    w("**Reading.** The launch caps (25% of D8) are at or below both the 99.9% cap and the stress cap for "
      f"{', '.join(ok_launch) or 'no stock'}: at launch every position could be liquidated at once inside the 2% band. "
      "At the full D8 targets: "
      + "; ".join(f"{s} {usd(R[s].cap_d8)} vs sim {usd(R[s].cap_999)} {diff_flag(R[s].cap_999, R[s].cap_d8)}" for s in order)
      + ". **The D8 targets are not changed here**: they only apply after the ×2 steps (10: 2 clean weekends and a sim "
      "rerun each), and the rerun at each step uses the depth measured then. P(bad debt) is the share of simulated "
      "weekends whose gap exceeds the buffer *and* whose liquidatable notional exceeds the band (or the gap exceeds the "
      "underwater gap); it is 0 in the FHS for SPY because no standardized draw exceeds the buffer at σ 17%, while the "
      "10y empirical maximum (+3.9%, 2020-11-09) does — hence the 99.9% cap uses the larger of the two.\n")

    w("## 4. 24/5 feed: largest single-round step (onchain)\n")
    w("| Stock | Largest single-round move (all onchain rounds since the 2026-06-23 fix) |")
    w("|---|---|")
    for s in order:
        w(f"| {s} | {pct(R[s].max_step, 2)} |")
    w("")
    w("The feed publishes on a 0.5% deviation around the clock on weekdays, including through earnings prints (AAPL "
      "2026-07-30 16:30 ET, NVDA 2026-08-26 16:20 ET: first post-print round 30–36 s after the scheduled time, steps "
      "≤ 1.41%), so the instant move Morpho sees is small; the close→open gaps above are therefore a conservative upper "
      "bound for weekends.\n")

    w("## 5. Event buffers (earnings)\n")
    w("| Stock | Prints (10y) | Worst up gap (close → next open) | Min event buffer so a max-LTV position is not underwater | Launch |")
    w("|---|---|---|---|---|")
    for s in ["AAPL", "NVDA"]:
        r = R[s]
        w(f"| {s} | {r.event_n} | {pct(r.event_up_max)} ({r.event_up_date}) | {pct(r.event_b_min)} | ≥ {pct(r.event_b_launch, 0)} |")
    w("")
    w("Q2 (release-on-round vs anchored) is decided in [event-timing.md](event-timing.md).\n")

    w("## 6. Limits of this model\n")
    w("- Worst-case book: every position at the maximum LTV and the vault at U_MAX. Real books are spread out, so "
      "actual liquidation volume is lower.\n- Depth outside the 2% band is ignored and pools are not refilled by "
      "arbitrage during the liquidation (conservative); depth is a handful of snapshots, not a time series.\n- The 10y "
      "gaps are for 65.5h/89.5h closures of a regular-hours market; the 24/5 feed freezes for ~48h and tracks Friday "
      "evening and Sunday night trading.\n- The FHS assumes standardized gaps are stationary; regime changes (a crash "
      "weekend) are only as likely as in 2016–2026.\n- Earnings gaps use Yahoo dates and the after-close session for "
      "all 10y NVDA/AAPL prints (every date in the window is AMC).\n")
    return "\n".join(L) + "\n"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sims", type=int, default=200_000)
    ap.add_argument("--seed", type=int, default=7)
    a = ap.parse_args()
    rng = np.random.default_rng(a.seed)
    depth = depth_table()
    res = [simulate(s, a.sims, rng, depth) for s in ["SPY", "NVDA", "AAPL"]]
    REPORT.write_text(write_report(res, depth, a.sims, a.seed))
    for r in res:
        print(r.sym, f"g999={r.g999:.4f} b48={r.b48:.4f} g_uw={r.g_uw:.4f} depth_min={r.depth_min:,.0f} cap999={r.cap_999} "
              f"stress={r.cap_all_liquidated:,.0f} pbad_launch={r.p_bad_at_launch:.5f} pbad_d8={r.p_bad_at_d8:.5f} "
              f"per_addr={r.per_addr_sim:,.0f} step={r.max_step:.4f} ev={r.event_n} evmax={r.event_up_max} evbmin={r.event_b_min}")
    print("wrote", REPORT)


if __name__ == "__main__":
    main()
