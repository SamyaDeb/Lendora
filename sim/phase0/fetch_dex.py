"""WS-C.2: sample Uniswap v3 prices for the launch Stock Tokens, hourly, including weekends.

The main pools see thousands of swaps per hour, which is too much to pull in full from the public, rate-limited RPC.
Instead, for every hour since the Chainlink feeds launched we query a ~1-minute block window (600 blocks at ~0.1 s)
starting at the top of the hour and keep the last swap in it. A swap's post-trade `sqrtPriceX96` is the pool price;
its exact time comes from the log's `blockTimestamp`, or the block header when the node returns 0x0 there
(it does for older logs). Hours with no swap in the window are left empty (not filled).

WETH-quoted pools are converted to USD with the Chainlink ETH/USD round in force at that second. USDG pools are taken
at 1 USDG = 1 USD (the USDG/USD feed stayed within 0.99963–1.00041 over the window; see the report).

Output: sim/data/dex/<POOL>.csv with ts, block, price_usd, price_quote, amount_stock (pool perspective, signed).

Run: sim/.venv/bin/python sim/phase0/fetch_dex.py   (resumable; re-running only fetches new hours)
"""

from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pandas as pd
from rpc import ROOT, block_number, block_ts, eth_call, rpc

EXT = json.loads((ROOT / "packages" / "sdk" / "external-addresses.json").read_text())["4663"]
SWAP = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67"
OUT = ROOT / "sim" / "data" / "dex"
START_TS = 1782086400  # 2026-06-22 00:00 UTC, the day after the stock feeds' first round
WINDOW_BLOCKS = 600


def block_time_map(head: int, step: int = 100_000) -> tuple[np.ndarray, np.ndarray]:
    cache = ROOT / "sim" / "data" / "raw" / "block_times.json"
    m: dict[str, int] = json.loads(cache.read_text()) if cache.exists() else {}
    need = [b for b in list(range(1, head, step)) + [head] if str(b) not in m]
    with ThreadPoolExecutor(4) as ex:
        for b, t in zip(need, ex.map(block_ts, need)):
            m[str(b)] = t
    cache.write_text(json.dumps(m))
    bs = np.array(sorted(int(k) for k in m))
    return bs, np.array([m[str(b)] for b in bs])


def _signed(h: str) -> int:
    v = int(h, 16)
    return v - 2**256 if v >= 2**255 else v


def sample_pool(name: str, pool: str, bs: np.ndarray, ts: np.ndarray, head_ts: int) -> None:
    stock_sym, quote, _fee = name.split("_")
    stock = EXT["stockTokens"][stock_sym].lower()
    stock_is_0 = ("0x" + eth_call(pool, "0x0dfe1681")[-40:]).lower() == stock  # token0()
    quote_dec = 18 if quote == "WETH" else 6
    path = OUT / f"{name}.csv"
    done = pd.read_csv(path) if path.exists() else pd.DataFrame(columns=["hour"])
    have = set(done["hour"].astype(int)) if len(done) else set()
    hours = [h for h in range(START_TS, head_ts - 3600, 3600) if h not in have]

    def one(hour: int):
        b0 = int(np.interp(hour, ts, bs))
        logs = rpc("eth_getLogs", [{"address": pool, "topics": [SWAP], "fromBlock": hex(b0), "toBlock": hex(b0 + WINDOW_BLOCKS)}])
        if not logs:
            return (hour, None, None, None, None)
        lg = logs[-1]
        d = lg["data"][2:]
        sp = int(d[128:192], 16)
        p1_per_0 = (sp / 2**96) ** 2
        if stock_is_0:
            px, amt = p1_per_0 * 10 ** (18 - quote_dec), _signed(d[0:64])
        else:
            px, amt = (1 / p1_per_0) * 10 ** (18 - quote_dec), _signed(d[64:128])
        bn = int(lg["blockNumber"], 16)
        t = int(lg.get("blockTimestamp") or "0x0", 16) or block_ts(bn)  # older logs carry blockTimestamp 0x0
        return (hour, t, bn, px, amt / 1e18)

    df = done
    for i in range(0, len(hours), 200):  # save every 200 hours so a rate-limit failure loses little
        with ThreadPoolExecutor(2) as ex:
            rows = list(ex.map(one, hours[i : i + 200]))
        new = pd.DataFrame(rows, columns=["hour", "ts", "block", "price_quote", "amount_stock"])
        df = pd.concat([df, new], ignore_index=True) if len(df) else new
        df = df.sort_values("hour").reset_index(drop=True)
        df[["hour", "ts", "block", "price_quote", "amount_stock"]].to_csv(path, index=False)
    eth = pd.read_csv(ROOT / "sim" / "data" / "feeds" / "ETH.csv").sort_values("updated_at")
    df["price_usd"] = df["price_quote"].astype(float)
    if quote == "WETH":
        t = df["ts"].fillna(df["hour"]).astype("int64").values
        idx = np.searchsorted(eth.updated_at.values, t, side="right") - 1
        df["price_usd"] = df["price_quote"].astype(float) * np.where(idx >= 0, eth.answer.values[idx] / 1e8, np.nan)
    df.to_csv(path, index=False)
    print(f"{name}: {df.price_quote.notna().sum()}/{len(df)} hours with a swap")


def main() -> None:
    head = block_number()
    bs, ts = block_time_map(head)
    OUT.mkdir(parents=True, exist_ok=True)
    pools = sorted(EXT["uniswapV3Pools"].items(), key=lambda kv: "WETH" in kv[0])  # USDG pools first
    for name, pool in pools:
        sample_pool(name, pool, bs, ts, int(ts[-1]))


if __name__ == "__main__":
    main()
