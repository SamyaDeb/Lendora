# Accounts to create and where their keys go

All keys go into the platform's secret store (Railway variables), never into the repo.

| Service | For | Env vars | Code |
|---|---|---|---|
| Chainalysis **or** TRM (Q5) | Sanctions screen (CP-R3); mainnet refuses the deny-list, an unknown provider and a missing key (CP-R8) | compliance: `SANCTIONS_PROVIDER=chainalysis\|trm`, `SANCTIONS_API_KEY`; optional `SANCTIONS_TIMEOUT_MS` (default 5000), `SANCTIONS_TRM_CHAIN` (TRM only, default `ethereum`, A37), `SANCTIONS_API_URL` (https egress proxy only), `SANCTIONS_DENY_LIST` (manual blocks, checked first) | `compliance/src/sanctions/` |
| PagerDuty **or** Opsgenie | Operator paging (MON-R*) | monitor: `PAGERDUTY_ROUTING_KEY` (Events API v2 integration key) or `OPSGENIE_API_KEY` | `keepers/src/monitor/pager.ts` |
| Resend | User alert emails (APP-R8) | alerts: `RESEND_API_KEY`, `ALERTS_EMAIL_FROM` (verified domain) | `keepers/src/alerts/transports.ts` |
| Telegram (BotFather) | User alerts; optional ops channel | alerts: `TELEGRAM_BOT_TOKEN`; monitor: `MONITOR_TELEGRAM_BOT_TOKEN`, `MONITOR_TELEGRAM_CHAT_ID` | same |
| WalletConnect (Reown) | Wallet connections in the app | web build arg: `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | `web/` |
| Vercel or Cloudflare | Edge geo headers (CP-R2, CP-R8) | web: `GEO_PLATFORM`, `PROXY_SECRET` (same on compliance) | `web/lib/complianceProxy.ts` |
| Railway | Hosting (infra/) | per service, see `infra/README.md` | `infra/railway/*.json` |

### Sanctions provider details (task 6)

- **Chainalysis** (Address Screening API): the key is the API token from the Chainalysis account; the service sends
  it as the `Token` header to `https://api.chainalysis.com/api/risk/v2/entities`. Blocks on `Severe` risk or a
  sanctions identification (A36).
- **TRM Labs** (Screening API): the key is the API key; the service sends it as HTTP Basic `key:key` to
  `https://api.trmlabs.com/public/v2/screening/addresses`. Ask TRM which `chain` name covers Robinhood Chain and set
  `SANCTIONS_TRM_CHAIN` (A37 [VERIFY]).
- Check after setting the key: the compliance log prints `sanctions provider chainalysis|trm` at startup and
  `GET /health` returns `"sanctions": "<provider>"`. A provider outage shows as `SCREEN_UNAVAILABLE` on `/attest`
  (entries paused, exits unaffected).

## Archive RPC

Robinhood's docs list Alchemy, QuickNode, Blockdaemon, dRPC and Validation Cloud as production providers; QuickNode
states full (unpruned) archive nodes on mainnet and testnet, Alchemy offers archive data on a free account. Pick one,
then set `ROBINHOOD_RPC_URL` (mainnet archive) locally and as a GitHub secret, and `ROBINHOOD_TESTNET_RPC_URL`. That
unblocks `test/fork/phase0` (pinned blocks), pinned Phase 1 runs (A17) and exact indexer history (A24).
Sources: https://docs.robinhood.com/chain/ , https://www.quicknode.com/chains/robinhood , https://www.alchemy.com/rpc/robinhood
