// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IMorpho, MarketParams, Market} from "morpho-blue/src/interfaces/IMorpho.sol";
import {IIrm} from "morpho-blue/src/interfaces/IIrm.sol";
import {MarketParamsLib} from "morpho-blue/src/libraries/MarketParamsLib.sol";
import {MathLib} from "morpho-blue/src/libraries/MathLib.sol";
import {MorphoBalancesLib} from "morpho-blue/src/libraries/periphery/MorphoBalancesLib.sol";
import {IShortInterestLens} from "./interfaces/IShortInterestLens.sol";
import {ILendoraRouter} from "./interfaces/ILendoraRouter.sol";
import {IStockWrapper} from "./interfaces/IStockWrapper.sol";
import {ILendoraOracle} from "./interfaces/ILendoraOracle.sol";
import {IMarketHours} from "./interfaces/IMarketHours.sol";

/// @notice The router views the lens needs (`LendoraRouter` public getters).
interface ILendoraRouterMarkets {
    /// @notice Morpho Blue.
    function MORPHO() external view returns (IMorpho);
    /// @notice The router's market record for `stock`.
    function market(address stock) external view returns (ILendoraRouter.Market memory);
}

/// @title ShortInterestLens
/// @notice Per-stock short interest read straight from chain (docs/prd/07 §3). Scope: Lendora markets only (the
/// stock-loan Morpho market and its `rSTOCK` Vault V2).
/// - `suppliedShares` = `underlyingEquivalent(totalSupplyAssets + vault idle)`, `borrowedShares` =
///   `underlyingEquivalent(totalBorrowAssets)`: shares of stock after the ERC-8056 multiplier (LM-R3).
/// - Totals are accrued to `block.timestamp` with `MorphoBalancesLib.expectedMarketBalances` (SI-R20).
/// - `utilizationWad` is the stock-loan market's `totalBorrowAssets / totalSupplyAssets` (accrued, rounded down);
///   the vault-level `borrowed / supplied` follows from the two share fields.
/// - `borrowRatePerSecWad` is the IRM's `borrowRateView(params, market())`: the rate the next accrual applies (A19).
/// - `bufferWad`, `guardTripped` from the market's `LendoraOracle`; `marketOpen` = `MarketHours.isOpen(now)`.
/// The 07 fields that need prices, supply or history (`borrowedUsd`, `siPctFloat`, APYs, `daysToCover`, flows) do not
/// fit the specified struct; the indexer and API compute them with the Lendora SDK from the same onchain inputs.
/// @dev Stateless and redeployable (SI-R21): the stock list is fixed at deployment, each market's wiring is read from
/// the router's listing, and there are no setters or owner.
contract ShortInterestLens is IShortInterestLens {
    using MarketParamsLib for MarketParams;
    using MathLib for uint256;
    using MorphoBalancesLib for IMorpho;

    /// @notice The router whose listed markets the lens reads.
    ILendoraRouterMarkets public immutable ROUTER;
    /// @notice Morpho Blue.
    IMorpho public immutable MORPHO;
    address[] internal _stocks;

    error UnknownStock(address stockToken);
    error ZeroAddress();

    constructor(address router, address[] memory stocks_) {
        if (router == address(0)) revert ZeroAddress();
        ROUTER = ILendoraRouterMarkets(router);
        MORPHO = ILendoraRouterMarkets(router).MORPHO();
        for (uint256 i; i < stocks_.length; i++) {
            if (ILendoraRouterMarkets(router).market(stocks_[i]).wrapper == address(0)) {
                revert UnknownStock(stocks_[i]);
            }
            _stocks.push(stocks_[i]);
        }
    }

    /// @notice The stock tokens this lens reports, in deployment order.
    function stocks() external view returns (address[] memory) {
        return _stocks;
    }

    /// @inheritdoc IShortInterestLens
    function snapshotAll() external view returns (StockSnapshot[] memory out) {
        out = new StockSnapshot[](_stocks.length);
        for (uint256 i; i < out.length; i++) {
            out[i] = snapshot(_stocks[i]);
        }
    }

    /// @inheritdoc IShortInterestLens
    function snapshot(address stockToken) public view returns (StockSnapshot memory s) {
        ILendoraRouter.Market memory m = ROUTER.market(stockToken);
        if (m.wrapper == address(0)) revert UnknownStock(stockToken);
        IStockWrapper w = IStockWrapper(m.wrapper);
        ILendoraOracle oracle = ILendoraOracle(m.params.oracle);

        // Morpho returns 4 values; the supply shares are not needed here.
        // slither-disable-next-line unused-return
        (uint256 supplyAssets,, uint256 borrowAssets,) = MORPHO.expectedMarketBalances(m.params);
        uint256 idle = IERC20(m.wrapper).balanceOf(m.vault);

        s.stockToken = stockToken;
        s.suppliedShares = w.underlyingEquivalent(supplyAssets + idle);
        s.borrowedShares = w.underlyingEquivalent(borrowAssets);
        s.utilizationWad = supplyAssets == 0 ? 0 : borrowAssets.wDivDown(supplyAssets);
        if (m.params.irm != address(0)) {
            Market memory stored = MORPHO.market(m.params.id());
            s.borrowRatePerSecWad = IIrm(m.params.irm).borrowRateView(m.params, stored);
        }
        s.bufferWad = oracle.buffer();
        s.marketOpen = IMarketHours(oracle.MARKET_HOURS()).isOpen(block.timestamp);
        s.guardTripped = oracle.guardTripped();
    }
}
