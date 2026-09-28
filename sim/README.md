# sim

Python parameter simulations (`docs/prd/04-oracle.md` §5): σ_annual, buffer, caps. Reports go in `sim/reports/`.

| Path | What |
|---|---|
| `phase0/` | Phase 0 data pulls and the WS-C weekend-gap report (`reports/phase0-weekend-gaps.md`) |
| `params/params.py` | Mainnet parameter sim (04 §5, Phase 3 task 8) → `reports/mainnet-params.md` |
| `event_timing/compare.py` | Q2 event-buffer timing study → `reports/event-timing.md` |

```sh
sim/.venv/bin/python sim/params/params.py          # ~1 min
sim/.venv/bin/python sim/event_timing/compare.py
sim/.venv/bin/python sim/phase0/dex_depth.py --label weekday --markdown   # Mon–Fri 09:30–16:00 ET only
```

