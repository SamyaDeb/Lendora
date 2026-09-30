# Audit shortlist and request for quote

Scope and package: [`docs/audit/README.md`](../audit/README.md) (1,668 nSLOC in `contracts/src`, freeze commit in
`docs/audit/FREEZE`), threat model, known issues. Plan (11 Phase 3): two independent audits plus a formal review of
the oracle math (OR-R1, OR-R20).

**Round 2 / delta (Phase 3):** `FeeSplitter` + `FeeConverter` (270 nSLOC new `src/`), the mainnet deploy scripts
(`MainnetConfig`, `DeployMainnet`, `VerifyRoles`, 615 nSLOC, deployment logic) and the fee wiring in
`LendoraDeploy`; no frozen file changed. Details: [`docs/audit/README.md` §8](../audit/README.md#8-round-2--delta-scope-phase-3-2026-09-28).
Bug bounty draft: [`bug-bounty.md`](../audit/bug-bounty.md).

**Shortlist** — firms that reviewed Morpho Vault V2, the code we integrate unmodified (Morpho's published audit list:
Spearbit, ChainSecurity, Zellic, Blackthorn, a Cantina competition; Certora formal verification):

| Firm | Why | Ask for |
|---|---|---|
| Spearbit / Cantina | Several Vault V2 reviews; can run a follow-up competition | Audit round 1 or 2; optional competition before mainnet |
| ChainSecurity | Vault V2 audit (2025) | Audit round 1 or 2 |
| Zellic | Vault V2 audit (2025) | Audit round 1 or 2 |
| Certora | Formal verification of Vault V2 properties | Formal review of `OracleMath` / buffer (OR-R8 instant-drop property, OR-R20) |

Choose two different firms for the rounds. Sources: https://morpho-org-vault-v2.mintlify.app/security/audits ,
https://www.chainsecurity.com/security-audit/morpho-vault-v2

**RFQ email**
> Subject: Audit request — Lendora (1.7k nSLOC Solidity, Morpho Blue / Vault V2 integration)
> Lendora is a stock lending layer on Robinhood Chain using unmodified Morpho Blue and Vault V2. In scope: router
> (UUPS), oracle with weekend/earnings buffers and guards, collateral wrapper, stock wrapper, calendar, fallback
> liquidator (1,668 nSLOC, Solidity 0.8.26, Foundry, invariant suites at 1M calls). Package with scope, threat model and
> known issues attached. Target window: `<dates>`; fix window 1 week; re-review of fixes. Please send availability,
> team, duration and quote.
