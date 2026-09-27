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

    /// @notice The wrapped Stock Token.
    function underlying() external view returns (address);
    /// @notice Optional unwrap pre-check adapter (LM-R6).
    function holderAllowlist() external view returns (address);
    /// @notice Pull `rawAmount` Stock Tokens and mint the same amount of wSTOCK to `to` (LM-R1).
    function wrap(uint256 rawAmount, address to) external returns (uint256 minted);
    /// @notice Burn `amount` wSTOCK and send the same raw amount of Stock Token to `to` (LM-R5).
    function unwrap(uint256 amount, address to) external returns (uint256 rawOut);
    /// @notice The Stock Token ERC-8056 multiplier (1e18 = 1.0); display only (D1).
    function multiplier() external view returns (uint256); // 1e18 = 1.0
    /// @notice Underlying shares represented by `amount` wSTOCK at the current multiplier (display).
    function underlyingEquivalent(uint256 amount) external view returns (uint256);
    /// @notice LM-R8: wrapper units not backed by held Stock Tokens (non-zero only after an issuer `adminBurn`).
    function backingShortfall() external view returns (uint256);
}
