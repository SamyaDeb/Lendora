# Owner action pack (items that gate Phase 3 and mainnet)

Status of the human items (refreshed at the Phase 3 engineering exit, 2026-09-28): what is already done from the
engineering side, and the exact step left for a person. Nothing in this folder has been sent to anyone. The full
mainnet-readiness checklist is in [11 · Mainnet-readiness checklist](../prd/11-milestones.md#mainnet-readiness-checklist-gates-of-mainnet-launchmd-0-and-what-14-need).

| # | Item | Done by engineering | Left for you |
|---|---|---|---|
| 1 | Private remote + CI | Private repo `github.com/SamyaDeb/stockline` created, `main` pushed (history scanned for secrets first); CI runs on push | Add repo secrets when you have them: `ROBINHOOD_RPC_URL` (archive, item 6) for the fork workflow |
| 2 | Testnet go, 2 weekends, 20 testers | Deployer and compliance-signer keys generated locally in `~/.stockline/` (outside the repo, mode 600); full deploy simulated against the live testnet: **~0.0025 ETH** at 0.02 gwei; tester recruitment post in [messages.md](messages.md#tester-recruitment-post) | Testnet deployed 2026-09-28 (smoke 13/13). Say **"go testnet"** to deploy the fee contracts (`DeployTestnetFees.s.sol`), turn fees on and run the drills live (all rehearsed on a fork: [fork-drills-46630.md](../runbooks/fork-drills-46630.md)); check deployer gas first (~0.0084 ETH left). Start the testnet services live so weekends accrue (0 of 2 so far, first eligible Oct 2–4, [testnet-weekends.md](../runbooks/testnet-weekends.md)); post the recruitment message and create the feedback form |
| 3 | 15 borrower + 10 lender interviews | Guides and scoring: [`phase0/05-interview-kit.md`](../phase0/05-interview-kit.md); tracker: [`phase0/outreach-tracker.csv`](../phase0/outreach-tracker.csv); outreach DMs in [messages.md](messages.md#interview-outreach) | Send the DMs, run the calls, fill the tracker and results template |
| 4 | Counsel opinions, terms sign-off | Questions A–D: [`phase0/06-legal-questions.md`](../phase0/06-legal-questions.md); draft terms: `compliance/terms/`; engagement email in [messages.md](messages.md#counsel-engagement) | Pick counsel (securities + crypto, target jurisdictions), send, get the opinions and the CP-R6 sign-off |
| 5 | Accounts: sanctions, paging, email, Telegram, WalletConnect | Code and env wiring exist for all of them; Chainalysis **and** TRM adapters built and tested (Q5); [accounts.md](accounts.md) lists each sign-up and the exact env vars | Sign up (identity/payment needed), put keys in the secret store, tell me which to wire |
| 6 | Archive RPC; issuer, Chainlink, Morpho, liquidator outreach | Providers Robinhood lists for production: Alchemy, QuickNode, Blockdaemon, dRPC, Validation Cloud; QuickNode advertises full archive on mainnet and testnet ([accounts.md](accounts.md#archive-rpc)); four outreach emails in [messages.md](messages.md#ecosystem-outreach) | Create the RPC account; send the emails through the right contacts |
| 7 | Audit firms; risk sign-off on the sim | Shortlist + request for quote incl. round-2 scope: [audit-rfq.md](audit-rfq.md); mainnet sim and Q2 study done, evidence pre-filled in [risk-signoff.md](risk-signoff.md) with the flagged differences | Send RFQs, choose, schedule; the risk owner decides the flagged items and signs the sheet |

## Added at the Phase 3 engineering exit

| # | Item | Done by engineering | Left for you |
|---|---|---|---|
| 8 | Mainnet multisigs and keys | `DeployMainnet` refuses weak or shared roles (MN-R1…R3); `VerifyRoles` checks them after deploy | Create 5 Safes (owner 4-of-7, guardian 2-of-4, curator, treasury, `BackstopReserve`) on hardware wallets; KMS keys for allocator, guard keeper, fee keeper, liquidator, compliance signer |
| 9 | Treasury and `BackstopReserve` addresses (Q9) | Config fields with refusals | Send the two Safe addresses |
| 10 | Bug bounty (Q14) | Draft: [`bug-bounty.md`](../audit/bug-bounty.md), Critical max $450k proposed | Confirm payouts and budget, choose the platform, publish after deploy |
| 11 | Mainnet hosting (Q15) | Railway configs, pinned images | Create the mainnet project and secrets |
| 12 | Decisions still open | – | Q5 provider, Q6 brand, Q7 archive RPC, Q9 addresses, Q13 MetaMorpho submodule, Q14 payouts, Q15 hosting |

