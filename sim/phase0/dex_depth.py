"""WS-C.4 (depth): USD size that moves each main Uniswap v3 pool's price by 2%, both directions, via QuoterV2
`eth_call`s at the latest block (binary search on amountIn against the post-swap sqrtPrice).

The public RPC only serves recent state, so each run measures "now". Run it once on a weekday during US regular hours
and once on a weekend to compare (an archive RPC is not needed for this). Appends to sim/data/dex_depth.csv with a
`label` column; `--label weekday` refuses to run outside Mon–Fri 09:30–16:00 America/New_York, so a weekday row is
always a real weekday measurement. `--markdown` also prints the rows for sim/reports/phase0-weekend-gaps.md §6.

Run: sim/.venv/bin/python sim/phase0/dex_depth.py --label weekday --markdown
"""

from __future__ import annotations

import argparse
import csv
import json
import math
from datetime import datetime, time, timezone
from zoneinfo import ZoneInfo

from rpc import ROOT, block_number, block_ts, eth_call

EXT = json.loads((ROOT / "packages" / "sdk" / "external-addresses.json").read_text())["4663"]
QUOTER = EXT["uniswap"]["v3QuoterV2"]
SEL_SLOT0 = "0x3850c7bd"
SEL_QUOTE_IN = "0xc6a5026a"  # quoteExactInputSingle((address,address,uint256,uint24,uint160))
MOVE = 0.02


def _addr(a: str) -> str:
    return a.lower()[2:].rjust(64, "0")


def quote(token_in: str, token_out: str, amount_in: int, fee: int, block: str) -> tuple[int, int]:
    data = SEL_QUOTE_IN + _addr(token_in) + _addr(token_out) + format(amount_in, "064x") + format(fee, "064x") + "0" * 64
    r = eth_call(QUOTER, data, block)[2:]
    return int(r[0:64], 16), int(r[64:128], 16)  # amountOut, sqrtPriceX96After


def depth(pool: str, stock: str, quote_tok: str, fee: int, block: str, buy_stock: bool) -> tuple[float, float]:
    """Returns (amountIn in token units at 18 or quote decimals, raw), searching for a 2% price move."""
    sp0 = int(eth_call(pool, SEL_SLOT0, block)[2:66], 16)
    stock_is_0 = int(stock, 16) < int(quote_tok, 16)
    # price of token0 in token1 moves with sqrtP^2. Buying the stock with quote pushes the stock price up.
    token_in, token_out = (quote_tok, stock) if buy_stock else (stock, quote_tok)
    target_ratio = (1 + MOVE) if buy_stock else (1 - MOVE)
    if not stock_is_0:
        target_ratio = 1 / target_ratio  # stock is token1: its price is 1/p
    lo, hi = 0, 1
    while True:
        try:
            _, sp = quote(token_in, token_out, hi, fee, block)
        except Exception:  # noqa: BLE001 — ran out of liquidity: the move is reachable below `hi`
            break
        if (sp / sp0) ** 2 >= target_ratio if target_ratio > 1 else (sp / sp0) ** 2 <= target_ratio:
            break
        lo, hi = hi, hi * 4
        if hi > 10**40:
            return math.nan, math.nan
    for _ in range(40):
        mid = (lo + hi) // 2
        try:
            _, sp = quote(token_in, token_out, mid, fee, block)
            reached = (sp / sp0) ** 2 >= target_ratio if target_ratio > 1 else (sp / sp0) ** 2 <= target_ratio
        except Exception:  # noqa: BLE001
            reached = True
        lo, hi = (lo, mid) if reached else (mid, hi)
    return hi, sp0


NY = ZoneInfo("America/New_York")


def is_us_regular_hours(ts: int) -> bool:
    t = datetime.fromtimestamp(ts, NY)
    return t.weekday() < 5 and time(9, 30) <= t.time() < time(16, 0)


def label_of(ts: int) -> str:
    return "weekday" if datetime.fromtimestamp(ts, NY).weekday() < 5 else "weekend"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--label", choices=["weekday", "weekend", "auto"], default="auto")
    ap.add_argument("--markdown", action="store_true")
    args = ap.parse_args()
    blk = block_number()
    ts = block_ts(blk)
    if args.label == "weekday" and not is_us_regular_hours(ts):
        raise SystemExit(f"--label weekday needs Mon–Fri 09:30–16:00 ET; block time is {datetime.fromtimestamp(ts, NY)}")
    if args.label == "weekend" and label_of(ts) != "weekend":
        raise SystemExit(f"--label weekend needs Sat/Sun ET; block time is {datetime.fromtimestamp(ts, NY)}")
    label = label_of(ts) if args.label == "auto" else args.label
    eth_usd = int(eth_call(EXT["chainlink"]["ETH"]["proxy"], "0xfeaf968c")[66:130], 16) / 1e8
    rows = []
    for name, pool in EXT["uniswapV3Pools"].items():
        sym, q, fee = name.split("_")
        stock = EXT["stockTokens"][sym]
        qtok = EXT["tokens"]["USDG" if q == "USDG" else "WETH"]
        qdec = 6 if q == "USDG" else 18
        qusd = 1.0 if q == "USDG" else eth_usd
        px = int(eth_call(EXT["chainlink"][sym]["proxy"], "0xfeaf968c")[66:130], 16) / 1e8
        buy, _ = depth(pool, stock, qtok, int(fee), hex(blk), True)
        sell, _ = depth(pool, stock, qtok, int(fee), hex(blk), False)
        rows.append({
            "utc": datetime.fromtimestamp(ts, timezone.utc).isoformat(),
            "label": label,
            "block": blk,
            "pool": name,
            "usd_to_push_up_2pct": round(buy / 10**qdec * qusd),
            "usd_to_push_down_2pct": round(sell / 1e18 * px),
        })
        print(rows[-1])
    path = ROOT / "sim" / "data" / "dex_depth.csv"
    old: list[dict] = []
    if path.exists():
        with path.open() as f:
            old = list(csv.DictReader(f))
        for r in old:  # rows from before the label column: infer it from the timestamp
            r.setdefault("label", label_of(int(datetime.fromisoformat(r["utc"]).timestamp())))
    with path.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows([{k: r.get(k, "") for k in rows[0]} for r in old] + rows)
    if args.markdown:
        for r in rows:
            print(f"| {r['utc'][:16]} ({r['label']}) | {r['block']} | {r['pool']} | ${r['usd_to_push_up_2pct']:,} | ${r['usd_to_push_down_2pct']:,} |")


if __name__ == "__main__":
    main()
