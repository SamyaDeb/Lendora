"""WS-C.4 (depth): USD size that moves each main Uniswap v3 pool's price by 2%, both directions, via QuoterV2
`eth_call`s at the latest block (binary search on amountIn against the post-swap sqrtPrice).

The public RPC only serves recent state, so each run measures "now". Run it once on a weekday and once on a weekend
(or pass an archive RPC in ROBINHOOD_RPC_URL and a block list) to compare. Appends to sim/data/dex_depth.csv.

Run: sim/.venv/bin/python sim/phase0/dex_depth.py
"""

from __future__ import annotations

import csv
import json
import math
from datetime import datetime, timezone

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


def main() -> None:
    blk = block_number()
    ts = block_ts(blk)
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
            "block": blk,
            "pool": name,
            "usd_to_push_up_2pct": round(buy / 10**qdec * qusd),
            "usd_to_push_down_2pct": round(sell / 1e18 * px),
        })
        print(rows[-1])
    path = ROOT / "sim" / "data" / "dex_depth.csv"
    new = not path.exists()
    with path.open("a", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        if new:
            w.writeheader()
        w.writerows(rows)


if __name__ == "__main__":
    main()
