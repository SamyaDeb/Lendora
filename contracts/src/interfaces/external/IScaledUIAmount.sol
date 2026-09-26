// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ERC-8056 Scaled UI Amount (the subset Stockline depends on).
/// @notice Balances and transfers are raw; the multiplier (1e18 = 1.0) maps raw token amounts to underlying shares:
/// `shares = raw * uiMultiplier() / 1e18`.
/// @dev Robinhood's `Stock` implementation (Sourcify 4663/0xb35490d6f9163DE4F80d88dc75c3516eb64C5aE2) splits this
/// across three interfaces: `IScaledUIAmount` (`uiMultiplier`, events `UIMultiplierUpdated` and
/// `TransferWithScaledUI`),
/// `IScaledUIAmountNewUIMultiplier` (`newUIMultiplier`, `effectiveAt`) and `IScaledUIAmountBalances`. It returns the
/// *effective* multiplier from `uiMultiplier()` once `block.timestamp >= effectiveAt()`, without a poke (A1, verified
/// Phase 0; docs/phase0/01-chain-facts.md §3.3). `UIMultiplierUpdateCancelled` comes from the EIP draft only: the live
/// token has no cancel path and never emits it. Stockline code never listens for it.
interface IScaledUIAmount {
    event UIMultiplierUpdated(uint256 oldMultiplier, uint256 newMultiplier, uint256 effectiveAtTimestamp);
    event UIMultiplierUpdateCancelled(uint256 cancelledMultiplier, uint256 cancelledEffectiveAt);

    function uiMultiplier() external view returns (uint256);
    function newUIMultiplier() external view returns (uint256);
    function effectiveAt() external view returns (uint256);
}
