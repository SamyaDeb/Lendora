// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {IHolderAllowlist} from "../interfaces/IHolderAllowlist.sol";
import {IAccessControlsRegistry} from "../interfaces/external/IRobinhoodStock.sol";

/// @title BlocklistHolderAllowlist
/// @notice Optional LM-R6 pre-check for `StockWrapper.unwrap`: a recipient is allowed unless the issuer's registry has
/// blocklisted it. Without this adapter the Stock Token itself reverts `Blocked(recipient)` (verified Phase 0), so the
/// adapter only swaps that for the wrapper's `RecipientNotAllowed(to)` before any state change.
/// @dev Launch wrappers deploy with `holderAllowlist = address(0)` (D10 R3). Stateless and immutable.
contract BlocklistHolderAllowlist is IHolderAllowlist {
    IAccessControlsRegistry public immutable registry;

    error ZeroAddress();

    constructor(address registry_) {
        if (registry_ == address(0)) revert ZeroAddress();
        registry = IAccessControlsRegistry(registry_);
    }

    /// @inheritdoc IHolderAllowlist
    function isAllowed(address account) external view returns (bool) {
        return !registry.isBlocked(account);
    }
}
