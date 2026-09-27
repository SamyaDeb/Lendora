// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IStockWrapper} from "./interfaces/IStockWrapper.sol";
import {IHolderAllowlist} from "./interfaces/IHolderAllowlist.sol";
import {IScaledUIAmount} from "./interfaces/external/IScaledUIAmount.sol";

/// @title StockWrapper
/// @notice Fixed-balance ERC-20 wrapper of one Stock Token, so Morpho Blue only ever sees a plain ERC-20 (LM-R1…R7).
/// One wrapper unit is one raw Stock Token unit. Corporate actions change the ERC-8056 multiplier, never balances.
/// @dev No owner, no pause, no upgrade path (LM-R5). Stock Tokens sent here without `wrap` are not backed by any
/// wrapper unit and cannot be recovered.
///
/// Issuer powers this contract cannot prevent (verified Phase 0, docs/phase0/01-chain-facts.md §3.2):
/// - Pause (per token or global) and blocklisting of this wrapper or a recipient make `wrap`/`unwrap` revert with the
///   token's own `IsPaused()` / `Blocked(account)` errors. Wrapped units keep moving, so Morpho accounting keeps
/// working (LM-R5 as restated: anyone can unwrap whenever the Stock Token allows transfers).
/// - `adminBurn(address(this), x)` burns backing with no pause or blocklist check. `underlying.balanceOf(this) >=
///   totalSupply()` (LM-R7) therefore holds only absent `adminBurn`; afterwards the last `x` units cannot be unwrapped.
///   `backingShortfall()` (LM-R8) exposes the gap so monitoring can page (P0) without any event or state change here.
contract StockWrapper is ERC20, IStockWrapper {
    using SafeERC20 for IERC20;

    uint256 internal constant WAD = 1e18;

    IERC20 internal immutable _underlying;
    IHolderAllowlist internal immutable _holderAllowlist;
    uint8 internal immutable _decimals;

    /// @param underlying_ Stock Token (ERC-20 + ERC-8056).
    /// @param ticker Plain ticker, e.g. "NVDA" → name "Wrapped Stockline NVDA", symbol "wNVDA" (LM-R4).
    /// @param holderAllowlist_ Issuer allowlist adapter, or address(0) if the Stock Token has none (LM-R6, A3).
    constructor(address underlying_, string memory ticker, address holderAllowlist_)
        ERC20(string.concat("Wrapped Stockline ", ticker), string.concat("w", ticker))
    {
        if (underlying_ == address(0)) revert ZeroAddress();
        _underlying = IERC20(underlying_);
        _holderAllowlist = IHolderAllowlist(holderAllowlist_);
        _decimals = IERC20Metadata(underlying_).decimals();
    }

    /// @inheritdoc IERC20Metadata
    function decimals() public view override(ERC20, IERC20Metadata) returns (uint8) {
        return _decimals;
    }

    /// @notice The wrapped Stock Token (LM-R1).
    function underlying() external view returns (address) {
        return address(_underlying);
    }

    /// @notice Optional unwrap pre-check adapter (LM-R6); address(0) = none.
    function holderAllowlist() external view returns (address) {
        return address(_holderAllowlist);
    }

    /// @notice Pulls `rawAmount` Stock Token units from the caller and mints the same number of wrapper units to `to`
    /// (LM-R1). Reverts unless exactly `rawAmount` arrives, so a fee-on-transfer or rebasing underlying cannot break
    /// backing.
    function wrap(uint256 rawAmount, address to) external returns (uint256 minted) {
        if (rawAmount == 0) revert ZeroAmount();
        if (to == address(0)) revert ZeroAddress();

        uint256 balanceBefore = _underlying.balanceOf(address(this));
        _underlying.safeTransferFrom(msg.sender, address(this), rawAmount);
        uint256 received = _underlying.balanceOf(address(this)) - balanceBefore;
        if (received != rawAmount) revert UnexpectedTransferAmount(rawAmount, received);

        _mint(to, rawAmount);
        emit Wrapped(msg.sender, to, rawAmount);
        return rawAmount;
    }

    /// @notice Burns `amount` of the caller's wrapper units and sends the same raw Stock Token units to `to` (LM-R1).
    /// Open to any holder, including liquidators, whenever the Stock Token allows the transfer (LM-R5).
    function unwrap(uint256 amount, address to) external returns (uint256 rawOut) {
        if (amount == 0) revert ZeroAmount();
        if (to == address(0)) revert ZeroAddress();
        if (address(_holderAllowlist) != address(0) && !_holderAllowlist.isAllowed(to)) {
            revert RecipientNotAllowed(to);
        }

        _burn(msg.sender, amount);
        _underlying.safeTransfer(to, amount);
        emit Unwrapped(msg.sender, to, amount);
        return amount;
    }

    /// @notice The underlying's current ERC-8056 multiplier, 1e18 = 1.0 (LM-R3). Passed through unmodified, so a
    /// corporate action is visible in the same block it takes effect.
    function multiplier() public view returns (uint256) {
        return IScaledUIAmount(address(_underlying)).uiMultiplier();
    }

    /// @notice Wrapper units not backed by the Stock Token held here: `max(0, totalSupply − balance)` (LM-R8).
    /// @dev Zero unless the issuer has `adminBurn`ed this contract's balance (or the underlying misbehaves). A pure
    /// view: the monitoring hook is to read it every block and page on any non-zero value.
    function backingShortfall() external view returns (uint256) {
        uint256 backing = _underlying.balanceOf(address(this));
        uint256 supply = totalSupply();
        return supply > backing ? supply - backing : 0;
    }

    /// @notice Shares of the underlying stock represented by `amount` wrapper units, rounded down (LM-R3).
    function underlyingEquivalent(uint256 amount) external view returns (uint256) {
        return Math.mulDiv(amount, multiplier(), WAD);
    }
}
