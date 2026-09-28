# Risk owner sign-off · delta-neutral vault (08 simulation gate, Phase 4)

Sign each line (name, date) or write the change. **No deploy config carries a non-zero vault cap until every line is
signed and the gate verdict is PASS** (Q11). Today's verdict: **INSUFFICIENT DATA** (94 days of venue funding; 12
months needed, earliest 2027-06-26).

| Item | Current value | Evidence (engineering, Phase 4 task 13) | Sign-off |
|---|---|---|---|
| Gate verdict | INSUFFICIENT DATA | [phase4-dn-vault](../../sim/reports/phase4-dn-vault.md) header and gate table | |
| Venue | Lighter (Robinhood Chain instance); Arcus [VERIFY] | [01-perp-venue](../phase4/01-perp-venue.md); A39–A41 | |
| Venue trust gap (operator key can trade any market) | Bounded by the margin share (23.75% of NAV), second NAV signer, guardian key rotation | [01-perp-venue §4](../phase4/01-perp-venue.md), A40 | |
| `L` / `c` | 3 / 5% (08) | [report §5](../../sim/reports/phase4-dn-vault.md): liquidation threshold ≥ 29% rise, margin ≥ 3.7× after +20% | |
| `LEND_RATIO` | 90% (08) → **dynamic per sleeve** proposed | [report §5](../../sim/reports/phase4-dn-vault.md) DN-R8 table: at launch caps the vault would be most of each rSTOCK vault | |
| Sleeve weights | SPY 50% / NVDA 25% / AAPL 25% | [report §5](../../sim/reports/phase4-dn-vault.md): keep; AAPL sleeve ≤ 10% of its perp OI | |
| Kill switch (DN-R7) | 7-day average < −lending APY for 72 h (08) | [report §4.2](../../sim/reports/phase4-dn-vault.md): −100% APR week draws down 2.35% (over the 2% bound); a 24 h / 24 h trigger (DN-R13 proposal) 1.74%, but it also fired once on real data (NVDA 2026-08-03) | |
| Weekend share pricing (DN-R12) | deposits pause and withdrawals queue while the feed is closed | [report §4.1](../../sim/reports/phase4-dn-vault.md): reported NAV −14.5% over a weekend with a +20% perp move, recovered at the open | |
| Entry costs | spot bought over several sessions | [report §3](../../sim/reports/phase4-dn-vault.md): a one-shot entry at $2M costs 1.54% of TVL | |
| Lending APY proxy | 2% (no data) | [report §1, §3](../../sim/reports/phase4-dn-vault.md) sensitivities 0 / 2 / 5% | |
| Total cap (DN-R6) | $2M in 08; **0 in every deploy config** | `DeployTestnet` / `MainnetConfig` (task 14), `VerifyRoles` checks cap = 0 | |
| 30-day run (08 acceptance) | not started | devnet week rehearsal (task 17) | |
