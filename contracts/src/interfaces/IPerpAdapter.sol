// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

/// @title Perp venue adapter (docs/prd/08-delta-neutral-vault.md, DN-R3, DN-R4, DN-R10).
/// @notice The only contract that owns the vault's venue account. Margin moves only between the `StrategyManager` and
/// the venue; withdrawals return only to this adapter and then to the strategy (DN-R10). Venue-agnostic: the tests
/// and testnet use `MockPerpVenue`; a live venue adapter needs the Phase 4 task 12 `[VERIFY]` items closed.
/// @dev Accounting the NAV oracle relies on (no double count between a report and the chain): `totalDeposited` and
/// `totalRequested` are cumulative USDG sent to / requested from the venue; `pending` is requested but not yet claimed
/// back. A signed NAV report carries the venue's equity plus the two totals it had seen (`NavOracle`).
interface IPerpAdapter {
    event MarginDeposited(uint256 amount, uint256 totalDeposited);
    event WithdrawalRequested(uint256 amount, uint256 totalRequested);
    event MarginClaimed(uint256 amount);
    event ShortAdjusted(bytes32 indexed market, int256 sizeDelta, uint256 size);

    error NotStrategy();
    error ZeroAmount();

    /// @notice The strategy manager: the only caller of every state-changing function.
    function strategy() external view returns (address);
    /// @notice Margin asset (USDG).
    function asset() external view returns (address);

    /// @notice Pull `amount` USDG from the strategy and post it as margin.
    function depositMargin(uint256 amount) external;
    /// @notice Ask the venue to return `amount` of free margin to this adapter (secure withdrawal, DN-R10).
    function requestWithdraw(uint256 amount) external;
    /// @notice Send every matured withdrawal to the strategy; returns the amount.
    function claimWithdrawn() external returns (uint256);
    /// @notice Change the short on `market` by `sizeDelta` base units (1e18; negative = more short), at a price no
    /// worse than `priceLimit` (1e18 USD per unit). On venues that match off-chain this is the onchain (priority)
    /// order path used by the guardian's unwind.
    function adjustShort(bytes32 market, int256 sizeDelta, uint256 priceLimit) external;

    /// @notice Cumulative USDG sent to the venue.
    function totalDeposited() external view returns (uint256);
    /// @notice Cumulative USDG requested back from the venue.
    function totalRequested() external view returns (uint256);
    /// @notice Requested and not yet claimed (in flight or matured at the venue).
    function pending() external view returns (uint256);
    /// @notice Account equity if the venue exposes it onchain (`readable = false` on venues that don't, e.g. Lighter:
    /// then only the signed report is used). The NAV oracle never trusts this over a report; keepers read it.
    function onchainEquity() external view returns (bool readable, uint256 equity);
    /// @notice Short size on `market` (base units, 1e18) if readable onchain.
    function shortSize(bytes32 market) external view returns (bool readable, uint256 size);
}
