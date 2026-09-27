# Owner action pack (items that gate Phase 3)

Status of the seven human items from the remediation (2026-09-28): what is already done from the engineering side, and
the exact step left for a person. Nothing in this folder has been sent to anyone.

| # | Item | Done by engineering | Left for you |
|---|---|---|---|
| 1 | Private remote + CI | Private repo `github.com/SamyaDeb/stockline` created, `main` pushed (history scanned for secrets first); CI runs on push | Add repo secrets when you have them: `ROBINHOOD_RPC_URL` (archive, item 6) for the fork workflow |
| 2 | Testnet go, 2 weekends, 20 testers | Deployer and compliance-signer keys generated locally in `~/.stockline/` (outside the repo, mode 600); full deploy simulated against the live testnet: **~0.0025 ETH** at 0.02 gwei; tester recruitment post in [messages.md](messages.md#tester-recruitment-post) | Fund `0x3394d7Be60302c9649c6E5A3c7fC7b989f521348` with ~0.05 ETH from the testnet faucet (bot-protected), then say "funded" — the deploy, smoke run and services follow [`runbooks/testnet.md`](../runbooks/testnet.md). Weekends then accrue in `GET /weekends`; post the recruitment message |
| 3 | 15 borrower + 10 lender interviews | Guides and scoring: [`phase0/05-interview-kit.md`](../phase0/05-interview-kit.md); tracker: [`phase0/outreach-tracker.csv`](../phase0/outreach-tracker.csv); outreach DMs in [messages.md](messages.md#interview-outreach) | Send the DMs, run the calls, fill the tracker and results template |
| 4 | Counsel opinions, terms sign-off | Questions A–D: [`phase0/06-legal-questions.md`](../phase0/06-legal-questions.md); draft terms: `compliance/terms/`; engagement email in [messages.md](messages.md#counsel-engagement) | Pick counsel (securities + crypto, target jurisdictions), send, get the opinions and the CP-R6 sign-off |
| 5 | Accounts: sanctions, paging, email, Telegram, WalletConnect | Code and env wiring exist for all of them; [accounts.md](accounts.md) lists each sign-up and the exact env vars | Sign up (identity/payment needed), put keys in the secret store, tell me which to wire |
| 6 | Archive RPC; issuer, Chainlink, Morpho, liquidator outreach | Providers Robinhood lists for production: Alchemy, QuickNode, Blockdaemon, dRPC, Validation Cloud; QuickNode advertises full archive on mainnet and testnet ([accounts.md](accounts.md#archive-rpc)); four outreach emails in [messages.md](messages.md#ecosystem-outreach) | Create the RPC account; send the emails through the right contacts |
| 7 | Audit firms; risk sign-off on the sim | Shortlist + request for quote: [audit-rfq.md](audit-rfq.md); sign-off sheet: [risk-signoff.md](risk-signoff.md) | Send RFQs, choose, schedule; the risk owner signs the sheet |
