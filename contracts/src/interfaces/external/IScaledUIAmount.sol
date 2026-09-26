// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ERC-8056 Scaled UI Amount (subset Stockline depends on).
/// @notice Verbatim from https://eips.ethereum.org/EIPS/eip-8056 (core + the required `newUIMultiplier` extension).
/// Robinhood Chain Stock Tokens implement it. Balances and transfers are raw; the multiplier (1e18 = 1.0) maps raw
/// token amounts to underlying shares: `shares = raw * uiMultiplier() / 1e18`.
/// @dev Verified Phase 0 (A1): live Stock Tokens return the *effective* multiplier from `uiMultiplier()` once
/// `block.timestamp >= effectiveAt()`, without a separate poke (docs/phase0/01-chain-facts.md §3.3).
/// The live token has no `UIMultiplierUpdateCancelled` event; it is kept here from the EIP and is never emitted.
interface IScaledUIAmount {
    event UIMultiplierUpdated(uint256 oldMultiplier, uint256 newMultiplier, uint256 effectiveAtTimestamp);
    event UIMultiplierUpdateCancelled(uint256 cancelledMultiplier, uint256 cancelledEffectiveAt);

    function uiMultiplier() external view returns (uint256);
    function newUIMultiplier() external view returns (uint256);
    function effectiveAt() external view returns (uint256);
}
