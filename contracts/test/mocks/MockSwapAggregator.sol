// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice DEX/aggregator stand-in for router swaps (RT-R3) and guard-keeper price reads (OR-R31). Pays out of its
/// own inventory at a settable raw-unit rate, and can misbehave on purpose: partial fills, fees, and lying about the
/// amount it sent. The router must check balances, never the return value.
/// @dev [VERIFY] which DEX/aggregator Robinhood Chain uses; the router will call it through an allowlisted target and
/// opaque `swapData`, so only this contract changes when the real venue is known.
contract MockSwapAggregator {
    using SafeERC20 for IERC20;

    uint256 internal constant WAD = 1e18;

    /// @notice amountOut = amountIn * rate / 1e18, in raw token units (decimals are folded into the rate).
    mapping(address tokenIn => mapping(address tokenOut => uint256)) public rate;

    uint256 public feeBps;
    /// @notice Fraction of `amountIn` actually used (1e18 = all). The unused part is refunded.
    uint256 public fillFraction = WAD;
    /// @notice If non-zero, `swap` returns this instead of the true output.
    uint256 public reportedAmountOut;

    error InsufficientOutput(uint256 out, uint256 minOut);
    error NoRate();

    event Swapped(address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut, address to);

    function setRate(address tokenIn, address tokenOut, uint256 rateWad) external {
        rate[tokenIn][tokenOut] = rateWad;
    }

    function setFeeBps(uint256 bps) external {
        require(bps <= 10_000, "bps");
        feeBps = bps;
    }

    function setFillFraction(uint256 fraction) external {
        require(fraction <= WAD, "fraction");
        fillFraction = fraction;
    }

    function setReportedAmountOut(uint256 amount) external {
        reportedAmountOut = amount;
    }

    function quote(address tokenIn, address tokenOut, uint256 amountIn) public view returns (uint256) {
        uint256 r = rate[tokenIn][tokenOut];
        if (r == 0) revert NoRate();
        uint256 out = Math.mulDiv(amountIn, r, WAD);
        return out - out * feeBps / 10_000;
    }

    /// @notice Exact-in swap. Pulls `amountIn` from the caller, refunds the unfilled part, sends output to `to`.
    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, address to)
        external
        returns (uint256)
    {
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        uint256 used = Math.mulDiv(amountIn, fillFraction, WAD);
        if (used < amountIn) IERC20(tokenIn).safeTransfer(msg.sender, amountIn - used);

        uint256 out = quote(tokenIn, tokenOut, used);
        if (out < minOut) revert InsufficientOutput(out, minOut);
        IERC20(tokenOut).safeTransfer(to, out);
        emit Swapped(tokenIn, tokenOut, used, out, to);
        return reportedAmountOut != 0 ? reportedAmountOut : out;
    }
}
