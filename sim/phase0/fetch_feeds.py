"""WS-C.1: pull every Chainlink round for the launch Stock Token feeds (+ USDG/USD, syrupUSDG/USDG).

Reads `getRoundData` through each feed proxy at the latest block. OCR2 aggregators keep every transmission in storage,
so no archive node is needed. Round ids are phase-encoded: (phaseId << 64) | aggregatorRound.
Output: sim/data/feeds/<SYMBOL>.csv with round_id, answer, started_at, updated_at (UTC seconds).

Run: sim/.venv/bin/python sim/phase0/fetch_feeds.py
"""

from __future__ import annotations

import csv
import json
import time
from pathlib import Path

from rpc import ROOT, eth_call, rpc

FEEDS = {
    k: v
    for k, v in json.loads((ROOT / "packages" / "sdk" / "external-addresses.json").read_text())["4663"]["chainlink"].items()
    if k in ("SPY", "NVDA", "AAPL", "USDG", "syrupUSDG_USDG", "ETH")
}
OUT = ROOT / "sim" / "data" / "feeds"
SEL_LATEST = "0xfeaf968c"  # latestRoundData()
SEL_GET = "0x9a6fc8f5"  # getRoundData(uint80)
SEL_PHASE = "0x58303b10"  # phaseId()


def _decode(h: str) -> tuple[int, int, int, int]:
    w = [h[2 + 64 * i : 2 + 64 * (i + 1)] for i in range(5)]
    ans = int(w[1], 16)
    if ans >= 2**255:
        ans -= 2**256
    return int(w[0], 16), ans, int(w[2], 16), int(w[3], 16)


def _batch_calls(to: str, datas: list[str]) -> list[str | None]:
    import requests

    from rpc import RPC_URL

    out: list[str | None] = []
    for i in range(0, len(datas), 20):
        chunk = datas[i : i + 20]
        body = [
            {"jsonrpc": "2.0", "id": j, "method": "eth_call", "params": [{"to": to, "data": d}, "latest"]}
            for j, d in enumerate(chunk)
        ]
        for attempt in range(12):
            try:
                res = requests.post(RPC_URL, json=body, timeout=120).json()
                if isinstance(res, dict):
                    raise RuntimeError(res)
                break
            except Exception:  # noqa: BLE001
                if attempt == 11:
                    raise
                time.sleep(2 * (attempt + 1))
        time.sleep(0.25)
        res = sorted(res, key=lambda r: r["id"])
        out += [r.get("result") for r in res]
    return out


def fetch(symbol: str, proxy: str) -> Path:
    phase = int(eth_call(proxy, SEL_PHASE), 16)
    latest_id, *_ = _decode(eth_call(proxy, SEL_LATEST))
    rows = []
    for ph in range(1, phase + 1):
        last = (latest_id & (2**64 - 1)) if ph == phase else None
        if last is None:  # older phases: probe until revert (not needed while phaseId == 1)
            raise NotImplementedError("multi-phase feeds not handled")
        ids = [(ph << 64) | r for r in range(1, last + 1)]
        datas = [SEL_GET + format(i, "064x") for i in ids]
        for rid, res in zip(ids, _batch_calls(proxy, datas)):
            if res and len(res) >= 2 + 64 * 5:
                _, ans, st, up = _decode(res)
                if up:
                    rows.append((rid, ans, st, up))
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / f"{symbol}.csv"
    with path.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["round_id", "answer", "started_at", "updated_at"])
        w.writerows(rows)
    print(f"{symbol}: {len(rows)} rounds, phase {phase}, head block {int(rpc('eth_blockNumber', []), 16)}")
    return path


if __name__ == "__main__":
    for sym, f in FEEDS.items():
        fetch(sym, f["proxy"])
