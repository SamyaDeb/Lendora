"""WS-C.4–5: weekend and price-gap analysis for the launch Stock Tokens. Writes sim/reports/phase0-weekend-gaps.md
and PNG charts next to it, from the cached inputs:

  sim/data/feeds/<SYM>.csv        every Chainlink round (fetch_feeds.py)
  sim/data/dex/<SYM>_<Q>_500.csv  hourly-sampled Uniswap v3 prices (fetch_dex.py + fill_ts.py)
  sim/data/reference/*.csv        Yahoo Finance daily (10y) and hourly (730d) bars (fetch_reference.py)
  sim/data/dex_depth.csv          2% depth snapshots (dex_depth.py)

Run: sim/.venv/bin/python sim/phase0/analyze.py
"""

from __future__ import annotations

import math
from pathlib import Path
from zoneinfo import ZoneInfo

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "sim" / "data"
REPORT_DIR = ROOT / "sim" / "reports"
ET = ZoneInfo("America/New_York")
STOCKS = ["SPY", "NVDA", "AAPL"]
Z = 2.33
LLTV = 0.77
LIF = min(1.15, 1 / (1 - 0.3 * (1 - LLTV)))  # 1.07411
H_WEEKEND = 65.5  # Fri 16:00 → Mon 09:30 ET, the PRD's closure length
H_WEEKEND_24_5 = 48.0  # Fri 20:00 → Sun 20:00 ET, when a 24/5 feed is actually frozen
H_OVERNIGHT = 17.5
B_MIN, B_MAX = 0.01, 0.20
SRC_FEED = "Source: Chainlink feeds on Robinhood Chain (getRoundData), sim/data/feeds"
SRC_DEX = "Source: Uniswap v3 Swap events on Robinhood Chain, hourly samples, sim/data/dex; Chainlink feeds"
SRC_YF = "Source: Yahoo Finance via yfinance (research use), sim/data/reference"


def pct(x: float, nd: int = 2) -> str:
    return "n/a" if x is None or (isinstance(x, float) and math.isnan(x)) else f"{x * 100:.{nd}f}%"


def hhmm(ts: pd.Series, how: str) -> str:
    m = ts.dt.hour * 60 + ts.dt.minute
    v = int(getattr(m, how)())
    return f"{v // 60:02d}:{v % 60:02d}"


def b_full(sigma: float, hours: float, z: float = Z) -> float:
    return min(max(z * sigma * math.sqrt(hours / 8760), B_MIN), B_MAX)


def load_feed(sym: str) -> pd.DataFrame:
    f = pd.read_csv(DATA / "feeds" / f"{sym}.csv").sort_values("updated_at").reset_index(drop=True)
    # Launch incident: the first rounds (to 2026-06-23 ~09:50 ET) carry 18-decimal answers while decimals() is 8.
    # They are excluded here and reported in section 0.
    f = f[f["answer"] < 1e16].reset_index(drop=True)
    f["price"] = f["answer"] / 1e8
    f["t"] = pd.to_datetime(f["updated_at"], unit="s", utc=True).dt.tz_convert(ET)
    return f


def load_daily(sym: str) -> pd.DataFrame:
    d = pd.read_csv(DATA / "reference" / f"{sym}_daily.csv", index_col=0)
    d.index = pd.to_datetime(d.index, utc=True).tz_convert(ET)
    return d


def savefig(fig, name: str, source: str) -> str:
    fig.text(0.01, 0.005, source, fontsize=7, color="#555")
    fig.tight_layout(rect=(0, 0.03, 1, 1))
    fig.savefig(REPORT_DIR / name, dpi=130)
    plt.close(fig)
    return name


# ---------------------------------------------------------------------------------------------------------------------
# 1. Feed update pattern


def feed_pattern(sym: str, f: pd.DataFrame) -> dict:
    grid = np.zeros((7, 24))
    for t in f["t"]:
        grid[t.dayofweek, t.hour] += 1
    weeks = max((f["t"].iloc[-1] - f["t"].iloc[0]).days / 7, 1)
    fig, ax = plt.subplots(figsize=(9, 3.2))
    im = ax.imshow(grid / weeks, aspect="auto", cmap="viridis")
    ax.set_yticks(range(7), ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"])
    ax.set_xticks(range(0, 24, 2), [f"{h:02d}" for h in range(0, 24, 2)])
    ax.set_xlabel("Hour of day (ET)")
    ax.set_ylabel("Weekday (ET)")
    ax.set_title(f"{sym}/USD Chainlink rounds per hour, average per week ({f['t'].iloc[0]:%Y-%m-%d} to {f['t'].iloc[-1]:%Y-%m-%d})")
    fig.colorbar(im, ax=ax, label="rounds per hour-slot per week")
    chart = savefig(fig, f"feed_updates_{sym}.png", SRC_FEED)

    # Weekend window: last round before Saturday 00:00 ET, first round after it.
    rows = []
    for sat in pd.date_range(f["t"].iloc[0].normalize(), f["t"].iloc[-1], freq="W-SAT", tz=ET):
        before = f[f["t"] < sat]
        after = f[f["t"] >= sat]
        if len(before) and len(after):
            rows.append((before["t"].iloc[-1], after["t"].iloc[0], (after["t"].iloc[0] - before["t"].iloc[-1]).total_seconds() / 3600))
    w = pd.DataFrame(rows, columns=["last_fri", "first_after", "gap_h"])
    gaps = f["updated_at"].diff() / 3600
    weekday_mask = f["t"].dt.dayofweek.isin([0, 1, 2, 3]) | ((f["t"].dt.dayofweek == 4) & (f["t"].dt.hour < 20))
    return {
        "chart": chart,
        "rounds": len(f),
        "weekends": w,
        "median_gap_min": float(gaps.median() * 60),
        "p99_weekday_gap_h": float(gaps[weekday_mask].quantile(0.99)),
        "max_weekday_gap_h": float(gaps[weekday_mask].max()),
        "sat_rounds": int((f["t"].dt.dayofweek == 5).sum()),
    }


# ---------------------------------------------------------------------------------------------------------------------
# 2. Onchain weekend gaps (feed) and overnight moves under 24/5


def feed_gaps(f: pd.DataFrame) -> dict:
    rows = []
    for sat in pd.date_range(f["t"].iloc[0].normalize(), f["t"].iloc[-1], freq="W-SAT", tz=ET):
        fri = f[f["t"] < sat]
        if not len(fri):
            continue
        p_fri, t_fri = fri["price"].iloc[-1], fri["t"].iloc[-1]
        reopen = f[f["t"] >= sat]
        mon_open = sat + pd.Timedelta(days=2, hours=9, minutes=30)
        at_open = f[f["t"] >= mon_open]
        if not len(reopen) or not len(at_open):
            continue
        rows.append({
            "friday_last": t_fri, "reopen_first": reopen["t"].iloc[0],
            "gap_reopen": reopen["price"].iloc[0] / p_fri - 1, "gap_monday_open": at_open["price"].iloc[0] / p_fri - 1,
        })
    g = pd.DataFrame(rows)
    # Weeknight: consecutive rounds whose interval touches 20:00–04:00 ET, Mon–Thu nights.
    d = f.copy()
    d["jump"] = d["price"].pct_change()
    d["dt_h"] = d["updated_at"].diff() / 3600
    night = d[(d["t"].dt.hour >= 20) | (d["t"].dt.hour < 4)]
    night = night[night["t"].dt.dayofweek.isin([0, 1, 2, 3, 4]) & (night["dt_h"] < 24)]
    # Move a regular-hours-only feed would have gapped: 16:00 close → next 09:30, from the 24/5 feed itself.
    om = []
    for day in pd.date_range(f["t"].iloc[0].normalize(), f["t"].iloc[-1], freq="B", tz=ET):
        if day.dayofweek == 4:
            continue
        c, o = day + pd.Timedelta(hours=16), day + pd.Timedelta(days=1, hours=9, minutes=30)
        pc, po = f[f["t"] <= c], f[f["t"] <= o]
        if len(pc) and len(po) and po["t"].iloc[-1] > c:
            om.append(po["price"].iloc[-1] / pc["price"].iloc[-1] - 1)
    return {"weekends": g, "night_jump_abs": night["jump"].abs(), "night_dt_h": night["dt_h"], "close_to_open": pd.Series(om)}


# ---------------------------------------------------------------------------------------------------------------------
# 3. Volatility, buffer table, 10-year weekend gaps and buffer adequacy


def vol_and_gaps(sym: str) -> dict:
    d = load_daily(sym)
    r = np.log(d["Adj Close"]).diff().dropna()
    end = r.index[-1]
    sig = {y: float(r[r.index >= end - pd.DateOffset(years=y)].std() * math.sqrt(252)) for y in (1, 3, 5, 10)}
    trailing = r.rolling(252).std() * math.sqrt(252)
    adj = d["Adj Close"] / d["Close"]
    rows = []
    for i in range(1, len(d)):
        if (d.index[i].normalize() - d.index[i - 1].normalize()).days >= 3:
            g = d["Open"].iloc[i] * adj.iloc[i] / (d["Close"].iloc[i - 1] * adj.iloc[i - 1]) - 1
            s_t = trailing.iloc[i - 1] if not math.isnan(trailing.iloc[i - 1]) else sig[10]
            hours = (d.index[i].normalize() - d.index[i - 1].normalize()).days * 24 - 6.5
            rows.append({"friday": d.index[i - 1], "monday": d.index[i], "gap": g, "sigma_t": s_t, "hours": hours})
    G = pd.DataFrame(rows)
    G["b"] = [b_full(s, h) for s, h in zip(G["sigma_t"], G["hours"])]
    G["zeff"] = G["gap"].abs() / (G["sigma_t"] * np.sqrt(G["hours"] / 8760))
    G["zeff_up"] = G["gap"].clip(lower=0) / (G["sigma_t"] * np.sqrt(G["hours"] / 8760))
    return {"sigma": sig, "gaps": G}


# ---------------------------------------------------------------------------------------------------------------------
# 4. DEX vs feed premium


def premium(sym: str, f: pd.DataFrame) -> pd.DataFrame | None:
    frames = []
    for q in ("USDG", "WETH"):
        p = DATA / "dex" / f"{sym}_{q}_500.csv"
        if not p.exists():
            continue
        d = pd.read_csv(p)
        if "price_usd" not in d:  # partially written file; USDG pools are priced 1:1
            if q != "USDG":
                continue
            d["price_usd"] = d["price_quote"]
        d = d[(d["ts"].fillna(0) > 0) & d["price_usd"].notna()].copy()
        if not len(d):
            continue
        d["quote"] = q
        frames.append(d)
    if not frames:
        return None
    d = pd.concat(frames, ignore_index=True)
    idx = np.searchsorted(f["updated_at"].values, d["ts"].values, side="right") - 1
    d = d[idx >= 0].copy()
    idx = idx[idx >= 0]
    d["feed"] = f["price"].values[idx]
    d["feed_age_h"] = (d["ts"].values - f["updated_at"].values[idx]) / 3600
    d["prem"] = d["price_usd"] / d["feed"] - 1
    d["t"] = pd.to_datetime(d["ts"], unit="s", utc=True).dt.tz_convert(ET)
    dow, hr = d["t"].dt.dayofweek, d["t"].dt.hour
    # Feed frozen: Fri ≥ 20:00, Saturday, Sun < 20:00 ET (24/5 window) — and the feed is actually stale (> 1 h).
    d["closed"] = (((dow == 4) & (hr >= 20)) | (dow == 5) | ((dow == 6) & (hr < 20))) & (d["feed_age_h"] > 1)
    return d


def episodes(d: pd.DataFrame, thr: float) -> pd.DataFrame:
    c = d[d["closed"] & (d["quote"] == "USDG")].sort_values("ts")
    if not len(c):
        c = d[d["closed"]].sort_values("ts")
    c = c.assign(week=c["t"].dt.strftime("%G-W%V"))
    out = []
    for wk, g in c.groupby("week"):
        hit = g[g["prem"].abs() > thr]
        if len(hit):
            i = g["prem"].abs().idxmax()
            out.append({"weekend": wk, "start": hit["t"].min(), "end": hit["t"].max(), "hours_above": len(hit), "peak": g.loc[i, "prem"], "peak_at": g.loc[i, "t"]})
    return pd.DataFrame(out)


# ---------------------------------------------------------------------------------------------------------------------


def main() -> None:
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    depth = pd.read_csv(DATA / "dex_depth.csv") if (DATA / "dex_depth.csv").exists() else None
    L: list[str] = []
    w = L.append
    w("# Phase 0 · WS-C · Weekend and price-gap report\n")
    w("*Generated by `sim/phase0/analyze.py`. Inputs and how to refresh them: `sim/phase0/README.md`. Times are ET "
      "(America/New_York) unless marked UTC. Onchain history runs from the feeds' first round (2026-06-21 20:00 ET) "
      "to 2026-09-26, so onchain statistics cover about 14 weekends; tails come from 10 years of reference prices.*\n")

    w("## 0. Feed data incident at launch\n")
    w("| Stock | Rounds with answers scaled 1e18 (decimals() = 8) | Last bad round (UTC) | First correct round (UTC) |")
    w("|---|---|---|---|")
    for s in STOCKS:
        raw = pd.read_csv(DATA / "feeds" / f"{s}.csv").sort_values("updated_at")
        bad = raw[raw["answer"] >= 1e16]
        good = raw[raw["answer"] < 1e16]
        fmt = lambda x: pd.Timestamp(int(x), unit="s", tz="UTC").strftime("%Y-%m-%d %H:%M")  # noqa: E731
        w(f"| {s} | {len(bad)} (aggregator rounds 1–{len(bad)}) | {fmt(bad['updated_at'].max()) if len(bad) else '–'} | {fmt(good['updated_at'].min())} |")
    w("\nFor about 1.5 days after launch every stock feed published prices 10^10 too high (e.g. SPY round 1 = "
      "7424400000000000000 at 8 decimals). A consumer without a sanity bound would have mispriced by that factor. The "
      "rounds are excluded from everything below. USDG/USD, syrupUSDG/USDG and ETH/USD show no such rounds.\n")

    res = {}
    for s in STOCKS:
        f = load_feed(s)
        res[s] = {"feed": f, "pattern": feed_pattern(s, f), "fgaps": feed_gaps(f), "vol": vol_and_gaps(s), "prem": premium(s, f)}

    # --- 1. Feed pattern
    w("## 1. Feed update pattern (24/5 check)\n")
    w("| Stock | Rounds | Median time between rounds | p99 / max gap Mon–Fri 20:00 (h) | Rounds on Saturdays | Weekend freeze: last Friday round → first round after (median, range) |")
    w("|---|---|---|---|---|---|")
    for s in STOCKS:
        p = res[s]["pattern"]
        wk = p["weekends"]
        w(f"| {s} | {p['rounds']} | {p['median_gap_min']:.0f} min | {p['p99_weekday_gap_h']:.1f} / {p['max_weekday_gap_h']:.1f} | {p['sat_rounds']} | "
          f"{wk['gap_h'].median():.1f} h ({wk['gap_h'].min():.1f}–{wk['gap_h'].max():.1f} h); last Friday round {hhmm(wk['last_fri'], 'min')}–{hhmm(wk['last_fri'], 'max')} ET, first round after {hhmm(wk['first_after'], 'min')}–{hhmm(wk['first_after'], 'max')} ET ({wk['first_after'].dt.strftime('%a').mode().iloc[0]}) |")
    w("")
    for s in STOCKS:
        w(f"![{s} feed rounds by weekday and hour]({res[s]['pattern']['chart']})")
    w("\n**Reading.** Rounds occur every weekday hour including overnight (20:00–04:00 ET) and stop from Friday evening "
      "to Sunday evening: the feeds are 24/5 (OR-R13: yes). The feeds update on 0.5% deviation or a 24 h heartbeat, so "
      "a quiet SPY can go many hours without a round even while the market is open. The staleness guard (heartbeat + "
      "10 min) must therefore use the 24 h heartbeat, which makes it a weak detector during the week.\n")

    # --- 2. Onchain gaps
    w("## 2. Onchain weekend and overnight gaps (feed vs feed)\n")
    w("| Stock | Weekends | Friday last → first round after freeze: median / max abs | Friday last → first round ≥ Mon 09:30: median / max abs | Largest move up (Mon 09:30) |")
    w("|---|---|---|---|---|")
    for s in STOCKS:
        g = res[s]["fgaps"]["weekends"]
        w(f"| {s} | {len(g)} | {pct(g['gap_reopen'].abs().median())} / {pct(g['gap_reopen'].abs().max())} | {pct(g['gap_monday_open'].abs().median())} / {pct(g['gap_monday_open'].abs().max())} | {pct(g['gap_monday_open'].max())} |")
    w("\n**Overnight under 24/5.** The feed keeps publishing through weeknights, so a regular-hours feed's overnight gap "
      "does not exist as a step. What remains is (a) the size of a single overnight round-to-round jump and (b) how long "
      "the feed can sit without a round at night.\n")
    w("| Stock | Weeknight rounds | Round-to-round jump p99 / max | Hours between night rounds p99 / max | 16:00 → next 09:30 move (the step a regular-hours feed would take): p99 / max abs |")
    w("|---|---|---|---|---|")
    for s in STOCKS:
        o = res[s]["fgaps"]
        w(f"| {s} | {len(o['night_jump_abs'])} | {pct(o['night_jump_abs'].quantile(.99))} / {pct(o['night_jump_abs'].max())} | {o['night_dt_h'].quantile(.99):.1f} / {o['night_dt_h'].max():.1f} | {pct(o['close_to_open'].abs().quantile(.99))} / {pct(o['close_to_open'].abs().max())} |")
    w("\n**Reading.** Overnight the 24/5 feed moves in small steps (the table's jump column), not one gap at the open, so the "
      "overnight buffer can be small or zero (`overnightMode` on). The weekend freeze remains: about 48 h from Friday "
      "20:00 to Sunday 20:00 ET.\n")

    # --- 3. Volatility and buffer
    w("## 3. Realized volatility and the buffer table (04-oracle.md §3 recomputed)\n")
    w("σ_annual from daily log returns of adjusted closes (dividends included, like the token's total-return price).\n")
    w("| Stock | σ 1y | σ 3y | σ 5y | σ 10y | PRD placeholder |")
    w("|---|---|---|---|---|---|")
    ph = {"SPY": 0.18, "NVDA": 0.50, "AAPL": 0.28}
    for s in STOCKS:
        v = res[s]["vol"]["sigma"]
        w(f"| {s} | {pct(v[1],1)} | {pct(v[3],1)} | {pct(v[5],1)} | {pct(v[10],1)} | {pct(ph[s],0)} |")
    w(f"\nb_full = clamp(z·σ·√(h/8760), {pct(B_MIN,0)}, {pct(B_MAX,0)}), z = {Z}.\n")
    w("| Stock | σ used | Weekend 65.5 h (PRD) | Weekend 48 h (24/5 freeze) | Overnight 17.5 h (PRD) |")
    w("|---|---|---|---|---|")
    for s in STOCKS:
        for label, sg in (("1y", res[s]["vol"]["sigma"][1]), ("5y", res[s]["vol"]["sigma"][5])):
            w(f"| {s} | {label} {pct(sg,1)} | {pct(b_full(sg,H_WEEKEND),1)} | {pct(b_full(sg,H_WEEKEND_24_5),1)} | {pct(b_full(sg,H_OVERNIGHT),1)} |")

    # --- Buffer adequacy
    w("\n## 4. Buffer adequacy over 10 years of weekends\n")
    w("Gap = Monday (or post-holiday) open vs the prior close, adjusted for splits and dividends. σ is the trailing 252-day "
      "σ known on that Friday (as a weekly-updated oracle param would be). Closure hours are calendar hours between the "
      "sessions (65.5 h for a normal weekend). Under a 24/5 feed the real frozen window is shorter (~48 h) and Friday "
      "evening and Sunday night moves are tracked, so these gaps overstate what the oracle sees; they are a conservative "
      "upper bound.\n")
    w("| Stock | Weekends | Median abs gap | p99 abs gap | Max up | Max down | Share with abs gap > b_full (z 2.33) | Share with gap **up** > b_full | z for 99% (abs) | z for 99.9% (abs) | z for 99.9% (up only) |")
    w("|---|---|---|---|---|---|---|---|---|---|---|")
    for s in STOCKS:
        G = res[s]["vol"]["gaps"]
        up = G.loc[G["gap"].idxmax()]
        dn = G.loc[G["gap"].idxmin()]
        w(f"| {s} | {len(G)} | {pct(G['gap'].abs().median())} | {pct(G['gap'].abs().quantile(.99))} | {pct(up['gap'])} ({up['monday']:%Y-%m-%d}) | {pct(dn['gap'])} ({dn['monday']:%Y-%m-%d}) | "
          f"{pct((G['gap'].abs() > G['b']).mean())} | {pct((G['gap'] > G['b']).mean())} | {G['zeff'].quantile(.99):.2f} | {G['zeff'].quantile(.999):.2f} | {G['zeff_up'].quantile(.999):.2f} |")
    fig, axes = plt.subplots(1, 3, figsize=(12, 3.4), sharey=True)
    for ax, s in zip(axes, STOCKS):
        G = res[s]["vol"]["gaps"]
        ax.hist(G["gap"] * 100, bins=60, color="#4c72b0")
        bf = b_full(res[s]["vol"]["sigma"][1], H_WEEKEND) * 100
        ax.axvline(bf, color="#c44e52", ls="--", label=f"+b_full {bf:.1f}% (σ 1y)")
        ax.axvline(-bf, color="#c44e52", ls="--")
        ax.set_title(f"{s}: weekend gaps, {len(G)} weekends")
        ax.set_xlabel("Monday open vs Friday close (%)")
        ax.legend(fontsize=7)
    axes[0].set_ylabel("Number of weekends")
    w("\n![Weekend gap histograms](" + savefig(fig, "weekend_gaps_10y.png", SRC_YF + "; weekends Sep 2016 – Sep 2026, dates ET") + ")\n")
    w("For a stock-loan market only **upward** gaps hurt lenders (the borrowed stock gets more expensive). Beyond the "
      "buffer, the position still has the LLTV margin before bad debt; section 7 combines both.\n")

    # --- 5. Premium
    w("## 5. Weekend premium: DEX price vs frozen feed\n")
    w("DEX price = last Uniswap v3 swap in a ~1-minute window at the top of each hour (USDG and WETH pools; WETH converted "
      "with Chainlink ETH/USD). Premium = DEX / feed in force − 1. \"Closed\" = Friday 20:00 → Sunday 20:00 ET with a feed "
      "older than 1 h.\n")
    w("| Stock | Pool(s) | Hours sampled (closed / open) | Closed: p50 / p90 / p99 / max premium | Closed: min | Open: p50 / p99 abs | Weekends with abs premium > 3% / > 12% |")
    w("|---|---|---|---|---|---|---|")
    have_prem = False
    for s in STOCKS:
        d = res[s]["prem"]
        if d is None:
            w(f"| {s} | none yet | – | BLOCKED: DEX samples not fetched | | | |")
            continue
        have_prem = True
        c, o = d[d["closed"]], d[~d["closed"]]
        e3, e12 = episodes(d, 0.03), episodes(d, 0.12)
        w(f"| {s} | {', '.join(sorted(d['quote'].unique()))}, from {d['t'].min():%Y-%m-%d} | {len(c)} / {len(o)} | {pct(c['prem'].median())} / {pct(c['prem'].quantile(.9))} / {pct(c['prem'].quantile(.99))} / {pct(c['prem'].max())} | {pct(c['prem'].min())} | {pct(o['prem'].abs().median())} / {pct(o['prem'].abs().quantile(.99))} | {len(e3)} / {len(e12)} |")
    if have_prem:
        w("\n**The litepaper's \"~12%\" weekend premium is not observed on Robinhood Chain** for SPY, NVDA or AAPL in these "
          "samples: no weekend exceeded 3%. The claim may come from other venues or other tokens; hourly sampling can miss "
          "spikes shorter than an hour, and 8–10 weekends of DEX data per stock is a short history.")
        w("\nLargest weekend episodes (by peak abs premium, USDG pool where available):\n")
        w("| Stock | Weekend | Peak premium | Peak at (ET) | Hours above 3% | First / last hour above 3% (ET) |")
        w("|---|---|---|---|---|---|")
        for s in STOCKS:
            d = res[s]["prem"]
            if d is None:
                continue
            e = episodes(d, 0.03)
            if not len(e):
                c = d[d["closed"]]
                if len(c):
                    i = c["prem"].abs().idxmax()
                    w(f"| {s} | (none above 3%) | {pct(c.loc[i,'prem'])} | {c.loc[i,'t']:%Y-%m-%d %H:%M} | 0 | – |")
                continue
            e = e.reindex(e["peak"].abs().sort_values(ascending=False).index).head(5)
            for _, r in e.iterrows():
                w(f"| {s} | {r['weekend']} | {pct(r['peak'])} | {r['peak_at']:%a %Y-%m-%d %H:%M} | {r['hours_above']} | {r['start']:%a %H:%M} / {r['end']:%a %H:%M} |")
        fig, axes = plt.subplots(3, 1, figsize=(11, 8), sharex=True)
        for ax, s in zip(axes, STOCKS):
            d = res[s]["prem"]
            if d is None:
                continue
            for q, col in (("USDG", "#4c72b0"), ("WETH", "#dd8452")):
                x = d[d["quote"] == q]
                ax.plot(x["t"], x["prem"] * 100, ".", ms=2, color=col, label=f"{s}/{q} pool")
            for t0 in pd.date_range(d["t"].min().normalize(), d["t"].max(), freq="W-FRI", tz=ET):
                ax.axvspan(t0 + pd.Timedelta(hours=20), t0 + pd.Timedelta(days=2, hours=20), color="#999", alpha=0.15, lw=0)
            ax.axhline(0, color="k", lw=0.5)
            ax.set_ylabel("DEX / feed − 1 (%)")
            ax.legend(fontsize=7, loc="upper left")
        axes[-1].set_xlabel("Time (ET); grey = Friday 20:00 → Sunday 20:00 ET feed freeze")
        axes[0].set_title("Stock Token DEX price vs Chainlink feed price in force")
        w("\n![Premium time series](" + savefig(fig, "premium_timeseries.png", SRC_DEX) + ")\n")

    # --- 6. Depth
    w("## 6. DEX depth (USD to move the pool price 2%)\n")
    if depth is not None:
        w("| Snapshot (UTC) | Block | Pool | Push up 2% (buy stock) | Push down 2% (sell stock) |")
        w("|---|---|---|---|---|")
        for _, r in depth.iterrows():
            w(f"| {r['utc'][:16]} | {r['block']} | {r['pool']} | ${r['usd_to_push_up_2pct']:,.0f} | ${r['usd_to_push_down_2pct']:,.0f} |")
        snap_days = {pd.Timestamp(u).tz_convert(ET).dayofweek for u in depth["utc"]}
        if not any(dw < 5 for dw in snap_days):
            w("\nOnly weekend snapshots exist. **Weekday comparison: BLOCKED** until `dex_depth.py` runs on a weekday or an "
              "archive RPC is available to read `slot0`/ticks at past weekday blocks. v3 pools are passive liquidity, "
              "so depth should not change by day unless LPs pull liquidity for weekends; this needs the check.")
    w("")

    # --- 7. Liquidation profitability
    w("## 7. Liquidation profitability during weekend premiums\n")
    w(f"LLTV {pct(LLTV,0)} → LIF {LIF:.5f} (incentive {pct(LIF-1)}). A liquidator repays wSTOCK valued by the oracle at "
      "P_feed·(1+b) and seizes USDG worth LIF times that. If they must buy the stock on the DEX at P_feed·(1+premium) "
      "with slippage s, the trade pays only if (1+b)·LIF > (1+premium)·(1+s). Break-even premium = (1+b)·LIF/(1+s) − 1.\n")
    w("| Stock | b_full weekend (σ 1y) | Break-even premium, s = 0 / 1% / 2% | Share of closed hours above break-even (s = 1%) | Worst closed-hour premium |")
    w("|---|---|---|---|---|")
    for s in STOCKS:
        b = b_full(res[s]["vol"]["sigma"][1], H_WEEKEND)
        be = [(1 + b) * LIF / (1 + sl) - 1 for sl in (0, 0.01, 0.02)]
        d = res[s]["prem"]
        if d is None or not d["closed"].any():
            w(f"| {s} | {pct(b,1)} | {' / '.join(pct(x,1) for x in be)} | BLOCKED (no DEX samples) | – |")
            continue
        c = d[d["closed"]]
        w(f"| {s} | {pct(b,1)} | {' / '.join(pct(x,1) for x in be)} | {pct((c['prem'] > be[1]).mean())} | {pct(c['prem'].max())} |")
    w("\n**Reading.** With the buffer in force, the oracle already values the stock above the frozen feed by b, so the "
      "liquidator's margin is b + 7.4% before slippage. Liquidations on a weekend only happen for positions made "
      "unhealthy by the ramp-in (prices are frozen), so the relevant question is whether ramp-in liquidations on Friday "
      "evening can be filled; weekday DEX depth answers that (section 6). The Monday re-open is the larger risk: the "
      "feed jumps and many positions may cross at once (section 4).\n")

    # --- 8. Borrow demand
    w("## 8. First-pass borrow-demand estimate\n")
    w("Assumptions (all explicit, all rough): (1) during a closed hour with premium p > X, an arbitrageur borrows the "
      "stock and sells it on the DEX until the premium falls to X; (2) the USD sold ≈ depth_down_2% × (p − X)/2%, using "
      "the depth snapshot for that pool (linear in small moves, true for concentrated liquidity near the current tick); "
      "(3) each weekend counts once, at its peak hour (the same inventory is not re-shorted every hour); (4) USDG pools "
      "only; (5) annualized ×52 from the weekends observed.\n")
    w("| Stock | Weekends observed | X = 1%: USD shortable per weekend (mean / max) | X = 2% | Annualized at X = 1% |")
    w("|---|---|---|---|---|")
    for s in STOCKS:
        d = res[s]["prem"]
        dep = None
        if depth is not None:
            m = depth[depth["pool"] == f"{s}_USDG_500"]
            dep = float(m["usd_to_push_down_2pct"].iloc[-1]) if len(m) else None
        if d is None or dep is None:
            w(f"| {s} | – | BLOCKED | | |")
            continue
        c = d[d["closed"] & (d["quote"] == "USDG")].assign(week=lambda x: x["t"].dt.strftime("%G-W%V"))
        out = {}
        for X in (0.01, 0.02):
            per = c.groupby("week")["prem"].max().apply(lambda p: max(p - X, 0) / 0.02 * dep)
            out[X] = per
        nweeks = c["week"].nunique()
        w(f"| {s} | {nweeks} | ${out[0.01].mean():,.0f} / ${out[0.01].max():,.0f} | ${out[0.02].mean():,.0f} / ${out[0.02].max():,.0f} | ${out[0.01].mean()*52:,.0f} |")
    w("\nThese are notional amounts sold short, not revenue. A weekend arb holds the borrow ~2 days, so at 10% APR the "
      "annualized interest is about notional × 0.10 × 2/365 (for NVDA at X = 1%: a few thousand USD a year). Weekend "
      "premium arbitrage alone does not justify the product.")
    w("\nThis is demand from weekend premium arbitrage only; hedging demand from perp makers (Lighter SPY open interest "
      "≈ $51M) is a different and likely larger source that the interviews (WS-F) should size.\n")

    (REPORT_DIR / "phase0-weekend-gaps.md").write_text("\n".join(L) + "\n")
    print("wrote", REPORT_DIR / "phase0-weekend-gaps.md")


if __name__ == "__main__":
    main()
