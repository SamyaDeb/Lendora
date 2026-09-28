// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IMorpho, MarketParams} from "morpho-blue/src/interfaces/IMorpho.sol";
import {MarketParamsLib} from "morpho-blue/src/libraries/MarketParamsLib.sol";
import {IVaultV2Min} from "../../../src/interfaces/external/IMorphoVaultV2.sol";
import {ForkConfig} from "../../../script/ForkConfig.sol";
import {ReceiptMarketDeploy} from "../../../script/ReceiptMarketDeploy.sol";
import {Phase1ForkBase} from "../phase1/Phase1ForkBase.sol";

/// @notice A3 / G5 on a fork of Robinhood Chain (4663) at `latest`: the live Morpho Blue has LLTV 62.5% enabled, the
/// receipt market deploys against the live Vault V2 factories and USDG with every cap at 0, the curator lists it
/// through the vault's 48h timelock, USDG lenders deposit, and an `rNVDA` holder borrows USDG and exits.
/// forge-config: default.isolate = true
/// forge-config: ci.isolate = true
contract ReceiptMarketForkTest is Phase1ForkBase, ForkConfig, ReceiptMarketDeploy {
    using MarketParamsLib for MarketParams;

    address internal deployer = makeAddr("deployer");
    address internal lender = makeAddr("lender");
    address internal usdgLender = makeAddr("usdgLender");
    CoreConfig internal c;
    Core internal core;
    StockDeployment internal nvda;
    StockConfig internal nvdaCfg;
    ReceiptDeployment internal r;

    function setUp() public override {
        super.setUp();
        c = forkCoreConfig(deployer);
        nvdaCfg = forkStocks()[1];
        StockConfig[] memory one = new StockConfig[](1);
        one[0] = nvdaCfg;
        deal(nvdaCfg.token, deployer, 2 * SEED, true);
        deal(c.usdg, deployer, 2 * USDG_SEED, true);
        vm.startPrank(deployer);
        core = _deployCore(c, one);
        nvda = _deployStock(c, core, nvdaCfg);
        core = _finalize(c, core);
        r = _deployReceiptMarket(
            deployer,
            ReceiptConfig({
                ticker: "NVDA",
                stockToken: nvdaCfg.token,
                feed: nvdaCfg.feed,
                wrapper: address(nvda.wrapper),
                rVault: nvda.vault,
                sigmaWad: nvdaCfg.sigmaWad,
                morpho: c.morpho,
                irm: c.irm,
                usdg: c.usdg,
                usdgFeed: c.usdgFeed,
                vaultFactory: c.vaultFactory,
                adapterFactory: c.adapterFactory,
                marketHours: address(core.marketHours),
                timelock: address(core.timelock),
                owner: c.owner,
                curator: c.curator,
                guardian: c.guardian,
                allocator: c.allocator,
                guardKeeper: c.guardKeeper,
                feeSplitter: address(core.feeSplitter),
                sequencerFeed: c.sequencerFeed,
                issuerRegistry: c.issuerRegistry,
                timelockDelay: c.timelockDelay
            })
        );
        vm.stopPrank();
    }

    function test_G5_fork_liveMorphoListsAndLendsAgainstReceipt() public {
        assertTrue(IMorpho(c.morpho).isLltvEnabled(0.625e18), "62.5% enabled on live Morpho");
        assertEq(IMorpho(c.morpho).market(r.market.id()).lastUpdate, block.timestamp, "market created");
        assertEq(IVaultV2Min(r.usdgVault).curator(), c.curator);
        assertEq(IVaultV2Min(r.usdgVault).owner(), address(core.timelock));

        // Listing: six curator submits, 48h, anyone executes (A3: never a direct owner call).
        bytes[6] memory calls = _receiptListingCalls(r, nvda.vault, 250_000e6);
        for (uint256 i; i < 6; i++) {
            vm.prank(c.curator);
            IVaultV2Min(r.usdgVault).submit(calls[i]);
        }
        vm.warp(block.timestamp + c.timelockDelay);
        for (uint256 i; i < 6; i++) {
            (bool ok,) = r.usdgVault.call(calls[i]);
            assertTrue(ok);
        }

        deal(c.usdg, usdgLender, 100_000e6, true);
        vm.startPrank(usdgLender);
        IERC20(c.usdg).approve(r.usdgVault, 100_000e6);
        IVaultV2Min(r.usdgVault).deposit(100_000e6, usdgLender);
        vm.stopPrank();

        // An NVDA lender holds rNVDA and borrows USDG against it (G5).
        deal(nvdaCfg.token, lender, 10e18, true);
        vm.startPrank(lender);
        IERC20(nvdaCfg.token).approve(address(nvda.wrapper), 10e18);
        nvda.wrapper.wrap(10e18, lender);
        IERC20(address(nvda.wrapper)).approve(nvda.vault, 10e18);
        uint256 shares = IVaultV2Min(nvda.vault).deposit(10e18, lender);
        IERC20(nvda.vault).approve(c.morpho, shares);
        IMorpho(c.morpho).supplyCollateral(r.market, shares, lender, "");
        uint256 maxBorrow = shares * r.oracle.price() / 1e36 * r.market.lltv / 1e18;
        emit log_named_uint("max USDG against 10 rNVDA (6 dp)", maxBorrow);
        assertGt(maxBorrow, 0);
        IMorpho(c.morpho).borrow(r.market, maxBorrow / 2, 0, lender, lender);
        assertEq(IERC20(c.usdg).balanceOf(lender), maxBorrow / 2);

        // Exit: repay in full, take the receipt back.
        deal(c.usdg, lender, maxBorrow, true);
        IERC20(c.usdg).approve(c.morpho, type(uint256).max);
        IMorpho(c.morpho).repay(r.market, 0, IMorpho(c.morpho).position(r.market.id(), lender).borrowShares, lender, "");
        IMorpho(c.morpho).withdrawCollateral(r.market, shares, lender, lender);
        vm.stopPrank();
        assertEq(IERC20(nvda.vault).balanceOf(lender), shares);
    }
}
