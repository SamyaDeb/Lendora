// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {IMorpho, MarketParams, Position} from "morpho-blue/src/interfaces/IMorpho.sol";
import {MarketParamsLib} from "morpho-blue/src/libraries/MarketParamsLib.sol";
import {StocklineRouter} from "../../src/StocklineRouter.sol";
import {IStocklineRouter} from "../../src/interfaces/IStocklineRouter.sol";
import {IVaultV2Min} from "../../src/interfaces/external/IMorphoVaultV2.sol";
import {MockSwapAggregator} from "../mocks/MockSwapAggregator.sol";
import {LocalStockline} from "../utils/LocalStockline.sol";

/// Vault V2 keeps `firstTotalAssets` in transient storage (once per transaction); `isolate` runs every top-level call
/// as its own transaction, as on chain.
/// forge-config: default.isolate = true
contract StocklineRouterTest is LocalStockline {
    using MarketParamsLib for MarketParams;

    uint256 internal constant NVDA = 1; // index in the fixture
    address internal lender = makeAddr("lender");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal nvdaToken;
    IMorpho internal morpho;
    StocklineRouter internal router;

    function setUp() public override {
        super.setUp();
        nvdaToken = address(m.tokens[NVDA]);
        morpho = IMorpho(m.morpho);
        router = core.router;
        _onboard(lender, 1000e18, 0);
        _onboard(alice, 100e18, 1_000_000e6);
        _onboard(bob, 100e18, 1_000_000e6);
        _lendAndAllocate(NVDA, lender, 500e18);
    }

    function _pos(address who) internal view returns (Position memory) {
        return morpho.position(ds[NVDA].market.id(), who);
    }

    function _sellSwap(uint256 amountIn, uint256 minOut) internal view returns (IStocklineRouter.Swap memory) {
        return IStocklineRouter.Swap({
            target: address(m.dex),
            data: abi.encodeCall(MockSwapAggregator.swap, (nvdaToken, address(m.usdg), amountIn, 0, address(router))),
            amountIn: amountIn,
            minOut: minOut
        });
    }

    function _buySwap(uint256 usdgIn, uint256 minOut) internal view returns (IStocklineRouter.Swap memory) {
        return IStocklineRouter.Swap({
            target: address(m.dex),
            data: abi.encodeCall(MockSwapAggregator.swap, (address(m.usdg), nvdaToken, usdgIn, 0, address(router))),
            amountIn: usdgIn,
            minOut: minOut
        });
    }

    /// RT-R5: the router never keeps a balance of anything it touches.
    function _assertRouterEmpty() internal view {
        assertEq(IERC20(nvdaToken).balanceOf(address(router)), 0, "stock");
        assertEq(IERC20(address(ds[NVDA].wrapper)).balanceOf(address(router)), 0, "wrapper");
        assertEq(IERC20(address(m.usdg)).balanceOf(address(router)), 0, "usdg");
        assertEq(IERC20(address(core.clUSDG)).balanceOf(address(router)), 0, "clUSDG");
        assertEq(IERC20(ds[NVDA].vault).balanceOf(address(router)), 0, "rSTOCK");
    }

    // ================================================================== Lender flows (US-L1, US-L3, LM-R22)

    function test_RT_lendAndWithdrawLend() public {
        uint256 gas = gasleft();
        vm.prank(alice);
        uint256 shares = router.lend(nvdaToken, 10e18, 1, alice, block.timestamp);
        emit log_named_uint("gas lend", gas - gasleft());
        assertEq(IERC20(ds[NVDA].vault).balanceOf(alice), shares);
        _assertRouterEmpty();

        gas = gasleft();
        vm.prank(alice);
        uint256 out = router.withdrawLend(nvdaToken, shares, 1, alice, block.timestamp);
        emit log_named_uint("gas withdrawLend", gas - gasleft());
        assertApproxEqAbs(out, 10e18, 2);
        assertEq(IERC20(nvdaToken).balanceOf(alice), 100e18 - 10e18 + out);
        _assertRouterEmpty();
    }

    /// LM-R22: when idle is short, withdrawLend pulls free market liquidity with forceDeallocate (penalty 0).
    function test_LM_R22_withdrawLendForceDeallocatesWhenIdleShort() public {
        IVaultV2Min v = IVaultV2Min(ds[NVDA].vault);
        uint256 idle = IERC20(address(ds[NVDA].wrapper)).balanceOf(address(v));
        uint256 lenderShares = v.balanceOf(lender);
        uint256 lenderAssets = v.previewRedeem(lenderShares);
        assertGt(lenderAssets, idle, "most assets sit in the market");
        vm.prank(lender);
        uint256 out = router.withdrawLend(nvdaToken, lenderShares, lenderAssets, lender, block.timestamp);
        assertEq(out, lenderAssets);
        _assertRouterEmpty();
    }

    function test_RT_lendSlippageDeadlineAndListing() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IStocklineRouter.InsufficientOutput.selector, 1e18, 2e18));
        router.lend(nvdaToken, 1e18, 2e18, alice, block.timestamp);
        vm.prank(alice);
        vm.expectRevert(IStocklineRouter.Expired.selector);
        router.lend(nvdaToken, 1e18, 0, alice, block.timestamp - 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IStocklineRouter.NotListed.selector, address(0xbeef)));
        router.lend(address(0xbeef), 1e18, 0, alice, block.timestamp);
        vm.prank(alice);
        vm.expectRevert(IStocklineRouter.ZeroAmount.selector);
        router.lend(nvdaToken, 0, 0, alice, block.timestamp);
    }

    // ================================================================== borrow (US-B1, RT-R1, RT-R2)

    function test_RT_R1_R2_borrowHappyPath() public {
        IStocklineRouter.Attestation memory att = _attest(alice);
        uint256 gas = gasleft();
        vm.prank(alice);
        router.borrow(nvdaToken, 5000e6, 10e18, alice, att, block.timestamp);
        emit log_named_uint("gas borrow", gas - gasleft());
        assertEq(IERC20(nvdaToken).balanceOf(alice), 110e18, "Stock Token delivered");
        assertEq(_pos(alice).collateral, 5000e6);
        assertGt(_pos(alice).borrowShares, 0);
        _assertRouterEmpty();
    }

    function test_RT_R1_guardTrippedBlocksBorrow() public {
        vm.prank(guardian);
        ds[NVDA].oracle.trip(1); // MANUAL
        IStocklineRouter.Attestation memory att = _attest(alice);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IStocklineRouter.GuardTripped.selector, 1));
        router.borrow(nvdaToken, 5000e6, 10e18, alice, att, block.timestamp);
        // Exits still work while tripped (OR-R33): add collateral, and later repay/close.
        vm.prank(alice);
        router.addCollateral(nvdaToken, 1000e6, alice, block.timestamp);
    }

    function test_RT_R1_healthFactorAtTPlus24h() public {
        // $2,256.60 of debt against $2,700 of collateral: HF now = 2700·0.77/2256.6 = 0.921 < 1.10.
        IStocklineRouter.Attestation memory att = _attest(alice);
        vm.prank(alice);
        vm.expectRevert(); // HealthTooLow
        router.borrow(nvdaToken, 2700e6, 10e18, alice, att, block.timestamp);

        // HF 1.15 on a Wednesday passes...
        uint256 coll = 3370e6; // 3370·0.77/2256.6 = 1.150
        vm.prank(alice);
        router.borrow(nvdaToken, coll, 10e18, alice, att, block.timestamp);
        assertGe(router.healthFactorAt(nvdaToken, alice, block.timestamp + 1 days), 1.1e18);

        // ...but the same position opened Friday 16:00 ET fails: at t + 24h the 9.6% weekend buffer is in force.
        vm.warp(1_789_761_600);
        m.feeds[NVDA].setAnswer(225.66e8);
        m.usdgFeed.setAnswer(1e8);
        IStocklineRouter.Attestation memory attB = _attest(bob);
        vm.prank(bob);
        vm.expectRevert(); // HealthTooLow
        router.borrow(nvdaToken, coll, 10e18, bob, attB, block.timestamp);
    }

    function test_RT_R1_eventBufferCountsInTheHorizon() public {
        // NVDA earnings window starting in 10h with a 20% buffer (pushed by the timelock).
        vm.prank(address(core.timelock));
        IMarketHoursLike(address(core.marketHours))
            .replaceEventsFrom(
                nvdaToken, 0, _one(uint64(block.timestamp + 10 hours), uint64(block.timestamp + 11 hours), 0.2e18)
            );
        IStocklineRouter.Attestation memory att = _attest(alice);
        vm.prank(alice);
        vm.expectRevert(); // HF with the 20% event buffer < 1.10
        router.borrow(nvdaToken, 3370e6, 10e18, alice, att, block.timestamp);
    }

    function test_RT_R1_perAddressCapAndOverride() public {
        // NVDA cap $250k: 1,200 NVDA ≈ $270k of debt.
        m.usdg.mint(alice, 10_000_000e6);
        _lendAndAllocate(NVDA, lender, 400e18);
        m.tokens[NVDA].mint(lender, 2000e18);
        _lendAndAllocate(NVDA, lender, 1900e18);
        IStocklineRouter.Attestation memory att = _attest(alice);
        vm.prank(alice);
        vm.expectRevert(); // PerAddressCapExceeded
        router.borrow(nvdaToken, 1_000_000e6, 1200e18, alice, att, block.timestamp);
        vm.prank(address(core.timelock));
        router.setCapOverride(alice, nvdaToken, 500_000e18); // known market maker (D8 allowlist)
        vm.prank(alice);
        router.borrow(nvdaToken, 1_000_000e6, 1200e18, alice, att, block.timestamp);
        assertEq(router.capOf(alice, nvdaToken), 500_000e18);
    }

    function test_RT_R1_globalClUsdgCap() public {
        vm.prank(address(core.timelock));
        router.setGlobalCap(4000e6);
        IStocklineRouter.Attestation memory att = _attest(alice);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IStocklineRouter.GlobalCapExceeded.selector, 5000e6, 4000e6));
        router.borrow(nvdaToken, 5000e6, 1e18, alice, att, block.timestamp);
    }

    function test_RT_R2_attestationBoundToUserChainAndExpiry() public {
        IStocklineRouter.Attestation memory forBob = _attest(bob);
        vm.prank(alice);
        vm.expectRevert(IStocklineRouter.BadAttestation.selector);
        router.borrow(nvdaToken, 5000e6, 1e18, alice, forBob, block.timestamp);

        IStocklineRouter.Attestation memory att = _attest(alice);
        vm.warp(att.expiry + 1);
        m.feeds[NVDA].setAnswer(225.66e8);
        m.usdgFeed.setAnswer(1e8);
        vm.prank(alice);
        vm.expectRevert(IStocklineRouter.BadAttestation.selector);
        router.borrow(nvdaToken, 5000e6, 1e18, alice, att, block.timestamp);

        att = _attest(alice);
        att.signature = hex"1234";
        vm.prank(alice);
        vm.expectRevert(IStocklineRouter.BadAttestation.selector);
        router.borrow(nvdaToken, 5000e6, 1e18, alice, att, block.timestamp);

        // Another chain id changes the EIP-712 domain, so the same signature no longer recovers the signer.
        att = _attest(alice);
        vm.chainId(4663);
        vm.prank(alice);
        vm.expectRevert(IStocklineRouter.BadAttestation.selector);
        router.borrow(nvdaToken, 5000e6, 1e18, alice, att, block.timestamp);
        vm.chainId(31_337);

        vm.prank(address(core.timelock));
        router.setAttestationSigner(address(0));
        vm.prank(alice);
        vm.expectRevert(IStocklineRouter.BadAttestation.selector);
        router.borrow(nvdaToken, 5000e6, 1e18, alice, att, block.timestamp);
    }

    // ================================================================== openShort / closeShort (US-B2, US-B4, RT-R3)

    function test_RT_R3_openShortToReceiverThenCloseShort() public {
        IStocklineRouter.Attestation memory att = _attest(alice);
        uint256 usdgBefore = IERC20(address(m.usdg)).balanceOf(alice);
        uint256 gas = gasleft();
        vm.prank(alice);
        uint256 out =
            router.openShort(nvdaToken, 5000e6, 10e18, _sellSwap(10e18, 2250e6), false, alice, att, block.timestamp);
        emit log_named_uint("gas openShort", gas - gasleft());
        assertEq(out, 2256.6e6);
        assertEq(IERC20(address(m.usdg)).balanceOf(alice), usdgBefore - 5000e6 + out);
        _assertRouterEmpty();

        vm.warp(block.timestamp + 3 days);
        m.feeds[NVDA].setAnswer(225.66e8);
        m.usdgFeed.setAnswer(1e8);
        // Buy back a little more than the debt; the excess stock is refunded.
        gas = gasleft();
        vm.prank(alice);
        uint256 collOut = router.closeShort(nvdaToken, 2300e6, _buySwap(2300e6, 10e18), alice, block.timestamp);
        emit log_named_uint("gas closeShort", gas - gasleft());
        assertEq(collOut, 5000e6);
        assertEq(_pos(alice).borrowShares, 0, "RT-R4: repaid by shares, no dust debt");
        assertEq(_pos(alice).collateral, 0);
        assertGt(IERC20(nvdaToken).balanceOf(alice), 100e18, "leftover stock refunded");
        _assertRouterEmpty();
    }

    function test_RT_R3_openShortCompoundsProceedsIntoCollateral() public {
        IStocklineRouter.Attestation memory att = _attest(alice);
        vm.prank(alice);
        uint256 out = router.openShort(nvdaToken, 3000e6, 10e18, _sellSwap(10e18, 0), true, alice, att, block.timestamp);
        assertEq(_pos(alice).collateral, 3000e6 + out);
        _assertRouterEmpty();
    }

    function test_RT_R3_partialFillRefundsStockAndSlippageReverts() public {
        m.dex.setFillFraction(0.5e18);
        IStocklineRouter.Attestation memory att = _attest(alice);
        vm.prank(alice);
        uint256 out =
            router.openShort(nvdaToken, 5000e6, 10e18, _sellSwap(10e18, 1000e6), false, bob, att, block.timestamp);
        assertEq(out, 1128.3e6);
        assertEq(IERC20(nvdaToken).balanceOf(bob), 105e18, "unsold half refunded to the receiver");
        _assertRouterEmpty();

        m.dex.setFillFraction(1e18);
        m.dex.setFeeBps(300);
        vm.prank(alice);
        vm.expectRevert(); // InsufficientOutput from the balance delta check
        router.openShort(nvdaToken, 5000e6, 10e18, _sellSwap(10e18, 2250e6), false, alice, att, block.timestamp);
    }

    /// RT-R3: the mock returns a false, inflated amountOut; the router measures balances and ignores it.
    function test_RT_R3_neverTrustsSwapReturnData() public {
        m.dex.setReportedAmountOut(1_000_000e6);
        IStocklineRouter.Attestation memory att = _attest(alice);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IStocklineRouter.InsufficientOutput.selector, 2256.6e6, 3000e6));
        router.openShort(nvdaToken, 5000e6, 10e18, _sellSwap(10e18, 3000e6), false, alice, att, block.timestamp);
    }

    function test_RT_R3_onlyAllowlistedTargets() public {
        IStocklineRouter.Attestation memory att = _attest(alice);
        IStocklineRouter.Swap memory s = _sellSwap(10e18, 0);
        s.target = address(new MockSwapAggregator());
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IStocklineRouter.SwapTargetNotAllowed.selector, s.target));
        router.openShort(nvdaToken, 5000e6, 10e18, s, false, alice, att, block.timestamp);
        vm.startPrank(address(core.timelock));
        vm.expectRevert(IStocklineRouter.ZeroAddress.selector);
        router.setSwapTarget(m.morpho, IStocklineRouter.SwapMode.Approve); // never Morpho or clUSDG
        router.setSwapTarget(address(m.dex), IStocklineRouter.SwapMode.None);
        vm.stopPrank();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IStocklineRouter.SwapTargetNotAllowed.selector, address(m.dex)));
        router.openShort(nvdaToken, 5000e6, 10e18, _sellSwap(10e18, 0), false, alice, att, block.timestamp);
    }

    function test_RT_closeShortFailsIfSwapBuysTooLittle() public {
        IStocklineRouter.Attestation memory att = _attest(alice);
        vm.prank(alice);
        router.openShort(nvdaToken, 5000e6, 10e18, _sellSwap(10e18, 0), false, alice, att, block.timestamp);
        vm.prank(alice);
        vm.expectRevert(); // not enough wNVDA to repay the shares
        router.closeShort(nvdaToken, 1000e6, _buySwap(1000e6, 0), alice, block.timestamp);
        vm.prank(alice);
        vm.expectRevert(); // amountIn above what was pulled
        router.closeShort(nvdaToken, 1000e6, _buySwap(2000e6, 0), alice, block.timestamp);
    }

    // ================================================================== Single-step helpers (US-B5, RT-R4)

    function test_RT_R4_repayBySharesAssetsAndWithdrawCollateral() public {
        IStocklineRouter.Attestation memory att = _attest(alice);
        vm.prank(alice);
        router.borrow(nvdaToken, 5000e6, 10e18, alice, att, block.timestamp);
        vm.warp(block.timestamp + 10 days);
        m.feeds[NVDA].setAnswer(225.66e8);
        m.usdgFeed.setAnswer(1e8);

        // bob repays 1 NVDA of alice's debt by assets (anyone may repay for anyone).
        vm.prank(bob);
        uint256 repaid = router.repay(nvdaToken, 1e18, 0, alice, block.timestamp);
        assertEq(repaid, 1e18);

        uint256 gas = gasleft();
        vm.prank(alice);
        router.repay(nvdaToken, 0, type(uint256).max, alice, block.timestamp);
        emit log_named_uint("gas repay (all shares)", gas - gasleft());
        assertEq(_pos(alice).borrowShares, 0, "no dust debt");

        gas = gasleft();
        vm.prank(alice);
        router.withdrawCollateral(nvdaToken, type(uint256).max, alice, block.timestamp);
        emit log_named_uint("gas withdrawCollateral", gas - gasleft());
        assertEq(_pos(alice).collateral, 0);
        _assertRouterEmpty();

        vm.prank(alice);
        vm.expectRevert(IStocklineRouter.ZeroAmount.selector);
        router.repay(nvdaToken, 1, 1, alice, block.timestamp);
        vm.prank(alice);
        vm.expectRevert(IStocklineRouter.ZeroAmount.selector);
        router.withdrawCollateral(nvdaToken, type(uint256).max, alice, block.timestamp);
    }

    function test_RT_addCollateralForAnother() public {
        uint256 gas = gasleft();
        vm.prank(bob);
        router.addCollateral(nvdaToken, 1000e6, alice, block.timestamp);
        emit log_named_uint("gas addCollateral", gas - gasleft());
        assertEq(_pos(alice).collateral, 1000e6);
        vm.prank(bob);
        vm.expectRevert(IStocklineRouter.ZeroAmount.selector);
        router.addCollateral(nvdaToken, 0, alice, block.timestamp);
    }

    /// Exits keep working after a market is delisted; entries do not.
    function test_RT_delistedMarketAllowsExitsOnly() public {
        IStocklineRouter.Attestation memory att = _attest(alice);
        vm.prank(alice);
        router.borrow(nvdaToken, 5000e6, 10e18, alice, att, block.timestamp);
        vm.prank(address(core.timelock));
        router.delistMarket(nvdaToken);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IStocklineRouter.NotListed.selector, nvdaToken));
        router.borrow(nvdaToken, 5000e6, 1e18, alice, att, block.timestamp);
        vm.prank(alice);
        router.repay(nvdaToken, 0, type(uint256).max, alice, block.timestamp);
        vm.prank(alice);
        router.withdrawCollateral(nvdaToken, type(uint256).max, alice, block.timestamp);
    }

    // ================================================================== Multicall with permits (RT-R6 UX)

    function test_RT_multicallPermitAndBorrow() public {
        Vm.Wallet memory w = vm.createWallet("carol");
        m.usdg.mint(w.addr, 10_000e6);
        vm.prank(w.addr);
        morpho.setAuthorization(address(router), true);
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                m.usdg.DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                        w.addr,
                        address(router),
                        5000e6,
                        0,
                        block.timestamp
                    )
                )
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(w.privateKey, digest);
        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeCall(StocklineRouter.selfPermit, (address(m.usdg), 5000e6, block.timestamp, v, r, s));
        calls[1] =
            abi.encodeCall(StocklineRouter.borrow, (nvdaToken, 5000e6, 5e18, w.addr, _attest(w.addr), block.timestamp));
        vm.prank(w.addr);
        router.multicall(calls);
        assertEq(IERC20(nvdaToken).balanceOf(w.addr), 5e18);
        _assertRouterEmpty();
    }

    // ================================================================== Liquidation of a router-opened position

    /// 05 acceptance: a standard Morpho liquidator that knows nothing about Stockline beyond `clUSDG.unwrap`.
    function test_RT_routerPositionLiquidatableByStandardLiquidator() public {
        IStocklineRouter.Attestation memory att = _attest(alice);
        vm.prank(alice);
        router.openShort(nvdaToken, 3500e6, 10e18, _sellSwap(10e18, 0), false, alice, att, block.timestamp);
        m.feeds[NVDA].setAnswer(320e8); // +42%: 3500·0.77/3200 = 0.84 < 1
        address liq = makeAddr("liquidator");
        m.tokens[NVDA].mint(liq, 20e18);
        vm.startPrank(liq);
        m.tokens[NVDA].approve(address(ds[NVDA].wrapper), 20e18);
        ds[NVDA].wrapper.wrap(20e18, liq);
        IERC20(address(ds[NVDA].wrapper)).approve(m.morpho, type(uint256).max);
        (uint256 seized,) = morpho.liquidate(ds[NVDA].market, alice, 0, _pos(alice).borrowShares / 2, "");
        core.clUSDG.unwrap(seized, liq);
        vm.stopPrank();
        assertEq(IERC20(address(m.usdg)).balanceOf(liq), seized);
    }

    // ================================================================== Upgrades and admin (RT-R7)

    function test_RT_R7_upgradeOnlyByTimelockAndInitializeOnce() public {
        StocklineRouter impl2 = new StocklineRouter(m.morpho, address(core.clUSDG));
        vm.prank(alice);
        vm.expectRevert(IStocklineRouter.NotOwner.selector);
        router.upgradeToAndCall(address(impl2), "");
        vm.prank(address(core.timelock));
        router.upgradeToAndCall(address(impl2), "");
        assertEq(router.owner(), address(core.timelock), "storage survives the upgrade");
        assertTrue(router.market(nvdaToken).listed);

        vm.expectRevert(Initializable.InvalidInitialization.selector);
        router.initialize(alice, alice, 1);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        impl2.initialize(alice, alice, 1); // implementation is locked
    }

    function test_RT_adminFunctionsOnlyOwner() public {
        vm.startPrank(alice);
        vm.expectRevert(IStocklineRouter.NotOwner.selector);
        router.setGlobalCap(1);
        vm.expectRevert(IStocklineRouter.NotOwner.selector);
        router.setCapOverride(alice, nvdaToken, 1);
        vm.expectRevert(IStocklineRouter.NotOwner.selector);
        router.setAttestationSigner(alice);
        vm.expectRevert(IStocklineRouter.NotOwner.selector);
        router.transferOwnership(alice);
        vm.expectRevert(IStocklineRouter.NotOwner.selector);
        router.delistMarket(nvdaToken);
        vm.stopPrank();
        vm.startPrank(address(core.timelock));
        vm.expectRevert(IStocklineRouter.ZeroAddress.selector);
        router.transferOwnership(address(0));
        router.transferOwnership(alice);
        vm.stopPrank();
        assertEq(router.owner(), alice);
        assertEq(router.attestationSigner(), signer.addr);
        assertEq(router.globalCap(), 4_000_000e6);
    }

    function test_RT_listMarketValidatesWiring() public {
        IStocklineRouter.Market memory mk = router.market(nvdaToken);
        vm.startPrank(address(core.timelock));
        mk.vault = ds[0].vault; // SPY vault with the NVDA wrapper
        vm.expectRevert(IStocklineRouter.BadMarket.selector);
        router.listMarket(nvdaToken, mk);
        mk = router.market(nvdaToken);
        vm.expectRevert(IStocklineRouter.BadMarket.selector);
        router.listMarket(address(m.tokens[0]), mk); // wrapper of another stock
        router.listMarket(nvdaToken, mk); // re-list is fine
        vm.stopPrank();
    }

    function test_constructorRejectsZero() public {
        vm.expectRevert(IStocklineRouter.ZeroAddress.selector);
        new StocklineRouter(address(0), address(core.clUSDG));
    }

    // ------------------------------------------------------------------ helpers

    function _one(uint64 a, uint64 b, uint64 buf) internal pure returns (EW[] memory e) {
        e = new EW[](1);
        e[0] = EW(a, b, buf);
    }
}

struct EW {
    uint64 startTs;
    uint64 endTs;
    uint64 bufferWad;
}

interface IMarketHoursLike {
    function replaceEventsFrom(address stock, uint256 fromIndex, EW[] calldata newEvents) external;
}
