// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/// @title Stockline stock wrapper (docs/prd/03-lending-markets.md §1).
interface IStockWrapper is IERC20Metadata {
    event Wrapped(address indexed caller, address indexed to, uint256 amount);
    event Unwrapped(address indexed caller, address indexed to, uint256 amount);

    error ZeroAmount();
    error ZeroAddress();
    /// @notice The underlying moved a different amount than requested (fee-on-transfer or rebasing). A2.
    error UnexpectedTransferAmount(uint256 expected, uint256 received);
    /// @notice LM-R6: `to` may not hold the Stock Token under the issuer's rules.
    error RecipientNotAllowed(address to);

    function underlying() external view returns (address);
    function holderAllowlist() external view returns (address);
    function wrap(uint256 rawAmount, address to) external returns (uint256 minted);
    function unwrap(uint256 amount, address to) external returns (uint256 rawOut);
    function multiplier() external view returns (uint256); // 1e18 = 1.0
    function underlyingEquivalent(uint256 amount) external view returns (uint256);
}
