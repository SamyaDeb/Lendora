// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

/// @title Delta-neutral vault NAV (docs/prd/08-delta-neutral-vault.md DN-R4, DN-R5).
/// @notice NAV = the vault's idle USDG + the strategy's USDG + spot (Stock Token, wSTOCK and `rSTOCK` redeemable
/// value) at the Chainlink feed price (multiplier-adjusted, D1; no buffer) + perp equity. Perp equity comes from a
/// signed report (EIP-712) of the venue account, adjusted by the adapter's onchain deposit/withdrawal totals since
/// the report, plus withdrawals in flight, and **marked to the feed price move since the report** with the reported
/// short sizes (DN-R14), so spot and short move together between reports. A report that moves NAV by more than
/// `SECOND_SIGNER_BPS` needs two distinct signers.
interface INavOracle {
    /// @notice A venue account report. `deposited` / `requested`: the adapter's cumulative totals the venue had
    /// credited at `timestamp` (so later flows are added onchain, never double counted).
    struct Report {
        uint256 equity;
        uint256 deposited;
        uint256 requested;
        uint64 tradeNonce; // the strategy's `tradeNonce` the report has seen (DN-R14)
        uint64 timestamp;
        uint256[] shortSizes; // per sleeve, base units 1e18 (DN-R14)
    }

    event Reported(
        uint256 equity, uint256 deposited, uint256 requested, uint64 timestamp, uint256 nav, uint256 signers
    );
    event SignerSet(address indexed signer, bool allowed);
    event MaxAgeSet(uint256 openSeconds, uint256 closedSeconds);

    error ZeroAddress();
    error BadSignature();
    error DuplicateSigner();
    /// @dev `moveBps` includes the single-signed moves not yet confirmed by a co-signed report.
    error NeedsSecondSigner(uint256 moveBps);
    error StaleReport(uint64 timestamp);
    error FutureReport(uint64 timestamp);
    error NotNewer(uint64 timestamp, uint64 last);
    error BadMaxAge();
    error AlreadySet();
    error BadReport();
    error TradeNotReported(uint64 reported, uint64 current);

    /// @notice DN-R4: moves above this (bps of NAV) need a second signer (1%).
    function SECOND_SIGNER_BPS() external view returns (uint256);

    /// @notice Accept a report signed by one allowed signer, or two distinct ones if the NAV moves by more than 1%.
    function submit(Report calldata r, bytes[] calldata signatures) external;
    /// @notice NAV in USDG raw units at the current report (reverts only on a broken feed).
    function nav() external view returns (uint256);
    /// @notice DN-R5: whether mint/burn may use `nav()` now: a report within the max age (15 min while the market is
    /// closed) that has seen the strategy's latest perp trade (DN-R14), and every held sleeve's oracle guard clear.
    function fresh() external view returns (bool);
    /// @notice Age of the last report, seconds.
    function reportAge() external view returns (uint256);
    /// @notice The last accepted report (with its short sizes).
    function lastReport() external view returns (Report memory);
    /// @notice The feed value of 1e18 units of sleeve `i` (USDG raw) recorded when the last report was accepted.
    function refQuote(uint256 i) external view returns (uint256);
    /// @notice Sum of the single-signed moves (bps of NAV) since the last report with two signers; a single-signed
    /// report that would take it above `SECOND_SIGNER_BPS` needs a second signer (DN-R4).
    function unconfirmedMoveBps() external view returns (uint256);
    /// @notice Perp side of the NAV: report equity + deposits − requests since it + pending withdrawals − the
    /// reported
    /// shorts' loss (or + gain) from the feed price move since the report.
    function perpValue() external view returns (uint256);
    /// @notice Spot side of the NAV (every sleeve), USDG raw.
    function spotValue() external view returns (uint256);
    /// @notice EIP-712 digest a signer signs for `r`.
    function reportDigest(Report calldata r) external view returns (bytes32);
    /// @notice Whether `signer` may sign reports.
    function isSigner(address signer) external view returns (bool);
}
