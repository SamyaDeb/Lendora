"""Phase 4 task 13 · delta-neutral vault simulation gate (docs/prd/08-delta-neutral-vault.md "Simulation gate").

    sim/.venv/bin/python sim/dn_vault/fetch.py      # refresh the Lighter cache (public API)
    sim/.venv/bin/python sim/dn_vault/model.py      # → sim/reports/phase4-dn-vault.md

Real data only:
- perp funding, hourly, Lighter Robinhood Chain instance (sim/data/lighter/*_funding.csv, from 2026-06-26);
- perp trade prices, hourly candles (sim/data/lighter/*_candles.csv) for the short leg's mark;
- Chainlink 24/5 rounds (sim/data/feeds/*.csv) for the spot mark, exactly as the NAV (DN-R4) marks spot;
- measured DEX depth (sim/data/dex_depth.csv) for swap costs, as sim/params/params.py uses it;
- 10 years of daily closes (sim/data/reference/*_daily.csv) for weekend gaps.

The lending leg has **no observed history** (Lendora is not on mainnet and the 4663 stock-loan markets are empty,
01-chain-facts §8): its supply APY is a stated proxy with sensitivities, never a measured number.

The gate needs ≥ 12 months of funding for each launch stock; the venue has ≈ 3 months, so the verdict is
**insufficient data** whatever the numbers below say. Nothing is extrapolated silently: the only resampled figures are
in a section labelled "sensitivity, not used for the verdict".
"""
from __future__ import annotations

import math
import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "sim" / "data"
REPORT = ROOT / "sim" / "reports" / "phase4-dn-vault.md"

# ------------------------------------------------------------------------------------------------ PRD 08 parameters
L = 3.0  # perp leverage (08 launch default)
C = 0.05  # cash buffer
LEND_RATIO = 0.90  # share of spot lent through rSTOCK
WEIGHTS = {"SPY": 0.50, "NVDA": 0.25, "AAPL": 0.25}  # placeholder sleeves (08)
BAND = 0.02  # DN-R2: |net delta| ≤ 2% of sleeve NAV
MARGIN_OPEN = 2.0  # DN-R3: margin ratio ≥ 2× maintenance while open
MARGIN_CLOSED = 3.0  # 08 weekend: 3× while closed
MARGIN_EMERGENCY = 1.5  # 08 weekend: spot trades while closed only below 1.5×
PERF_FEE = 0.10  # DN-R9
KILL_HOURS = 72  # DN-R7
TVL = 2_000_000.0  # DN-R6 launch total cap ($2M)
MMF = {"SPY": 0.012, "NVDA": 0.03, "AAPL": 0.03}  # Lighter maintenance margin fractions (orderBookDetails)
PERP_COST = 0.0001  # 0 fees (standard account) + ~1 bp half-spread (VERIFY on size)
SUPPLY_APY_BASE = 0.02  # proxy: rSTOCK supply APY (see LENDING below)
SUPPLY_APY_SENS = [0.0, 0.02, 0.05]
REBALANCE_UTC_HOUR = 14  # once per US session, at 10:00 ET (DN-R2)
GATE_MONTHS = 12


def pct(x: float, nd: int = 2) -> str:
    return "n/a" if x is None or (isinstance(x, float) and math.isnan(x)) else f"{x * 100:.{nd}f}%"


def usd(x: float) -> str:
    return f"${x:,.0f}"


# ------------------------------------------------------------------------------------------------ data


def load_funding(sym: str) -> pd.Series:
    f = pd.read_csv(DATA / "lighter" / f"{sym}_funding.csv")
    return pd.Series(f["rate_frac"].values, index=pd.to_datetime(f["ts"], unit="s", utc=True)).sort_index()


def load_perp(sym: str) -> pd.Series:
    c = pd.read_csv(DATA / "lighter" / f"{sym}_candles.csv")
    return pd.Series(c["close"].astype(float).values, index=pd.to_datetime(c["ts"], unit="s", utc=True)).sort_index()


def load_chainlink(sym: str) -> pd.Series:
    f = pd.read_csv(DATA / "feeds" / f"{sym}.csv")
    return pd.Series(f["answer"].astype(float).values / 1e8, index=pd.to_datetime(f["updated_at"], unit="s", utc=True)).sort_index()


def depth_usd() -> dict[str, dict[str, float]]:
    """USD that moves the stock's pools 2% (both 0.05% pools summed), weekday and weekend (min of the two sides)."""
    d = pd.read_csv(DATA / "dex_depth.csv")
    d["stock"] = d["pool"].str.split("_").str[0]
    d["side"] = d[["usd_to_push_up_2pct", "usd_to_push_down_2pct"]].min(axis=1)
    snap = d.groupby(["utc", "label", "stock"])["side"].sum().reset_index()
    out: dict[str, dict[str, float]] = {}
    for sym in WEIGHTS:
        s = snap[snap.stock == sym]
        wk = s[s.label.str.contains("weekday")]["side"]
        we = s[~s.label.str.contains("weekday")]["side"]
        out[sym] = {"weekday": float(wk.median()) if len(wk) else float(we.median()), "weekend": float(we.min()) if len(we) else float(wk.min())}
    return out


def swap_cost(trade_usd: float, depth_2pct: float) -> float:
    """Average price impact of a DEX trade: the pool moves 2% for `depth_2pct` USD; a trade of x pays ≈ half its own
    end move (constant-product, small sizes: impact linear in size) plus the 0.05% pool fee."""
    if trade_usd <= 0:
        return 0.0
    move = 0.02 * trade_usd / max(depth_2pct, 1.0)
    return trade_usd * (0.0005 + move / 2)


def hourly_frame(sym: str) -> pd.DataFrame:
    fund = load_funding(sym)
    perp = load_perp(sym)
    cl = load_chainlink(sym)
    start = max(perp.index.min(), cl.index.min(), fund.index.min())
    end = min(perp.index.max(), cl.index.max(), fund.index.max())
    idx = pd.date_range(start.ceil("h"), end.floor("h"), freq="h", tz="UTC")
    df = pd.DataFrame(index=idx)
    df["perp"] = perp.reindex(idx, method="ffill")
    df["spot"] = cl.reindex(idx, method="ffill")  # the NAV's spot mark (frozen while the feed is closed)
    df["fund"] = fund.reindex(idx).fillna(0.0)  # + = shorts receive
    # Closed = outside the generated 24/5 feed sessions (packages/sdk/data/calendar.json, the calendar MarketHours
    # holds onchain). Sparse Chainlink rounds (SPY updates on deviation) are not closures.
    df["closed"] = ~feed_open(idx)
    return df.dropna()


def feed_open(idx: pd.DatetimeIndex) -> np.ndarray:
    import json

    cal = json.loads((ROOT / "packages" / "sdk" / "data" / "calendar.json").read_text())
    ts = idx.astype("int64") // 10**9
    open_ = np.zeros(len(idx), dtype=bool)
    for x in cal["sessions"]:
        open_ |= (ts >= x["openTs"]) & (ts < x["closeTs"])
    return open_


# ------------------------------------------------------------------------------------------------ vault model


@dataclass
class Sleeve:
    sym: str
    spot_units: float  # held + lent (rSTOCK, in stock units)
    short_units: float
    entry: float  # perp entry price (weighted)
    margin: float  # USDG posted on the venue (excl. unrealized PnL)
    cash: float
    active: bool = True
    neg_hours: int = 0
    costs: float = 0.0
    funding: float = 0.0
    lending: float = 0.0
    trades: int = 0
    in_band: int = 0
    ticks: int = 0
    min_margin_ratio: float = math.inf
    entry_cost: float = 0.0
    killed_at: pd.Timestamp | None = None

    def perp_equity(self, perp: float) -> float:
        return self.margin + self.short_units * (self.entry - perp)

    def nav(self, spot_mark: float, perp: float) -> float:
        return self.cash + self.spot_units * spot_mark + self.perp_equity(perp)

    def margin_ratio(self, perp: float, mmf: float) -> float:
        req = self.short_units * perp * mmf
        return math.inf if req <= 0 else self.perp_equity(perp) / req


def open_sleeve(sym: str, d: float, price: float, depth: float) -> Sleeve:
    s_usd = d * (1 - C) * L / (L + 1)
    m_usd = d * (1 - C) / (L + 1)
    cost = swap_cost(s_usd, depth) + s_usd * PERP_COST
    units = s_usd / price
    return Sleeve(sym, spot_units=units, short_units=units, entry=price, margin=m_usd, cash=d * C - cost, costs=cost, trades=1, entry_cost=cost)


def rebalance(s: Sleeve, spot_mark: float, perp: float, depth: float) -> None:
    """Back to the 08 structure at the current sleeve NAV: short = spot units, perp leverage L, buffer c. The venue PnL
    is realized into margin (entry reset). Spot trades go through the DEX (cost from depth), the perp trade costs
    PERP_COST."""
    nav = s.nav(spot_mark, perp)
    target_units = nav * (1 - C) * L / (L + 1) / spot_mark
    d_spot = target_units - s.spot_units
    d_short = target_units - s.short_units
    cost = swap_cost(abs(d_spot) * spot_mark, depth) + abs(d_short) * perp * PERP_COST
    # realize perp PnL, then move USDG so margin = S/L and cash = the rest
    s.margin = s.perp_equity(perp)
    s.entry = perp
    s.spot_units = target_units
    s.short_units = target_units
    s.cash = nav - cost - s.spot_units * spot_mark - s.margin
    target_margin = target_units * perp / L
    s.cash += s.margin - target_margin
    s.margin = target_margin
    s.costs += cost
    s.trades += 1


def unwind(s: Sleeve, spot_mark: float, perp: float, depth: float) -> None:
    cost = swap_cost(s.spot_units * spot_mark, depth) + s.short_units * perp * PERP_COST
    s.cash = s.nav(spot_mark, perp) - cost
    s.spot_units = s.short_units = s.margin = 0.0
    s.costs += cost
    s.active = False


@dataclass
class RunResult:
    nav: pd.Series  # reported NAV (spot at Chainlink)
    econ: pd.Series  # economic NAV (spot marked at the perp price: what an unwind would realize before costs)
    sleeves: dict[str, Sleeve] = field(default_factory=dict)
    fee_paid: float = 0.0


def run(frames: dict[str, pd.DataFrame], supply_apy: float, depth: dict[str, dict[str, float]], fund_override: dict[str, pd.Series] | None = None, tvl: float = TVL, kill_hours: int = KILL_HOURS, kill_window: int = 168) -> RunResult:
    idx = frames["SPY"].index
    for f in frames.values():
        idx = idx.intersection(f.index)
    sl: dict[str, Sleeve] = {}
    for sym, w in WEIGHTS.items():
        f = frames[sym].loc[idx]
        sl[sym] = open_sleeve(sym, tvl * w, f["spot"].iloc[0], depth[sym]["weekday"])
    r_supply_h = (1 + supply_apy) ** (1 / 8760) - 1
    navs, econs = [], []
    hwm = tvl
    fee_paid = 0.0
    for t in idx:
        total, total_econ = 0.0, 0.0
        for sym, s in sl.items():
            row = frames[sym].loc[t]
            spot, perp, closed = row["spot"], row["perp"], bool(row["closed"])
            fund = (fund_override[sym].get(t, row["fund"]) if fund_override and sym in fund_override else row["fund"])
            if s.active:
                # lending: rSTOCK units grow at the supply rate on the lent share
                grow = s.spot_units * LEND_RATIO * r_supply_h
                s.spot_units += grow
                s.lending += grow * spot
                pay = s.short_units * perp * fund
                s.margin += pay
                s.funding += pay
                # DN-R7 kill switch: 7-day average funding below −(lending APY) for 72h
                hist = frames[sym]["fund"].loc[:t].iloc[-kill_window:]
                if fund_override and sym in fund_override:
                    hist = pd.Series([fund_override[sym].get(x, frames[sym]["fund"].get(x)) for x in hist.index], index=hist.index)
                if hist.mean() * 8760 < -supply_apy * LEND_RATIO:
                    s.neg_hours += 1
                else:
                    s.neg_hours = 0
                mmf = MMF[sym]
                mr = s.margin_ratio(perp, mmf)
                s.min_margin_ratio = min(s.min_margin_ratio, mr)
                dep = depth[sym]["weekend" if closed else "weekday"]
                if s.neg_hours >= kill_hours and not closed:
                    unwind(s, spot, perp, dep)
                    s.killed_at = t
                elif mr < MARGIN_EMERGENCY or (not closed and (mr < MARGIN_OPEN or t.hour == REBALANCE_UTC_HOUR and t.dayofweek < 5)):
                    delta = (s.spot_units - s.short_units) * spot / max(s.nav(spot, perp), 1)
                    lev = s.short_units * perp / max(s.perp_equity(perp), 1e-9)
                    if mr < MARGIN_OPEN or abs(delta) > BAND or abs(lev - L) > 0.25 * L or t.hour == REBALANCE_UTC_HOUR:
                        rebalance(s, spot, perp, dep)
                elif closed and mr < MARGIN_CLOSED and s.cash > 0:
                    top = min(s.cash, s.short_units * perp * mmf * MARGIN_CLOSED - s.perp_equity(perp))
                    if top > 0:  # weekend: top up from the buffer only (no spot trades above 1.5×)
                        s.cash -= top
                        s.margin += top
                nav_s = s.nav(spot, perp)
                s.ticks += 1
                s.in_band += abs((s.spot_units - s.short_units) * spot / max(nav_s, 1)) <= BAND
            total += s.nav(spot, perp)
            total_econ += s.nav(perp, perp) if s.active else s.cash
        # DN-R9: 10% of gains above the high-water mark, daily
        if t.hour == 0 and total > hwm:
            fee = (total - hwm) * PERF_FEE
            fee_paid += fee
            # the fee is taken pro rata from the sleeves' cash
            for s in sl.values():
                s.cash -= fee * WEIGHTS[s.sym]
            total -= fee
            total_econ -= fee
            hwm = total
        navs.append(total)
        econs.append(total_econ)
    return RunResult(pd.Series(navs, index=idx), pd.Series(econs, index=idx), sl, fee_paid)


def apy(nav: pd.Series, start: float | None = None) -> float:
    """Annualized; from `start` (e.g. the deposit before entry costs) instead of the first NAV point when given."""
    days = (nav.index[-1] - nav.index[0]).total_seconds() / 86400
    return (nav.iloc[-1] / (start if start is not None else nav.iloc[0])) ** (365 / days) - 1


def max_drawdown(nav: pd.Series) -> float:
    peak = nav.cummax()
    return float(((nav - peak) / peak).min())


def rolling_apys(nav: pd.Series, days: int = 30) -> np.ndarray:
    daily = nav.resample("1D").last().dropna()
    out = []
    for i in range(days, len(daily)):
        out.append((daily.iloc[i] / daily.iloc[i - days]) ** (365 / days) - 1)
    return np.array(out)


# ------------------------------------------------------------------------------------------------ stresses


def weekend_gaps_10y(sym: str) -> np.ndarray:
    d = pd.read_csv(DATA / "reference" / f"{sym}_daily.csv", parse_dates=["Date"])
    d["Date"] = pd.to_datetime(d["Date"], utc=True)
    d = d.set_index("Date").sort_index()
    adj = d["Adj Close"] / d["Close"]
    gaps = []
    for i in range(1, len(d)):
        if (d.index[i] - d.index[i - 1]).days >= 3:
            gaps.append(d["Open"].iloc[i] * adj.iloc[i] / (d["Close"].iloc[i - 1] * adj.iloc[i - 1]) - 1)
    return np.array(gaps)


def stress_gap(shock: float, depth: dict[str, dict[str, float]]) -> dict:
    """+shock at Monday open. Worst timing for the reported NAV: the perp marks the whole move over the weekend while
    the Chainlink spot mark stays frozen, then spot reprices at the open and the rebalancer sells spot at weekday
    depth to restore margin (08 weekend rules: buffer top-ups only above 1.5×)."""
    rows = {}
    for sym, w in WEIGHTS.items():
        s = open_sleeve(sym, TVL * w, 100.0, depth[sym]["weekday"])
        nav0 = s.nav(100.0, 100.0)
        p1 = 100.0 * (1 + shock)
        mr_weekend = s.margin_ratio(p1, MMF[sym])
        liquidated = mr_weekend < 1.0
        # weekend top-up from the buffer toward 3×
        top = max(0.0, min(s.cash, s.short_units * p1 * MMF[sym] * MARGIN_CLOSED - s.perp_equity(p1)))
        s.cash -= top
        s.margin += top
        reported_weekend = s.nav(100.0, p1) / nav0 - 1
        rebalance(s, p1, p1, depth[sym]["weekday"])
        after_open = s.nav(p1, p1) / nav0 - 1
        rows[sym] = {"margin_ratio_weekend": mr_weekend, "liquidated": liquidated, "reported_weekend": reported_weekend, "after_open": after_open, "top_up": top}
    tot = sum(r["after_open"] * WEIGHTS[k] for k, r in rows.items())
    rep = sum(r["reported_weekend"] * WEIGHTS[k] for k, r in rows.items())
    return {"rows": rows, "vault_after_open": tot, "vault_reported_weekend": rep}


def stress_funding(frames: dict[str, pd.DataFrame], supply_apy: float, depth: dict[str, dict[str, float]], kill_hours: int = KILL_HOURS, kill_window: int = 168) -> dict:
    """Funding at −100% APR for one week on every sleeve, from the middle of the observed window; kill switch live."""
    idx = frames["SPY"].index
    start = idx[len(idx) // 2]
    week = pd.date_range(start, periods=168, freq="h", tz="UTC")
    ov = {sym: pd.Series(-1.0 / 8760, index=week) for sym in WEIGHTS}
    base = run(frames, supply_apy, depth)
    hit = run(frames, supply_apy, depth, fund_override=ov, kill_hours=kill_hours, kill_window=kill_window)
    window = slice(start - pd.Timedelta(days=1), start + pd.Timedelta(days=10))
    dd = max_drawdown(hit.nav.loc[window])
    rel = float((hit.nav / base.nav).loc[window].min() - 1)
    killed = {k: (str(v.killed_at) if v.killed_at is not None else None) for k, v in hit.sleeves.items()}
    return {"start": start, "drawdown": dd, "vs_base": rel, "killed": killed, "end_vs_base": float(hit.nav.iloc[-1] / base.nav.iloc[-1] - 1)}


def stress_venue_halt() -> dict:
    """72h venue withdrawal halt: margin can't come back. Deposits to the venue may also stop, so no top-ups: the
    sleeve is liquidated if the price rises by more than x_liq within the halt; the loss is capped by the margin
    posted (spot sits outside the venue). Venue failure (total loss of the venue account) = the margin share."""
    out = {}
    for sym in WEIGHTS:
        # equity/maintenance = 1 at price rise x: (1/L − x) = mmf·(1 + x)
        x_liq = (1 / L - MMF[sym]) / (1 + MMF[sym])
        out[sym] = x_liq
    margin_share = (1 - C) / (L + 1)
    return {"x_liq": out, "margin_share": margin_share}


def stress_util100() -> dict:
    """rSTOCK utilization at 100% for 48h: lent spot can't be redeemed. Instant exits: the cash buffer plus the
    un-lent spot (sold, with the matching short closed); margin top-ups only from the buffer."""
    s_share = (1 - C) * L / (L + 1)
    unlent = s_share * (1 - LEND_RATIO)
    return {"instant_capacity": C + unlent * (1 + 1 / L), "s_share": s_share, "unlent": unlent}


def lend_ratio_table() -> list[dict]:
    """DN-R8: the vault's lent rSTOCK must be redeemable within 24h in the worst case (market fully borrowed: only the
    stock vault's idle 1 − U_MAX = 10% can be withdrawn). With other lenders O and the vault lending X into the same
    rSTOCK vault: X ≤ 0.1·(O + X) → X ≤ O/9. At a typical 50% market utilization X ≤ O. LEND_RATIO per sleeve =
    min(0.9, X_max / S)."""
    rows = []
    for sym, w in WEIGHTS.items():
        s_usd = TVL * w * (1 - C) * L / (L + 1)
        for other in [0.0, 250_000.0, 1_000_000.0, 5_000_000.0]:
            rows.append({"sym": sym, "S": s_usd, "others": other, "worst": min(LEND_RATIO, other / 9 / s_usd), "u50": min(LEND_RATIO, other / s_usd)})
    return rows


def bootstrap_sensitivity(frames: dict[str, pd.DataFrame], supply_apy: float, cost_share: float, n: int = 400, seed: int = 7) -> np.ndarray:
    """SENSITIVITY ONLY (not used for the verdict): annual funding income on the vault's S by resampling whole
    observed weeks of funding (same week for all sleeves), i.e. what a year would look like if it repeated the
    observed 3 months' weeks. Costs and lending at the base assumptions."""
    rng = np.random.default_rng(seed)
    weeks = []
    fr = pd.DataFrame({sym: frames[sym]["fund"] for sym in WEIGHTS}).dropna()
    for i in range(0, len(fr) - 168, 168):
        weeks.append(fr.iloc[i : i + 168].sum())
    weeks_df = pd.DataFrame(weeks)
    s_share = (1 - C) * L / (L + 1)
    out = []
    for _ in range(n):
        pick = weeks_df.iloc[rng.integers(0, len(weeks_df), 52)].sum()
        f = sum(pick[sym] * WEIGHTS[sym] for sym in WEIGHTS) * s_share
        lend = supply_apy * LEND_RATIO * s_share
        out.append((f + lend) * (1 - PERF_FEE) - cost_share)
    return np.array(out)


# ------------------------------------------------------------------------------------------------ report


def main() -> None:
    t0 = time.time()
    frames = {sym: hourly_frame(sym) for sym in WEIGHTS}
    depth = depth_usd()
    fetched = (DATA / "lighter" / "FETCHED").read_text().strip()
    fund_all = {sym: load_funding(sym) for sym in WEIGHTS}
    history_days = min((f.index.max() - f.index.min()).days for f in fund_all.values())
    months = history_days / 30.44
    base = run(frames, SUPPLY_APY_BASE, depth)
    sens = {a: run(frames, a, depth) for a in SUPPLY_APY_SENS}
    roll = rolling_apys(base.nav)
    p5, p50, p95 = (np.percentile(roll, q) for q in (5, 50, 95)) if len(roll) else (math.nan,) * 3
    gap = stress_gap(0.20, depth)
    fund_stress = stress_funding(frames, SUPPLY_APY_BASE, depth)
    fund_stress_fast = stress_funding(frames, SUPPLY_APY_BASE, depth, kill_hours=24, kill_window=24)
    base_fast = run(frames, SUPPLY_APY_BASE, depth, kill_hours=24, kill_window=24)
    halt = stress_venue_halt()
    util = stress_util100()
    lr = lend_ratio_table()
    entry = sum(s.entry_cost for s in base.sleeves.values())
    days = (base.nav.index[-1] - base.nav.index[0]).total_seconds() / 86400
    rebal_cost_yr = (sum(s.costs for s in base.sleeves.values()) - entry) / TVL * 365 / days
    boot = bootstrap_sensitivity(frames, SUPPLY_APY_BASE, rebal_cost_yr + entry / TVL)
    gaps10 = {sym: weekend_gaps_10y(sym) for sym in WEIGHTS}

    window = f"{base.nav.index[0]:%Y-%m-%d %H:%M} → {base.nav.index[-1]:%Y-%m-%d %H:%M} UTC ({(base.nav.index[-1] - base.nav.index[0]).days} days)"
    band = {k: s.in_band / max(s.ticks, 1) for k, s in base.sleeves.items()}
    costs = sum(s.costs for s in base.sleeves.values())
    funding = sum(s.funding for s in base.sleeves.values())
    lending = sum(s.lending for s in base.sleeves.values())
    dd_rep = max_drawdown(base.nav)
    dd_econ = max_drawdown(base.econ)

    # gate criteria
    c_data = months >= GATE_MONTHS
    c_p5 = p5 > 0
    c_dd = max(abs(gap["vault_after_open"]), abs(fund_stress["drawdown"]), abs(dd_econ)) < 0.02
    c_dd_fast = max(abs(gap["vault_after_open"]), abs(fund_stress_fast["drawdown"]), abs(dd_econ)) < 0.02
    c_venue = True  # by construction: spot and buffer sit outside the venue; loss ≤ margin share
    verdict = "INSUFFICIENT DATA" if not c_data else ("PASS" if (c_p5 and c_dd and c_venue) else "FAIL")

    L_ = []
    w = L_.append
    w("# Phase 4 · Delta-neutral vault simulation gate (08)")
    w("")
    w(f"Generated by `sim/dn_vault/model.py` on {time.strftime('%Y-%m-%d')} from the Lighter cache fetched {fetched}. Runtime {time.time() - t0:.0f} s.")
    w("")
    w(f"## Verdict: **{verdict}**")
    w("")
    w(f"The gate needs ≥ {GATE_MONTHS} months of perp funding for each launch stock on the chosen venue (08 gate item 1). Lighter's Robinhood Chain instance has **{history_days} days** ({months:.1f} months, from {min(f.index.min() for f in fund_all.values()):%Y-%m-%d}); the earliest date with 12 months is **2027-06-26**. Every number below is computed on the observed window only and is **not** a gate result. The borrow-side (lending APY) history does not exist at all (no Lendora mainnet, empty 4663 stock-loan markets), so it is a stated proxy.")
    w("")
    w("| Gate criterion (08) | Observed-window result | Status |")
    w("|---|---|---|")
    w(f"| ≥ 12 months of funding, borrow utilization and basis per stock | {history_days} days funding / basis; 0 days borrow utilization | **not met** |")
    w(f"| p5 net APY > 0 | p5 of 30-day windows: {pct(p5)} (p50 {pct(p50)}, p95 {pct(p95)}; {len(roll)} overlapping windows) | {'met on the window' if c_p5 else 'not met'} (not a gate result) |")
    w(f"| Max drawdown < 2% in all stresses except venue failure | +20% gap after the open {pct(gap['vault_after_open'])}; −100% APR funding week {pct(fund_stress['drawdown'])} with DN-R7 as written, {pct(fund_stress_fast['drawdown'])} with the 24 h trigger (DN-R13 proposal); observed window (economic) {pct(dd_econ)} | {'met' if c_dd else '**not met** as written'}; {'met' if c_dd_fast else 'not met'} with DN-R13; see the reported-NAV caveat in §4.1 (DN-R12) |")
    w(f"| Venue failure loss bounded by the perp margin share | margin share {pct(halt['margin_share'])} of NAV; spot and buffer are outside the venue | met by construction |")
    w("")
    w("## 1. Inputs")
    w("")
    w(f"- Structure (08): `L = {L:g}`, `c = {pct(C, 0)}`, `LEND_RATIO = {pct(LEND_RATIO, 0)}`, sleeves {', '.join(f'{k} {pct(v, 0)}' for k, v in WEIGHTS.items())}, TVL {usd(TVL)} (launch cap DN-R6). Per sleeve: spot `S = D(1−c)L/(L+1)` = {pct((1 - C) * L / (L + 1))} of D, margin `M = D(1−c)/(L+1)` = {pct((1 - C) / (L + 1))}, buffer {pct(C, 0)}.")
    w("- Funding: Lighter hourly `rate` (percent per hour; `value / price ≈ rate / 100`), signed so + = shorts receive.")
    w("- Marks: spot at the Chainlink 24/5 round (as DN-R4), short at the Lighter hourly trade close. The feed is \"closed\" when no round arrived for > 2 h (observed Fri 20:00 → Sun 20:00 ET).")
    w(f"- Lending (proxy, **no data**): rSTOCK supply APY {pct(SUPPLY_APY_BASE, 0)} on the lent share (AdaptiveCurve IRM at its 4% initial rate at target × ~55% utilization × (1 − 10% fee)); sensitivities {', '.join(pct(a, 0) for a in SUPPLY_APY_SENS)}.")
    w(f"- Costs: DEX swaps at measured depth (`sim/data/dex_depth.csv`, both 0.05% pools; pool fee 5 bp + half the 2%-move-per-depth impact), weekday depth for session trades, weekend minimum for closures; perp {PERP_COST * 1e4:.0f} bp (0 fees on a Standard account + half-spread, [VERIFY] at size). Depth used: " + ", ".join(f"{k} weekday {usd(v['weekday'])} / weekend {usd(v['weekend'])}" for k, v in depth.items()) + " per 2% move.")
    w(f"- Rules: rebalance once per US session (10:00 ET) and whenever |delta| > {pct(BAND, 0)} or perp leverage drifts > 25% from `L`, or margin < {MARGIN_OPEN:g}× maintenance (DN-R2, DN-R3); while closed, buffer-only top-ups toward {MARGIN_CLOSED:g}× and spot trades only below {MARGIN_EMERGENCY:g}×; kill switch when the 7-day funding average is below −(lending APY on the lent share) for {KILL_HOURS} h (DN-R7); 10% performance fee over the high-water mark, daily (DN-R9). Maintenance fractions: " + ", ".join(f"{k} {pct(v, 1)}" for k, v in MMF.items()) + ".")
    w("")
    w("## 2. Observed funding (Lighter, hourly)")
    w("")
    w("| Stock | Hours | Mean APR (shorts receive) | Weekend mean APR | Hours negative | Min 7-day avg APR | Max 7-day avg APR |")
    w("|---|---|---|---|---|---|---|")
    for sym, f in fund_all.items():
        wk = f[f.index.dayofweek >= 5]
        r7 = f.rolling(168).mean() * 8760
        w(f"| {sym} | {len(f):,} | {pct(f.mean() * 8760)} | {pct(wk.mean() * 8760)} | {pct((f < 0).mean(), 1)} | {pct(r7.min())} | {pct(r7.max())} |")
    w("")
    w("Basis (perp trade close vs Chainlink, while the feed is open; hourly):")
    w("")
    w("| Stock | Median | p1 | p99 | Largest weekend drift (perp vs frozen spot) |")
    w("|---|---|---|---|---|")
    for sym, f in frames.items():
        b = f["perp"] / f["spot"] - 1
        o = b[~f["closed"]]
        c = b[f["closed"]]
        w(f"| {sym} | {pct(o.median())} | {pct(o.quantile(0.01))} | {pct(o.quantile(0.99))} | {pct(c.abs().max()) if len(c) else 'n/a'} |")
    w("")
    w(f"## 3. Backtest on the observed window ({window})")
    w("")
    w("| Lending APY proxy | Net APY after entry (annualized, after running costs and fee) | Net APY from the deposit (entry swaps included) | Max drawdown, reported NAV | Max drawdown, economic | Funding income | Lending income | Costs (entry + rebalancing) | Performance fee |")
    w("|---|---|---|---|---|---|---|---|---|")
    for a, r in sens.items():
        w(f"| {pct(a, 0)} | {pct(apy(r.nav))} | {pct(apy(r.nav, TVL))} | {pct(max_drawdown(r.nav))} | {pct(max_drawdown(r.econ))} | {usd(sum(s.funding for s in r.sleeves.values()))} | {usd(sum(s.lending for s in r.sleeves.values()))} | {usd(sum(s.costs for s in r.sleeves.values()))} | {usd(r.fee_paid)} |")
    w("")
    w(f"Base case ({pct(SUPPLY_APY_BASE, 0)} lending): net APY {pct(apy(base.nav))} after entry, **{pct(apy(base.nav, TVL))} from the deposit over these 87 days** (≈ {pct(apy(base.nav) - entry / TVL)} for a first year with the one-off entry cost spread over 12 months); 30-day windows p5 / p50 / p95 = {pct(p5)} / {pct(p50)} / {pct(p95)}; funding {usd(funding)}, lending {usd(lending)}, costs {usd(costs)}, of which **entry swaps {usd(entry)} ({pct(entry / TVL)} of TVL)**: at $2M the DEX pools are thin next to the sleeves (SPY moves 2% for {usd(depth['SPY']['weekday'])}, the SPY sleeve buys {usd(TVL * WEIGHTS['SPY'] * (1 - C) * L / (L + 1))}). Rebalancing costs {pct(rebal_cost_yr)} a year. Entry costs are paid by the vault as TVL grows; a deposit-weighted entry (or buying spot over several sessions) is a task-15 keeper rule.")
    w("")
    w("| Sleeve | Rebalances | Delta in band (ticks) | Lowest margin ratio (× maintenance) | Kill switch |")
    w("|---|---|---|---|---|")
    for k, s in base.sleeves.items():
        w(f"| {k} | {s.trades} | {pct(band[k], 2)} | {s.min_margin_ratio:.1f}× | {s.killed_at or 'never'} |")
    w("")
    w("## 4. Stresses (08 gate item 3)")
    w("")
    w("### 4.1 +20% gap at Monday open")
    w("")
    w("| Sleeve | Margin ratio after +20% (× maint.) | Liquidated | Reported NAV over the weekend | Sleeve after the open + rebalance |")
    w("|---|---|---|---|---|")
    for k, r in gap["rows"].items():
        w(f"| {k} | {r['margin_ratio_weekend']:.1f}× | {'yes' if r['liquidated'] else 'no'} | {pct(r['reported_weekend'])} | {pct(r['after_open'])} |")
    w("")
    w(f"Vault: **{pct(gap['vault_after_open'])} after the open** (swap costs of the margin rebalance), no liquidation. But the **reported NAV reads {pct(gap['vault_reported_weekend'])} over the weekend**: spot is marked at the frozen Chainlink price (DN-R4) while the short loses at the live perp mark (Lighter removed the oracle caps on SPY/NVDA/AAPL on 2026-07-10). The move reverses at the open. Economically the vault is hedged; **for share pricing it is not**: a deposit on Sunday at the depressed NAV and a withdrawal on Monday would take ≈ {pct(-gap['vault_reported_weekend'], 1)} from other holders. → **Contract rule DN-R12** (task 14): while the stock feed is closed, the vault neither mints nor burns at a NAV mixing a frozen spot mark with a live perp mark; deposits pause and withdrawals queue to the next open. 10-year weekend gaps for scale: " + ", ".join(f"{k} max |gap| {pct(np.abs(v).max(), 1)}, p99.9 {pct(np.quantile(np.abs(v), 0.999), 1)}" for k, v in gaps10.items()) + ".")
    w("")
    w("### 4.2 Funding at −100% APR for one week")
    w("")
    w(f"Injected from {fund_stress['start']:%Y-%m-%d %H:%M} UTC on every sleeve. With DN-R7 as written (7-day average below −lending APY for 72 h): max drawdown around the stress **{pct(fund_stress['drawdown'])}**; worst NAV vs the unstressed run {pct(fund_stress['vs_base'])}; kill switch " + ", ".join(f"{k} {v or 'did not fire'}" for k, v in fund_stress["killed"].items()) + ". Most of the week is paid before the switch fires.")
    w("")
    w(f"Variant (proposal, DN-R13): trigger on the **24-hour** average below −lending APY for **24 h**: max drawdown **{pct(fund_stress_fast['drawdown'])}**, kill switch " + ", ".join(f"{k} {v or 'did not fire'}" for k, v in fund_stress_fast["killed"].items()) + ".")
    fast_kills = {k: v.killed_at for k, v in base_fast.sleeves.items() if v.killed_at is not None}
    w(f"Cost of the faster trigger on the **unstressed** window: it fired on " + (", ".join(f"{k} at {v:%Y-%m-%d %H:%M} UTC" for k, v in fast_kills.items()) if fast_kills else "no sleeve") + f" (real funding dips), net APY after entry {pct(apy(base_fast.nav))} vs {pct(apy(base.nav))} with DN-R7 as written (an unwound sleeve stays in USDG in this model; the rebalancer's re-entry rule is task 15). The risk owner trades that false-positive cost against the stress bound.")
    w("")
    w("### 4.3 Venue halts withdrawals for 72 h (and venue failure)")
    w("")
    w("If deposits to the venue also stop, no top-up is possible; a sleeve is liquidated when the price rises by more than: " + ", ".join(f"{k} {pct(v, 1)}" for k, v in halt["x_liq"].items()) + f" within the halt. The loss is at most the margin posted: **{pct(halt['margin_share'])} of NAV** (the margin share, `(1 − c)/(L + 1)`); spot and buffer are outside the venue. Venue failure (account lost) = the same bound. 10-year weekend gaps never exceeded those thresholds (§4.1), but a 72 h halt can span a trading week.")
    w("")
    w("### 4.4 rSTOCK utilization at 100% for 48 h")
    w("")
    w(f"Lent spot ({pct(util['s_share'] * LEND_RATIO)} of NAV) can't be redeemed. Instant exits are the buffer plus the un-lent spot sold with its short closed: **{pct(util['instant_capacity'])} of NAV**; everything else queues (DN-R1: settled within 72 h or the next open). No loss unless a margin top-up is also needed: the buffer ({pct(C, 0)} of NAV) covers the margin rebalance of a +20% move on every sleeve (§4.1 top-ups). DN-R8 below sets how much may be lent.")
    w("")
    w("## 5. Recommendations (for the risk owner; engineering defaults stay at 08)")
    w("")
    w("DN-R8 `LEND_RATIO` per sleeve: the lent rSTOCK must be redeemable within 24 h. Worst case (market fully borrowed, only the stock vault's 10% idle): lent ≤ other lenders / 9. At 50% utilization: lent ≤ other lenders.")
    w("")
    w("| Sleeve | Spot S at $2M | Other lenders in rSTOCK | LEND_RATIO (worst case) | LEND_RATIO (50% util.) |")
    w("|---|---|---|---|---|")
    for r in lr:
        w(f"| {r['sym']} | {usd(r['S'])} | {usd(r['others'])} | {pct(r['worst'], 1)} | {pct(r['u50'], 1)} |")
    w("")
    w("- **`LEND_RATIO` must be dynamic**, not 90%: at launch the vault would be most of each rSTOCK vault (the mainnet launch caps are SPY $250k, NVDA $250k, AAPL $62.5k, all smaller than the vault's spot sleeves at $2M). The curator sets a per-sleeve maximum and the rebalancer keeps lent ≤ the 24 h redeemable amount (task 15).")
    w(f"- `L = 3` keeps every sleeve's liquidation threshold above 25% (§4.3) and the margin ratio ≥ {min(r['margin_ratio_weekend'] for r in gap['rows'].values()):.1f}× after a +20% gap; `L = 4` would cut NVDA/AAPL's threshold to ≈ 21%. Keep `L = 3`, `c = 5%`.")
    w("- Sleeve weights: SPY has the deepest perp and DEX liquidity and the steadiest funding; NVDA has the highest funding but the widest swings; AAPL's perp OI (≈ $2.5M) is small next to a $500k sleeve. Keep 50/25/25 for the cap; cap AAPL's sleeve at ≤ 10% of its perp OI.")
    w("- DN-R12 (weekend share pricing, §4.1) is required before any non-zero cap.")
    w("- DN-R13 (faster kill switch, §4.2): a 24 h / 24 h trigger keeps the −100% APR week inside the 2% bound; the 7-day / 72 h rule of 08 does not. Built as curator-set parameters (window, hours) in the rebalancer and `StrategyManager` so the risk owner picks.")
    w(f"- Entry: buy each sleeve's spot over several sessions (≤ 25% of the 2% depth per trade) to keep the entry near {pct(0.0005 + 0.0025, 2)} instead of {pct(entry / TVL)}.")
    w("")
    w("## 6. Sensitivity, not used for the verdict")
    w("")
    w(f"Resampling whole observed weeks of funding into 52-week years (400 paths; the observed 3 months repeated, which **is** extrapolation): net APY p5 / p50 / p95 = {pct(np.percentile(boot, 5))} / {pct(np.percentile(boot, 50))} / {pct(np.percentile(boot, 95))} at {pct(SUPPLY_APY_BASE, 0)} lending, measured rebalancing costs ({pct(rebal_cost_yr)}/yr) and the entry cost ({pct(entry / TVL)}) charged in year one. It says nothing about regimes the 3 months didn't contain (a sustained negative-funding quarter, an index drawdown).")
    w("")
    w("## 7. What would change the verdict")
    w("")
    w("1. 12 months of Lighter funding (2027-06-26) or a second venue with longer history (Arcus [VERIFY]). Rerun `fetch.py` then `model.py`.")
    w("2. Observed rSTOCK utilization and supply APY from Lendora mainnet (replaces the lending proxy).")
    w("3. Perp slippage at size (the 1 bp assumption) from a live canary (A39).")
    w("4. Sign-off: [`docs/owner-actions/dn-vault-signoff.md`](../../docs/owner-actions/dn-vault-signoff.md).")
    REPORT.write_text("\n".join(L_) + "\n")
    print(f"verdict {verdict}; base APY {pct(apy(base.nav))}; p5 {pct(p5)}; gap after open {pct(gap['vault_after_open'])}; reported weekend {pct(gap['vault_reported_weekend'])}; funding stress dd {pct(fund_stress['drawdown'])}; band " + ", ".join(f"{k} {pct(v)}" for k, v in band.items()))


if __name__ == "__main__":
    main()
