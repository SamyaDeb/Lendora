// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IMorpho, MarketParams, Market, Position} from "morpho-blue/src/interfaces/IMorpho.sol";
import {MarketParamsLib} from "morpho-blue/src/libraries/MarketParamsLib.sol";
import {IStocklineRouter} from "../../../src/interfaces/IStocklineRouter.sol";
import {IMarketHours} from "../../../src/interfaces/IMarketHours.sol";
import {IVaultV2Min} from "../../../src/interfaces/external/IMorphoVaultV2.sol";
import {StocklineLiquidator} from "../../../src/StocklineLiquidator.sol";
import {ForkConfig} from "../../../script/ForkConfig.sol";
import {MockChainlinkAggregator} from "../../mocks/MockChainlinkAggregator.sol";
import {IRobinhoodStock} from "../phase0/Phase0ForkBase.sol";
import {Phase1ForkBase} from "./Phase1ForkBase.sol";

interface IUniversalRouterL {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

/// @notice Phase 1 exit (task 12): the full lifecycle on a Robinhood Chain fork with the task-7 deployment. Live
/// Morpho Blue, Vault V2 factories, NVDA, USDG, issuer registry and Uniswap UniversalRouter; the only mocks are the two
/// Chainlink feeds, swapped into the oracle at deployment because chain time cannot produce real rounds.
/// Every scenario asserts what lenders end up with and whether Morpho realized bad debt.
/// forge-config: default.isolate = true
/// forge-config: ci.isolate = true
contract LifecycleForkTest is Phase1ForkBase, ForkConfig {
    using MarketParamsLib for MarketParams;

    // UTC timestamps (generated feed calendar, EDT).
    uint256 internal constant WED = 1_790_784_000; // Wed 2026-09-30 12:00 ET
    uint256 internal constant THU_PRINT = 1_790_886_000; // Thu 2026-10-01 16:20 ET
    uint256 internal constant FRI_RAMP = 1_790_971_200; // Fri 2026-10-02 16:00 ET
    uint256 internal constant FRI_CLOSE = 1_790_985_600; // Fri 20:00 ET freeze
    uint256 internal constant SAT = 1_791_043_200; // Sat 2026-10-03 12:00 ET
    uint256 internal constant SUN_OPEN = 1_791_158_400; // Sun 2026-10-04 20:00 ET
    uint256 internal constant MON = 1_791_208_800; // Mon 2026-10-05 10:00 ET

    address internal deployer = makeAddr("deployer");
    address internal lender = makeAddr("lender");
    address internal trader = makeAddr("trader");
    address internal liqBot = makeAddr("liquidatorBot");
    Vm.Wallet internal signer;
    CoreConfig internal c;
    Core internal core;
    StockDeployment internal d;
    MockChainlinkAggregator internal feed;
    MockChainlinkAggregator internal usdgFeed;
    int256 internal p0;

    function setUp() public override {
        super.setUp();
        // Start from the live NVDA answer, then drive the mock feeds.
        (, p0,,,) = MockChainlinkAggregator(FEED_NVDA).latestRoundData();
        vm.warp(WED);
        feed = new MockChainlinkAggregator(8, "RHNVDA / USD (mock rounds)");
        usdgFeed = new MockChainlinkAggregator(8, "USDG / USD (mock rounds)");
        feed.setAnswer(p0);
        usdgFeed.setAnswer(1e8);

        signer = vm.createWallet("attestationSigner");
        c = forkCoreConfig(deployer);
        c.attestationSigner = signer.addr;
        c.usdgFeed = address(usdgFeed);
        StockConfig[] memory s = new StockConfig[](1);
        s[0] = forkStocks()[1]; // NVDA
        s[0].feed = address(feed);
        deal(NVDA, deployer, 2 * SEED, true);
        vm.startPrank(deployer);
        core = _deployCore(c, s);
        d = _deployStock(c, core, s[0]);
        core = _finalize(c, core);
        vm.stopPrank();

        deal(NVDA, lender, 100e18, true);
        vm.startPrank(lender);
        IERC20(NVDA).approve(address(core.router), type(uint256).max);
        core.router.lend(NVDA, 100e18, 0, lender, block.timestamp);
        IERC20(d.vault).approve(address(core.router), type(uint256).max);
        vm.stopPrank();
        _allocate(90e18);

        _fundUsdg(trader, 50_000e6);
        vm.startPrank(trader);
        IERC20(USDG).approve(address(core.router), type(uint256).max);
        IERC20(NVDA).approve(address(core.router), type(uint256).max);
        IMorpho(MORPHO).setAuthorization(address(core.router), true);
        vm.stopPrank();
        _fundUsdg(liqBot, 1e6); // gas-free test account; profit is measured separately
    }

    // ------------------------------------------------------------------ helpers

    function _allocate(uint256 assets) internal {
        vm.prank(c.allocator);
        IVaultV2Min(d.vault).allocate(d.adapter, abi.encode(d.market), assets);
    }

    function _round(uint256 t, int256 answer) internal {
        vm.warp(t);
        feed.setAnswer(answer);
        usdgFeed.setAnswer(1e8);
    }

    /// @dev USDG/USD is 24/7; keep it fresh without touching the stock feed (frozen on weekends).
    function _warp(uint256 t) internal {
        vm.warp(t);
        usdgFeed.setAnswer(1e8);
    }

    function _attest(address user) internal view returns (IStocklineRouter.Attestation memory a) {
        a.expiry = block.timestamp + 1 days;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signer.privateKey, core.router.attestationDigest(user, a.expiry));
        a.signature = abi.encodePacked(r, s, v);
    }

    function _urInput(address tokenIn, address tokenOut, uint256 amountIn, address recipient)
        internal
        pure
        returns (bytes memory)
    {
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(
            recipient, amountIn, uint256(0), abi.encodePacked(tokenIn, uint24(500), tokenOut), false, new uint256[](0)
        );
        return abi.encodeCall(IUniversalRouterL.execute, (hex"00", inputs, type(uint64).max));
    }

    /// @dev Short `amount` NVDA with collateral = `collMult`/100 × the debt value at p0.
    function _openShort(uint256 amount, uint256 collMult) internal {
        uint256 value = uint256(p0) * amount / 1e20; // USDG 6 dp
        IStocklineRouter.Swap memory s = IStocklineRouter.Swap({
            target: c.swapTarget,
            data: _urInput(NVDA, USDG, amount, address(core.router)),
            amountIn: amount,
            minOut: value * 95 / 100
        });
        IStocklineRouter.Attestation memory att = _attest(trader);
        vm.prank(trader);
        core.router.openShort(NVDA, value * collMult / 100, amount, s, false, trader, att, block.timestamp);
    }

    function _hf(address who) internal view returns (uint256) {
        return core.router.healthFactorAt(NVDA, who, block.timestamp);
    }

    /// @dev What the fallback liquidator bot does: repay all shares, buy the stock on Uniswap with headroom.
    function _liquidateAll(address borrower) internal returns (uint256 profit) {
        Position memory pos = IMorpho(MORPHO).position(d.market.id(), borrower);
        Market memory mk = IMorpho(MORPHO).market(d.market.id());
        uint256 debt = uint256(pos.borrowShares) * (mk.totalBorrowAssets + 1) / (mk.totalBorrowShares + 1e6) + 1;
        uint256 dexRefPrice = uint256(p0); // the live pool trades near the pre-gap price
        uint256 usdgIn = debt * dexRefPrice * 105 / 100 / 1e20;
        address liq = address(core.liquidator);
        StocklineLiquidator.Liquidation memory l = StocklineLiquidator.Liquidation({
            market: d.market,
            borrower: borrower,
            seizedAssets: 0,
            repaidShares: pos.borrowShares,
            swap: StocklineLiquidator.Swap({
                target: c.swapTarget, data: _urInput(USDG, NVDA, usdgIn, liq), amountIn: usdgIn, minOut: debt
            }),
            minProfit: 0,
            recipient: liqBot,
            deadline: block.timestamp
        });
        uint256 before = IERC20(USDG).balanceOf(liqBot);
        vm.prank(liqBot);
        liq.call(abi.encodeCall(StocklineLiquidator.liquidate, (l)));
        profit = IERC20(USDG).balanceOf(liqBot) - before;
        assertEq(IERC20(address(core.clUSDG)).balanceOf(liq), 0, "liquidator keeps nothing");
        assertEq(IERC20(USDG).balanceOf(liq), 0);
    }

    function _supplyAssets() internal view returns (uint256) {
        return IMorpho(MORPHO).market(d.market.id()).totalSupplyAssets;
    }

    function _lenderExitsWhole() internal returns (uint256 out) {
        uint256 shares = IERC20(d.vault).balanceOf(lender);
        vm.prank(lender);
        out = core.router.withdrawLend(NVDA, shares, 100e18, lender, block.timestamp);
        assertGe(out, 100e18, "lender withdraws whole");
        assertEq(IERC20(NVDA).balanceOf(lender), out);
    }

    // ================================================================== Main lifecycle

    /// lend → open short → Friday ramp-in → weekend hold → Monday gap up → liquidation by the fallback
    /// liquidator →
    /// lender withdraws whole. No bad debt.
    function test_phase1_exit_lifecycle() public {
        _openShort(10e18, 155); // HF = 1.55 · 0.77 = 1.19 ≥ 1.10 at t + 24h (Wednesday: no buffer in the horizon)
        emit log_named_decimal_uint("HF after open (Wed)", _hf(trader), 18);
        uint256 supplyBefore = _supplyAssets();

        // Friday ramp-in: the price falls smoothly, the position stays healthy.
        _round(FRI_RAMP - 1 hours, p0);
        uint256 last = d.oracle.price();
        for (uint256 t = FRI_RAMP; t <= FRI_CLOSE; t += 20 minutes) {
            _warp(t);
            uint256 p = d.oracle.price();
            assertGe(p * 1e18, last * 0.9829e18, "per-step drop well inside 17.29%");
            last = p;
        }
        uint256 bFull = d.oracle.buffer();
        emit log_named_decimal_uint("weekend buffer (48h, sigma 52%)", bFull, 18);
        assertApproxEqAbs(bFull, 0.0962e18, 0.0005e18);
        emit log_named_decimal_uint("HF at the freeze", _hf(trader), 18);
        assertGt(_hf(trader), 1e18);

        // Weekend hold: nothing moves, the guard stays quiet, the router refuses new risk it can't price.
        _warp(SAT);
        assertEq(d.oracle.buffer(), bFull);
        assertFalse(d.oracle.guardTripped());

        // Sunday 20:00 ET first round: +25% gap. The buffer releases on it, so price() drops 1 − 1.0962/1.25.
        uint256 before = d.oracle.price();
        _round(SUN_OPEN + 30, p0 * 125 / 100);
        uint256 after_ = d.oracle.price();
        emit log_named_decimal_uint("price() step at the reopen", (before - after_) * 1e18 / before, 18);
        assertGe(after_ * 1e18, before * 0.82707e18, "inside Morpho's instant-drop bound (OR-R8)");
        assertEq(d.oracle.buffer(), 0);
        assertLt(_hf(trader), 1e18, "liquidatable");

        uint256 profit = _liquidateAll(trader);
        emit log_named_decimal_uint("fallback liquidator profit (USDG)", profit, 6);
        Position memory pos = IMorpho(MORPHO).position(d.market.id(), trader);
        assertEq(pos.borrowShares, 0, "debt cleared");
        assertGt(pos.collateral, 0, "borrower keeps the remaining collateral: solvent, no bad debt");
        assertGe(_supplyAssets(), supplyBefore, "no bad debt realized");

        _warp(MON);
        _lenderExitsWhole();
    }

    // ================================================================== NVDA earnings (D5)

    function test_phase1_exit_nvdaEarningsWithEventBuffer() public {
        IMarketHours.EventWindow[] memory e = new IMarketHours.EventWindow[](1);
        e[0] = IMarketHours.EventWindow(uint64(THU_PRINT - 1 hours), uint64(THU_PRINT), 0.1e18);
        vm.prank(address(core.timelock));
        core.marketHours.replaceEventsFrom(NVDA, 0, e);

        _openShort(10e18, 155);
        uint256 supplyBefore = _supplyAssets();
        _round(THU_PRINT - 5 hours, p0);
        IStocklineRouter.Attestation memory att = _attest(trader);
        vm.prank(trader);
        vm.expectRevert(); // RT-R1: the 10% event buffer within 24h makes a new near-limit position fail
        core.router.borrow(NVDA, 0, 1e18, trader, att, block.timestamp);

        _round(THU_PRINT - 1 minutes, p0);
        assertEq(d.oracle.buffer(), 0.1e18, "event buffer in force before the print");
        uint256 hfBefore = _hf(trader);
        uint256 before = d.oracle.price();
        _round(THU_PRINT, p0 * 126 / 100); // +26% in the first round after the print (NVDA 2023-05-25)
        uint256 step = (before - d.oracle.price()) * 1e18 / before;
        emit log_named_decimal_uint("HF before the print", hfBefore, 18);
        emit log_named_decimal_uint("price() step on +26%", step, 18);
        assertLt(step, 0.1729e18, "OR-R8");
        assertLt(_hf(trader), 1e18);
        _liquidateAll(trader);
        assertEq(IMorpho(MORPHO).position(d.market.id(), trader).borrowShares, 0);
        assertGe(_supplyAssets(), supplyBefore, "no bad debt");
        _lenderExitsWhole();
    }

    // ================================================================== Launch-week 1e18 feed incident (OR-R7)

    function test_phase1_exit_1e18FeedIncident() public {
        _openShort(10e18, 155);
        uint256 hf = _hf(trader);
        uint256 price = d.oracle.price();
        _round(block.timestamp + 10 minutes, p0 * 1e10); // answers scaled 1e18 at 8 decimals
        assertEq(d.oracle.price(), price, "price() does not move");
        assertApproxEqRel(_hf(trader), hf, 1e12, "nobody becomes liquidatable (only 10 min of interest)");
        assertTrue(d.oracle.guardReasons() & d.oracle.SANITY() != 0);
        IStocklineRouter.Attestation memory att = _attest(trader);
        vm.prank(trader);
        vm.expectRevert(); // GuardTripped
        core.router.borrow(NVDA, 1000e6, 1e18, trader, att, block.timestamp);
        // Exits keep working, and the lender is whole.
        vm.prank(trader);
        core.router.addCollateral(NVDA, 100e6, trader, block.timestamp);
        _round(block.timestamp + 10 minutes, p0); // correct rounds resume
        assertFalse(d.oracle.guardTripped());
        deal(NVDA, trader, 11e18, true);
        vm.prank(trader);
        core.router.repay(NVDA, 0, type(uint256).max, trader, block.timestamp);
        _lenderExitsWhole();
    }

    // ================================================================== Issuer pause (D4, LM-R5 as restated)

    /// Documents exits while NVDA is paused by the issuer: the guard trips; anything that moves the Stock Token
    /// reverts (router repay with NVDA, unwraps, the fallback liquidator's DEX buy); positions keep working in wrapper
    /// units (direct Morpho repay with wNVDA, collateral withdrawal); lenders can redeem wNVDA from the vault.
    function test_phase1_exit_issuerPause() public {
        _openShort(10e18, 155);
        uint256 supplyBefore = _supplyAssets();
        // A market maker holds wNVDA inventory wrapped before the pause.
        address mm = makeAddr("mm");
        deal(NVDA, mm, 20e18, true);
        vm.startPrank(mm);
        IERC20(NVDA).approve(address(d.wrapper), 20e18);
        d.wrapper.wrap(20e18, mm);
        vm.stopPrank();
        vm.prank(TOKEN_PAUSER);
        IRobinhoodStock(NVDA).pause();
        assertTrue(d.oracle.guardReasons() & d.oracle.TOKEN_PAUSED() != 0);

        vm.prank(trader);
        vm.expectRevert(); // IsPaused(): the router pulls NVDA
        core.router.repay(NVDA, 1e18, 0, trader, block.timestamp);

        // Repay in wrapper units directly on Morpho still works (a holder of wNVDA, e.g. a market maker).
        vm.startPrank(mm);
        IERC20(address(d.wrapper)).approve(MORPHO, type(uint256).max);
        Position memory pos = IMorpho(MORPHO).position(d.market.id(), trader);
        IMorpho(MORPHO).repay(d.market, 0, pos.borrowShares, trader, "");
        vm.stopPrank();
        vm.prank(trader);
        core.router.withdrawCollateral(NVDA, type(uint256).max, trader, block.timestamp); // USDG side unaffected

        // Lender: the router's withdrawLend must unwrap and reverts; redeeming wNVDA from the vault works.
        uint256 shares = IERC20(d.vault).balanceOf(lender);
        vm.prank(lender);
        vm.expectRevert();
        core.router.withdrawLend(NVDA, shares, 0, lender, block.timestamp);
        uint256 idleNeeded = IVaultV2Min(d.vault).previewRedeem(shares);
        uint256 short = idleNeeded - IERC20(address(d.wrapper)).balanceOf(d.vault);
        vm.prank(c.guardian); // sentinel pulls liquidity (LM-R32)
        IVaultV2Min(d.vault).deallocate(d.adapter, abi.encode(d.market), short);
        vm.prank(lender);
        uint256 wOut = IVaultV2Min(d.vault).redeem(shares, lender, lender);
        assertGe(wOut, 100e18, "lender holds wNVDA worth the full deposit");
        assertGe(_supplyAssets() + wOut, supplyBefore, "no bad debt");

        vm.prank(TOKEN_PAUSER);
        IRobinhoodStock(NVDA).unpause();
        vm.prank(lender);
        d.wrapper.unwrap(wOut, lender); // after unpause the Stock Token comes back
        assertEq(IERC20(NVDA).balanceOf(lender), wOut);
    }

    // ================================================================== adminBurn on the wrapper (LM-R7, LM-R8)

    function test_phase1_exit_adminBurnShowsShortfall() public {
        _openShort(10e18, 155);
        uint256 burned = 5e18;
        vm.prank(ADMIN_BURNER);
        (bool ok,) = NVDA.call(abi.encodeWithSignature("adminBurn(address,uint256)", address(d.wrapper), burned));
        assertTrue(ok);
        assertEq(d.wrapper.backingShortfall(), burned, "P0 alert condition (LM-R8)");

        // Morpho accounting is in wrapper units and unaffected: the borrower repays, no bad debt in Morpho.
        deal(NVDA, trader, 11e18, true);
        vm.prank(trader);
        core.router.repay(NVDA, 0, type(uint256).max, trader, block.timestamp);
        assertEq(IMorpho(MORPHO).position(d.market.id(), trader).borrowShares, 0);

        // The lender's claim is whole in wNVDA but short in NVDA by what was burned: the first 95 NVDA come out,
        // the rest cannot be unwrapped (LM-R7 restated: holds only absent adminBurn).
        uint256 shares = IERC20(d.vault).balanceOf(lender);
        uint256 claim = IVaultV2Min(d.vault).previewRedeem(shares);
        assertGe(claim, 100e18);
        uint256 backing = IERC20(NVDA).balanceOf(address(d.wrapper));
        emit log_named_decimal_uint("lender claim (wNVDA)", claim, 18);
        emit log_named_decimal_uint("wrapper backing left (NVDA)", backing, 18);
        assertLt(backing, claim, "unbacked: the last unwrappers cannot exit");
        vm.prank(lender);
        vm.expectRevert(); // ERC20InsufficientBalance on the wrapper's NVDA transfer
        core.router.withdrawLend(NVDA, shares, 0, lender, block.timestamp);
    }

    // ================================================================== 04 acceptance: stale feed drill

    /// Stale feed → guard trips (anyone pokes) → allocator pulls free liquidity → a new borrow fails for lack of
    /// liquidity even directly on Morpho → the liquidation of an unhealthy position still succeeds.
    function test_phase1_exit_staleFeedPullsLiquidityButLiquidationWorks() public {
        _openShort(10e18, 155);
        _round(block.timestamp + 1 hours, p0 * 125 / 100); // position becomes liquidatable
        uint256 supplyBefore = _supplyAssets();
        _warp(block.timestamp + 1 days + 11 minutes); // Thursday: open session, no round for > heartbeat + 10 min
        d.oracle.poke();
        assertEq(d.oracle.guardReasons(), d.oracle.STALE());

        // The allocator's LM-R31 pull: deallocate everything the market does not need.
        Market memory mk = IMorpho(MORPHO).market(d.market.id());
        uint256 free = mk.totalSupplyAssets - mk.totalBorrowAssets - SEED;
        vm.prank(c.allocator);
        IVaultV2Min(d.vault).deallocate(d.adapter, abi.encode(d.market), free);

        // A borrower with collateral already in Morpho cannot borrow: no liquidity left (the router refuses earlier).
        address other = makeAddr("other");
        _fundUsdg(other, 10_000e6);
        vm.startPrank(other);
        IERC20(USDG).approve(address(core.router), type(uint256).max);
        core.router.addCollateral(NVDA, 10_000e6, other, block.timestamp);
        vm.expectRevert(); // Morpho: insufficient liquidity
        IMorpho(MORPHO).borrow(d.market, 2e18, 0, other, other);
        vm.stopPrank();

        _liquidateAll(trader);
        assertEq(IMorpho(MORPHO).position(d.market.id(), trader).borrowShares, 0, "liquidation succeeds");
        assertGe(_supplyAssets() + free, supplyBefore, "no bad debt");
        _lenderExitsWhole();
    }
}
