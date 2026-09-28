# Testnet weekend log (Phase 2/3 exit: 2 clean weekends)

One entry per closure, per [testnet.md §3](testnet.md#3-weekend-watch-each-of-the-2-clean-weekends). Attach the
monitor's `GET /weekends` JSON (`curl $MONITOR_URL/weekends`) and `GET /incidents` for the weekend.

**Status 2026-09-28: 0 of 2 clean weekends accrued.** The testnet deployment went live on Mon 2026-09-28; the first
eligible closure is **Fri 2026-10-02 20:00 ET → Sun 2026-10-04 20:00 ET**, the second **Oct 9–11**. `/weekends` only
accrues while the testnet monitor and keepers run live against 46630 (services on Railway with `DRY_RUN=false`, which
needs the owner's go for the service keys; `docs/owner-actions/README.md`). If they are not running by Friday 16:00
ET, that weekend does not count.

| Weekend (ET) | Markets | Ramp-in / hold / ramp-out observed | Alerts (P0/P1) | `/weekends` verdict | Testers active | Logged by |
|---|---|---|---|---|---|---|
| 2026-10-02 → 10-04 | | | | | | |
| 2026-10-09 → 10-11 | | | | | | |
