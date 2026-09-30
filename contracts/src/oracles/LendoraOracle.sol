// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {ICollateralToken} from "../interfaces/ICollateralToken.sol";
import {OracleMath} from "../libraries/OracleMath.sol";
import {LendoraOracleBase} from "./LendoraOracleBase.sol";

/// @title LendoraOracle
/// @notice Morpho `IOracle` for a stock-loan market: collateral `clUSDG`, loan `wSTOCK` (docs/prd/04-oracle.md §1).
/// `price() = clUSDG.valuePerToken() · USDG/USD / (STOCK/USD · (1 + b(t)))`, scaled to Morpho's
/// `1e36 · 10^loanDecimals / 10^collateralDecimals` (OR-R1, D1: the feed already includes the ERC-8056 multiplier).
contract LendoraOracle is LendoraOracleBase {
    /// @notice The market's collateral token (`clUSDG`).
    address public immutable COLLATERAL;
    /// @notice `36 + loanDecimals − collateralDecimals + stockFeedDecimals − usdgFeedDecimals` (48 for the launch
    /// set).
    uint256 public immutable SCALE_EXP;

    error BadDecimals();

    constructor(Deployment memory d, Params memory p, address collateral) LendoraOracleBase(d, p) {
        if (collateral == address(0)) revert ZeroAddress();
        COLLATERAL = collateral;
        int256 e = 36 + int256(uint256(IERC20Metadata(d.wrapper).decimals()))
            - int256(uint256(IERC20Metadata(collateral).decimals())) + int256(uint256(STOCK_FEED.decimals()))
            - int256(uint256(USDG_FEED_ADDRESS.decimals()));
        if (e < 0 || e > 60) revert BadDecimals();
        SCALE_EXP = uint256(e);
    }

    /// @notice Morpho price at `block.timestamp`. Never reverts on feed or guard conditions (OR-R2).
    function price() external view returns (uint256) {
        return priceAt(block.timestamp);
    }

    /// @notice `price()` with the buffer at `t`: what the router and app use for "at t + 24h" checks (RT-R1).
    function priceAt(uint256 t) public view returns (uint256) {
        (uint256 p, uint256 u,) = _readStock();
        (uint256 usdg,,) = _readUsdg();
        uint256 vpt = ICollateralToken(COLLATERAL).valuePerToken();
        return OracleMath.stockLoanPrice(vpt, usdg, p, bufferAt(t, u), SCALE_EXP);
    }
}
