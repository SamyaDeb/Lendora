"""Minimal read-only JSON-RPC helpers for Robinhood Chain (Phase 0).

Only `eth_call`, `eth_getLogs`, `eth_blockNumber` and `eth_getBlockByNumber` are used. Nothing here signs or sends a
transaction. The RPC URL comes from `ROBINHOOD_RPC_URL` (see `.env.example`); if unset, it falls back to the public,
rate-limited, non-archive endpoint from https://docs.robinhood.com/chain/connecting, which serves logs and latest state.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

import requests

PUBLIC_RPC = "https://rpc.mainnet.chain.robinhood.com"
ROOT = Path(__file__).resolve().parents[2]


def _load_dotenv() -> None:
    env = ROOT / ".env"
    if not env.exists():
        return
    for line in env.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            if v.strip():
                os.environ.setdefault(k.strip(), v.strip())


_load_dotenv()
RPC_URL = os.environ.get("ROBINHOOD_RPC_URL") or PUBLIC_RPC
_session = requests.Session()


def rpc(method: str, params: list, retries: int = 12):
    for attempt in range(retries):
        try:
            r = _session.post(RPC_URL, json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params}, timeout=60)
            if r.status_code == 429:
                raise RuntimeError("rate limited")
            j = r.json()
            if "error" in j:
                raise RuntimeError(j["error"])
            return j["result"]
        except Exception as e:  # noqa: BLE001
            msg = str(e)
            if "exceeds limit" in msg or "query returned more than" in msg or "block range" in msg:
                raise
            if attempt == retries - 1:
                raise
            time.sleep(min(60.0, 1.5 * 2**attempt))


def block_number() -> int:
    return int(rpc("eth_blockNumber", []), 16)


def block_ts(n: int) -> int:
    return int(rpc("eth_getBlockByNumber", [hex(n), False])["timestamp"], 16)


def eth_call(to: str, data: str, block: str = "latest") -> str:
    return rpc("eth_call", [{"to": to, "data": data}, block])


def get_logs(address, topics, from_block: int, to_block: int, step: int = 5_000_000) -> list[dict]:
    """Fetches logs in adaptive chunks (halves the range when the node's result limit is hit)."""
    out: list[dict] = []
    start = from_block
    while start <= to_block:
        end = min(start + step - 1, to_block)
        try:
            out += rpc("eth_getLogs", [{"address": address, "topics": topics, "fromBlock": hex(start), "toBlock": hex(end)}])
            start = end + 1
            step = min(int(step * 1.5), 20_000_000)
        except RuntimeError as e:
            if "exceeds limit" in str(e) or "more than" in str(e):
                step = max(step // 4, 1000)
            else:
                raise
    return out


def cached_logs(name: str, address, topics, from_block: int, to_block: int | None = None) -> list[dict]:
    """Incremental cache under sim/data/raw/<name>.json keyed by the last fetched block."""
    path = ROOT / "sim" / "data" / "raw" / f"{name}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    to_block = to_block if to_block is not None else block_number()
    cache = {"to_block": from_block - 1, "logs": []}
    if path.exists():
        cache = json.loads(path.read_text())
    if cache["to_block"] < to_block:
        cache["logs"] += get_logs(address, topics, cache["to_block"] + 1, to_block)
        cache["to_block"] = to_block
        path.write_text(json.dumps(cache))
    return cache["logs"]
