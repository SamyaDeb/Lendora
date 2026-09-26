"""Backfills exact block timestamps in sim/data/dex/*.csv for rows sampled while the node returned blockTimestamp 0x0,
then recomputes USD prices for WETH pools. Block headers are cached in sim/data/raw/block_ts_cache.json.

Run: sim/.venv/bin/python sim/phase0/fill_ts.py
"""

from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pandas as pd
from rpc import ROOT, block_ts

CACHE = ROOT / "sim" / "data" / "raw" / "block_ts_cache.json"


def main() -> None:
    cache: dict[str, int] = json.loads(CACHE.read_text()) if CACHE.exists() else {}
    eth = pd.read_csv(ROOT / "sim" / "data" / "feeds" / "ETH.csv").sort_values("updated_at")
    for path in sorted((ROOT / "sim" / "data" / "dex").glob("*.csv")):
        df = pd.read_csv(path)
        need = sorted({int(b) for b, t in zip(df["block"], df["ts"]) if pd.notna(b) and (pd.isna(t) or t == 0)} - {int(k) for k in cache})
        for i in range(0, len(need), 100):
            with ThreadPoolExecutor(2) as ex:
                for b, t in zip(need[i : i + 100], ex.map(block_ts, need[i : i + 100])):
                    cache[str(b)] = t
            CACHE.write_text(json.dumps(cache))
        has = df["block"].notna()
        df.loc[has, "ts"] = [cache.get(str(int(b)), t) if (pd.isna(t) or t == 0) else t for b, t in zip(df.loc[has, "block"], df.loc[has, "ts"])]
        df["price_usd"] = df["price_quote"].astype(float)
        if "WETH" in path.name:
            t = df["ts"].fillna(df["hour"]).astype("int64").values
            idx = np.searchsorted(eth.updated_at.values, t, side="right") - 1
            df["price_usd"] = df["price_quote"].astype(float) * np.where(idx >= 0, eth.answer.values[idx] / 1e8, np.nan)
        df.to_csv(path, index=False)
        print(path.name, "rows", len(df), "with ts", int((df["ts"].fillna(0) > 0).sum()))


if __name__ == "__main__":
    main()
