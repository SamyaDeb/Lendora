// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IMorpho, MarketParams, Market, Position, Id} from "morpho-blue/src/interfaces/IMorpho.sol";
import {IOracle} from "morpho-blue/src/interfaces/IOracle.sol";
import {MarketParamsLib} from "morpho-blue/src/libraries/MarketParamsLib.sol";
import {IMetaMorphoV1_1, MarketAllocation} from "metamorpho/src/interfaces/IMetaMorphoV1_1.sol";
import {MetaMorphoV1_1Factory} from "metamorpho/src/MetaMorphoV1_1Factory.sol";
import {StockWrapper} from "../../../src/StockWrapper.sol";
import {AggregatorV3Interface} from "../../../src/interfaces/external/AggregatorV3Interface.sol";
import {Phase0ForkBase} from "./Phase0ForkBase.sol";

/// @dev Minimal settable Morpho oracle for the fork run (not StocklineOracle). Price of 1 USDG in wNVDA, scaled by
/// 1e36 * 10^18 / 10^6.
contract TestOracle is IOracle {
    uint256 public price;

    function setUsdPerStock(uint256 usd8) external {
        price = 1e48 * 1e8 / usd8;
    }
}

/// @notice WS-B.4: lifecycle on the real Morpho Blue deployment with a wrapped real Stock Token as the loan asset and
/// real USDG as collateral, AdaptiveCurveIRM, LLTV 77% (LM-R11). Also the idle market (A5) and a MetaMorpho v1.1
/// vault over the wrapper (A6). No MetaMorpho factory exists on Robinhood Chain, so the test deploys one on the fork.
contract MorphoMarketForkTest is Phase0ForkBase {
    using MarketParamsLib for MarketParams;

    IMorpho internal morpho = IMorpho(MORPHO);
    StockWrapper internal wNVDA;
    TestOracle internal oracle;
    MarketParams internal market;
    MarketParams internal idle;

    address internal lender = makeAddr("lender");
    address internal borrower = makeAddr("borrower");
    address internal liquidator = makeAddr("liquidator");

    function setUp() public override {
        super.setUp();
        assertTrue(morpho.isIrmEnabled(ADAPTIVE_CURVE_IRM), "AdaptiveCurveIRM enabled");
        assertTrue(morpho.isLltvEnabled(0.77e18), "LLTV 77% enabled");
        assertTrue(morpho.isLltvEnabled(0.625e18), "LLTV 62.5% enabled");
        assertTrue(morpho.isIrmEnabled(address(0)), "A5: irm 0 enabled");
        assertTrue(morpho.isLltvEnabled(0), "A5: lltv 0 enabled");

        wNVDA = new StockWrapper(NVDA, "NVDA", address(0));
        oracle = new TestOracle();
        (, int256 answer,,,) = AggregatorV3Interface(FEED_NVDA).latestRoundData();
        oracle.setUsdPerStock(uint256(answer));
        market = MarketParams(address(wNVDA), USDG, address(oracle), ADAPTIVE_CURVE_IRM, 0.77e18);
        idle = MarketParams(address(wNVDA), address(0), address(0), address(0), 0);
        morpho.createMarket(market);
        morpho.createMarket(idle);
    }

    function _wrapFor(address who, uint256 amount) internal {
        deal(NVDA, who, amount, true);
        vm.startPrank(who);
        IERC20(NVDA).approve(address(wNVDA), amount);
        wNVDA.wrap(amount, who);
        IERC20(address(wNVDA)).approve(MORPHO, type(uint256).max);
        vm.stopPrank();
    }

    function test_phase0_morpho_lifecycle_LMR11() public {
        (, int256 p0,,,) = AggregatorV3Interface(FEED_NVDA).latestRoundData();
        emit log_named_decimal_int("NVDA/USD at fork", p0, 8);

        _wrapFor(lender, 100e18);
        vm.prank(lender);
        morpho.supply(market, 100e18, 0, lender, "");

        // Borrower: collateral worth 1.5x the borrow at the fork price (LTV 66.7%, as in 00-overview's example).
        uint256 borrowAmt = 20e18;
        uint256 collateral = uint256(p0) * 20 * 15 / 10 / 100; // USD 6dp: p0(8dp) * 20 * 1.5 / 100
        _fundUsdg(borrower, collateral);
        vm.startPrank(borrower);
        IERC20(USDG).approve(MORPHO, collateral);
        morpho.supplyCollateral(market, collateral, borrower, "");
        morpho.borrow(market, borrowAmt, 0, borrower, borrower);
        vm.stopPrank();
        assertEq(IERC20(address(wNVDA)).balanceOf(borrower), borrowAmt);
        vm.prank(borrower);
        wNVDA.unwrap(borrowAmt, borrower); // borrower now holds real NVDA to sell
        assertEq(IERC20(NVDA).balanceOf(borrower), borrowAmt);

        // 30 days of interest in wNVDA.
        vm.warp(block.timestamp + 30 days);
        morpho.accrueInterest(market);
        Market memory m = morpho.market(market.id());
        assertGt(m.totalBorrowAssets, borrowAmt, "interest accrued in stock");
        emit log_named_decimal_uint("borrow after 30d (wNVDA)", m.totalBorrowAssets, 18);

        // Price +20% makes the position unhealthy (liquidation above p0 * 1.5 * 0.77 = 1.155 * p0).
        oracle.setUsdPerStock(uint256(p0) * 120 / 100);

        // Liquidator repays half the shares with wNVDA wrapped from real NVDA, seizes USDG, then unwraps leftovers.
        _wrapFor(liquidator, 20e18);
        Position memory pos = morpho.position(market.id(), borrower);
        vm.prank(liquidator);
        (uint256 seized, uint256 repaid) = morpho.liquidate(market, borrower, 0, pos.borrowShares / 2, "");
        assertGt(seized, 0);
        assertGt(IERC20(USDG).balanceOf(liquidator), 0, "liquidator received real USDG");
        emit log_named_decimal_uint("repaid wNVDA", repaid, 18);
        emit log_named_decimal_uint("seized USDG", seized, 6);
        uint256 left = IERC20(address(wNVDA)).balanceOf(liquidator);
        vm.prank(liquidator);
        wNVDA.unwrap(left, liquidator);
        assertEq(IERC20(NVDA).balanceOf(liquidator), left);

        // Lender exits with principal plus interest in stock (market has free liquidity).
        Position memory lp = morpho.position(market.id(), lender);
        vm.prank(lender);
        (uint256 withdrawn,) = morpho.withdraw(market, 0, lp.supplyShares / 2, lender, lender);
        assertGt(withdrawn, 50e18, "half the shares are worth more than half the principal");
        vm.prank(lender);
        wNVDA.unwrap(withdrawn, lender);
        assertEq(wNVDA.totalSupply(), IERC20(NVDA).balanceOf(address(wNVDA)), "LM-R7 after lifecycle");
    }

    function test_phase0_morpho_idleMarketAndMetaMorphoV11() public {
        address curator = makeAddr("curator");
        MetaMorphoV1_1Factory factory = new MetaMorphoV1_1Factory(MORPHO);
        IMetaMorphoV1_1 vault = factory.createMetaMorpho(curator, 1 days, address(wNVDA), "Stockline NVDA", "rNVDA", 0);

        vm.startPrank(curator);
        vault.submitCap(market, 1000e18);
        vault.submitCap(idle, 1000e18);
        vm.warp(block.timestamp + 1 days);
        vault.acceptCap(market);
        vault.acceptCap(idle);
        Id[] memory q = new Id[](2);
        q[0] = market.id();
        q[1] = idle.id();
        vault.setSupplyQueue(q);
        vm.stopPrank();

        _wrapFor(lender, 50e18);
        vm.startPrank(lender);
        IERC20(address(wNVDA)).approve(address(vault), 50e18);
        uint256 shares = vault.deposit(50e18, lender);
        vm.stopPrank();
        assertGt(shares, 0);
        assertEq(morpho.market(market.id()).totalSupplyAssets, 50e18, "supply queue fills the stock market first");

        // Allocator moves 20 to idle (LM-R31 mechanism).
        MarketAllocation[] memory alloc = new MarketAllocation[](2);
        alloc[0] = MarketAllocation(market, 30e18);
        alloc[1] = MarketAllocation(idle, type(uint256).max);
        vm.prank(curator);
        vault.reallocate(alloc);
        assertEq(morpho.market(idle.id()).totalSupplyAssets, 20e18);

        vm.prank(lender);
        vault.redeem(shares, lender, lender);
        assertApproxEqAbs(IERC20(address(wNVDA)).balanceOf(lender), 50e18, 2);
    }
}
