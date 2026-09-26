# sim/phase0 · Phase 0 data pulls and weekend-gap report (WS-C)

Everything is read-only (`eth_call`, `eth_getLogs`, block headers). RPC: `ROBINHOOD_RPC_URL` from the repo `.env`, else
the public, rate-limited, non-archive `https://rpc.mainnet.chain.robinhood.com`.

```sh
uv venv sim/.venv --python 3.13 && uv pip install -p sim/.venv/bin/python -r sim/phase0/requirements.txt
cd sim
.venv/bin/python phase0/fetch_feeds.py      # every Chainlink round → data/feeds/*.csv          (~5 min)
.venv/bin/python phase0/fetch_dex.py        # hourly Uniswap v3 samples → data/dex/*.csv       (~2 h public RPC; resumable)
.venv/bin/python phase0/fill_ts.py          # exact block timestamps where logs carry 0x0      (~1 h public RPC; cached)
.venv/bin/python phase0/fetch_reference.py  # Yahoo Finance daily 10y + hourly 730d → data/reference
.venv/bin/python phase0/dex_depth.py        # 2% depth snapshot now → appends data/dex_depth.csv (run weekday + weekend)
.venv/bin/python phase0/analyze.py          # → reports/phase0-weekend-gaps.md + PNGs
```

| Path | Committed | Notes |
|---|---|---|
| `data/feeds/` | yes (small) | One CSV per feed; phase-encoded round ids |
| `data/dex/` | yes (small) | One row per hour since 2026-06-22 00:00 UTC; empty price = no swap in the sampled minute |
| `data/reference/` | yes (4 MB) | Yahoo Finance data, research use only (Yahoo terms: personal, non-commercial); not for redistribution in the product |
| `data/dex_depth.csv` | yes | Append-only snapshots |
| `data/raw/` | no (git-ignored, ~8 MB) | Log caches (Morpho, registry, pools, block times); rebuilt by the scripts and the WS-A one-offs |

Known data issues, handled in `analyze.py`:
- The first 7–24 rounds of each stock feed (to 2026-06-23 ~09:50 ET) are scaled 1e18 while `decimals()` is 8. They
  are excluded and reported in the report's section 0.
- The public node returns `blockTimestamp: 0x0` on older logs; `fill_ts.py` replaces those with the block header time.
- Hourly sampling (last swap in the first ~minute of each hour) can miss short spikes between samples.
