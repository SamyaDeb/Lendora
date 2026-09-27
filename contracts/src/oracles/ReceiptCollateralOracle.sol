// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {OracleMath} from "../libraries/OracleMath.sol";
import {StocklineOracleBase} from "./StocklineOracleBase.sol";

/// @title ReceiptCollateralOracle
/// @notice Morpho `IOracle` for a receipt-collateral market: collateral `rSTOCK` (Vault V2 share), loan USDG (G5,
/// docs/prd/05-collateral-router.md §3). The collateral is marked **down** by the same buffer:
/// `price() = convertToAssets(1 share) · STOCK/USD · (1 − b(t)) / USDG/USD`, scaled (OR-R1, D1: no multiplier).
/// @dev Vault V2 share prices rise no faster than the vault's `maxRate` and fall on realized losses, so
/// `convertToAssets` is not donation-manipulable. Listed only after 30 clean days (CL-R10).
contract ReceiptCollateralOracle is StocklineOracleBase {
    /// @notice The rSTOCK Vault V2 (collateral).
    address public immutable VAULT;
    /// @notice The loan token of the market (USDG).
    address public immutable LOAN_TOKEN;
    /// @notice One vault share in raw units.
    uint256 public immutable ONE_SHARE;
    /// @notice `36 + loanDecimals − shareDecimals + usdgFeedDecimals − assetDecimals − stockFeedDecimals` (6 at
    /// launch).
    uint256 public immutable SCALE_EXP;

    error BadDecimals();

    constructor(Deployment memory d, Params memory p, address vault, address loanToken) StocklineOracleBase(d, p) {
        if (vault == address(0) || loanToken == address(0)) revert ZeroAddress();
        VAULT = vault;
        LOAN_TOKEN = loanToken;
        uint256 shareDecimals = IERC20Metadata(vault).decimals();
        ONE_SHARE = 10 ** shareDecimals;
        int256 e = 36 + int256(uint256(IERC20Metadata(loanToken).decimals())) - int256(shareDecimals)
            + int256(uint256(USDG_FEED_ADDRESS.decimals())) - int256(uint256(IERC20Metadata(d.wrapper).decimals()))
            - int256(uint256(STOCK_FEED.decimals()));
        if (e < 0 || e > 60) revert BadDecimals();
        SCALE_EXP = uint256(e);
    }

    /// @notice Morpho IOracle price of rSTOCK collateral in the loan token, haircut by the buffer now.
    function price() external view returns (uint256) {
        return priceAt(block.timestamp);
    }

    /// @notice The same price with the buffer at `t` (no new rounds).
    function priceAt(uint256 t) public view returns (uint256) {
        (uint256 p, uint256 u,) = _readStock();
        (uint256 usdg,,) = _readUsdg();
        uint256 assetsPerShare = IERC4626(VAULT).convertToAssets(ONE_SHARE);
        return OracleMath.receiptPrice(assetsPerShare, p, usdg, bufferAt(t, u), SCALE_EXP);
    }
}
