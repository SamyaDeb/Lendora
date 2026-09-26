// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

/// @title Holder allowlist adapter (LM-R6).
/// @notice Isolates the unknown issuer-level transfer rules of a Stock Token behind one view. If the issuer has an
/// allowlist, deploy a small adapter that translates its interface to this one and pass it to the `StockWrapper`
/// constructor; otherwise pass `address(0)`. Phase 0 (A3): Robinhood Stock Tokens have no allowlist but an issuer
/// blocklist; the token itself reverts `Blocked(account)` on a blocked recipient (docs/phase0/01-chain-facts.md §3.2).
interface IHolderAllowlist {
    /// @return True if `account` may receive and hold the Stock Token.
    function isAllowed(address account) external view returns (bool);
}
