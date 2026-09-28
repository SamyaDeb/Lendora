// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice UniversalRouter-style swap target for `SwapMode.Transfer` (Q4): the caller transfers `amountIn` first, then
/// calls `swap`, which pays `amountIn × rate` of `tokenOut` to `to` from inventory. Rates are WAD in raw units.
contract MockPayFirstSwap {
    using SafeERC20 for IERC20;

    mapping(address => mapping(address => uint256)) public rateWad;

    function setRate(address tokenIn, address tokenOut, uint256 rate) external {
        rateWad[tokenIn][tokenOut] = rate;
    }

    function swap(address tokenIn, address tokenOut, uint256 amountIn, address to) external returns (uint256 out) {
        out = amountIn * rateWad[tokenIn][tokenOut] / 1e18;
        IERC20(tokenOut).safeTransfer(to, out);
    }
}
