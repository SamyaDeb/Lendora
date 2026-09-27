// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IMorpho, MarketParams, Market, Position} from "morpho-blue/src/interfaces/IMorpho.sol";
import {MarketParamsLib} from "morpho-blue/src/libraries/MarketParamsLib.sol";
import {VaultV2Ids} from "../../../src/libraries/VaultV2Ids.sol";
import {
    IVaultV2Min,
    IVaultV2FactoryMin,
    IMorphoMarketV1AdapterV2Min
} from "../../../src/interfaces/external/IMorphoVaultV2.sol";
import {ForkConfig} from "../../../script/ForkConfig.sol";
import {Phase1ForkBase} from "./Phase1ForkBase.sol";

/// @notice Task 7 on a fork: the deploy logic the scripts run (script/StocklineDeploy.sol), against the live Morpho
/// Blue, Vault V2 factories, Stock Tokens, feeds and USDG; then supply → allocate → borrow → repay → withdraw
/// through
/// the deployed vault and market (LM-R10, LM-R20, LM-R22, LM-R23, LM-R30…R32 mechanics).
contract DeployForkTest is Phase1ForkBase, ForkConfig {
    using MarketParamsLib for MarketParams;

    address internal deployer = makeAddr("deployer");
    CoreConfig internal c;
    Core internal core;
    StockDeployment internal nvdaD;
    StockConfig[] internal stocksCfg;

    function setUp() public override {
        super.setUp();
        c = forkCoreConfig(deployer);
        StockConfig[] memory s = forkStocks();
        for (uint256 i; i < s.length; i++) {
            stocksCfg.push(s[i]);
            deal(s[i].token, deployer, 2 * SEED, true);
        }
        vm.startPrank(deployer);
        core = _deployCore(c, s);
        for (uint256 i; i < s.length; i++) {
            StockDeployment memory d = _deployStock(c, core, s[i]);
            if (i == 1) nvdaD = d;
        }
        core = _finalize(c, core);
        vm.stopPrank();
    }

    function test_LM_R10_R20_deploymentWiring() public view {
        MarketParams memory m = nvdaD.market;
        assertEq(m.loanToken, address(nvdaD.wrapper));
        assertEq(m.collateralToken, address(core.clUSDG));
        assertEq(m.oracle, address(nvdaD.oracle));
        assertEq(m.irm, ADAPTIVE_CURVE_IRM);
        assertEq(m.lltv, 0.77e18);
        Market memory mk = IMorpho(MORPHO).market(m.id());
        assertGt(mk.lastUpdate, 0, "market created on the live Morpho");
        assertEq(mk.totalSupplyAssets, SEED, "seeded against share inflation");

        IVaultV2Min v = IVaultV2Min(nvdaD.vault);
        assertTrue(IVaultV2FactoryMin(c.vaultFactory).isVaultV2(nvdaD.vault), "official factory");
        assertEq(v.asset(), address(nvdaD.wrapper));
        assertEq(v.symbol(), "rNVDA");
        assertEq(v.owner(), address(core.timelock));
        assertEq(v.curator(), c.curator);
        assertTrue(v.isSentinel(c.guardian));
        assertTrue(v.isAllocator(c.allocator) && v.isAllocator(c.owner));
        assertFalse(v.isAllocator(deployer), "temporary allocator removed");
        assertTrue(v.isAdapter(nvdaD.adapter));
        assertEq(v.adaptersLength(), 1);
        assertEq(v.liquidityAdapter(), address(0), "deposits stay idle until allocated (03 s3)");
        assertEq(v.performanceFee(), 0.1e18);
        assertEq(v.performanceFeeRecipient(), c.feeSplitter);
        assertEq(v.maxRate(), 200e16 / uint256(365 days));
        assertEq(v.forceDeallocatePenalty(nvdaD.adapter), 0);
        assertEq(IMorphoMarketV1AdapterV2Min(nvdaD.adapter).parentVault(), nvdaD.vault);

        // LM-R23 caps.
        bytes32 mid = VaultV2Ids.marketId(nvdaD.adapter, m);
        assertEq(v.absoluteCap(mid), nvdaD.capAssets);
        assertEq(v.relativeCap(mid), 0.9e18);
        (uint256 answer,) = nvdaD.oracle.stockAnswer();
        assertApproxEqRel(nvdaD.capAssets * answer / 1e8, 1_000_000e18, 1e12, "$1M launch cap at listing price");

        // 48h timelocks on harmful curator actions, none on decreases.
        assertEq(v.timelock(IVaultV2Min.addAdapter.selector), 48 hours);
        assertEq(v.timelock(IVaultV2Min.increaseAbsoluteCap.selector), 48 hours);
        assertEq(v.timelock(IVaultV2Min.setIsAllocator.selector), 48 hours);
        assertEq(v.timelock(IVaultV2Min.setPerformanceFee.selector), 48 hours);
        assertEq(v.timelock(IVaultV2Min.increaseTimelock.selector), 48 hours);
        assertEq(v.timelock(IVaultV2Min.decreaseAbsoluteCap.selector), 0);
        assertEq(
            IMorphoMarketV1AdapterV2Min(nvdaD.adapter).timelock(IMorphoMarketV1AdapterV2Min.burnShares.selector),
            48 hours
        );

        // Oracles and calendar owned by the timelock.
        assertEq(nvdaD.oracle.owner(), address(core.timelock));
        assertEq(core.router.owner(), address(core.timelock));
        assertEq(
            uint256(core.router.swapMode(_ext("uniswap.universalRouter"))), 2, "UniversalRouter, transfer mode (A8)"
        );
        assertTrue(core.router.market(NVDA).listed);
        assertEq(core.marketHours.owner(), address(core.timelock));
        assertEq(core.timelock.getMinDelay(), 48 hours);
        assertTrue(core.timelock.hasRole(core.timelock.PROPOSER_ROLE(), c.owner));
        assertEq(nvdaD.oracle.guardian(), c.guardian);
        assertEq(nvdaD.oracle.keeper(), c.guardKeeper);
        assertEq(nvdaD.oracle.blocklist(), c.issuerRegistry);
        assertGt(core.marketHours.eventCount(NVDA), 0, "NVDA earnings window pushed (D5)");
        assertEq(core.marketHours.eventCount(SPY), 0, "no event buffer for SPY");
    }

    /// Vault V2 records `firstTotalAssets` in transient storage once per transaction; `isolate` runs every call as its
    /// own transaction, as on chain.
    /// forge-config: default.isolate = true
    function test_LM_R22_R30_supplyAllocateBorrowRepayWithdraw() public {
        IVaultV2Min v = IVaultV2Min(nvdaD.vault);
        address lender = makeAddr("lender");
        address borrower = makeAddr("borrower");

        // Lender: NVDA → wNVDA → rNVDA.
        deal(NVDA, lender, 100e18, true);
        vm.startPrank(lender);
        IERC20(NVDA).approve(address(nvdaD.wrapper), 100e18);
        nvdaD.wrapper.wrap(100e18, lender);
        IERC20(address(nvdaD.wrapper)).approve(address(v), 100e18);
        uint256 shares = v.deposit(100e18, lender);
        vm.stopPrank();
        assertGt(shares, 0);

        // Allocator: up to the relative cap (U_MAX = 90%) goes to the market; 10% stays idle.
        vm.prank(c.allocator);
        vm.expectRevert(); // RelativeCapExceeded
        v.allocate(nvdaD.adapter, abi.encode(nvdaD.market), 100e18);
        vm.prank(c.allocator);
        v.allocate(nvdaD.adapter, abi.encode(nvdaD.market), 90e18);

        // Borrower: USDG → clUSDG collateral through the router (addCollateral needs no attestation), then borrow
        // directly on Morpho (permissionless; the router's entry checks are soft gates, 05 §1).
        (uint256 p,) = nvdaD.oracle.stockAnswer();
        uint256 collateral = p * 10 * 2 / 100; // 2x the debt value, USDG 6 dp
        _fundUsdg(borrower, collateral);
        vm.startPrank(borrower);
        IERC20(USDG).approve(address(core.router), collateral);
        core.router.addCollateral(NVDA, collateral, borrower, block.timestamp);
        vm.stopPrank();
        vm.prank(borrower);
        IMorpho(MORPHO).borrow(nvdaD.market, 10e18, 0, borrower, borrower);
        assertEq(IERC20(address(nvdaD.wrapper)).balanceOf(borrower), 10e18);

        vm.warp(block.timestamp + 7 days);
        IMorpho(MORPHO).accrueInterest(nvdaD.market);

        // Repay all (interest in wNVDA), withdraw collateral, unwrap to USDG.
        deal(NVDA, borrower, 1e18, true); // interest, as real NVDA wrapped 1:1 (never `deal` wrapper units)
        vm.startPrank(borrower);
        IERC20(NVDA).approve(address(nvdaD.wrapper), 1e18);
        nvdaD.wrapper.wrap(1e18, borrower);
        IERC20(address(nvdaD.wrapper)).approve(MORPHO, type(uint256).max);
        (, uint128 borrowShares,) = _position(borrower);
        IMorpho(MORPHO).repay(nvdaD.market, 0, borrowShares, borrower, "");
        IMorpho(MORPHO).withdrawCollateral(nvdaD.market, collateral, borrower, borrower);
        core.clUSDG.unwrap(collateral, borrower);
        vm.stopPrank();
        assertEq(IERC20(USDG).balanceOf(borrower), collateral);

        // Guardian (sentinel) pulls the liquidity back (LM-R31/R32), lender redeems everything with interest.
        uint256 free = IMorphoMarketV1AdapterV2Min(nvdaD.adapter).realAssets();
        vm.prank(c.guardian);
        v.deallocate(nvdaD.adapter, abi.encode(nvdaD.market), free);
        vm.startPrank(lender);
        uint256 out = v.redeem(v.balanceOf(lender), lender, lender);
        nvdaD.wrapper.unwrap(out, lender);
        vm.stopPrank();
        assertGt(out, 100e18, "lender earned interest in stock");
        assertEq(IERC20(NVDA).balanceOf(lender), out);
        assertEq(nvdaD.wrapper.backingShortfall(), 0);
    }

    function _position(address who) internal view returns (uint256, uint128, uint128) {
        Position memory pos = IMorpho(MORPHO).position(nvdaD.market.id(), who);
        return (pos.supplyShares, pos.borrowShares, pos.collateral);
    }
}
