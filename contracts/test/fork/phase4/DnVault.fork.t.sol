// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {MarketParamsLib} from "morpho-blue/src/libraries/MarketParamsLib.sol";
import {IMorpho, MarketParams} from "morpho-blue/src/interfaces/IMorpho.sol";
import {IVaultV2Min} from "../../../src/interfaces/external/IMorphoVaultV2.sol";
import {IMarketHours} from "../../../src/interfaces/IMarketHours.sol";
import {ILendoraRouter} from "../../../src/interfaces/ILendoraRouter.sol";
import {IDeltaNeutralVault} from "../../../src/interfaces/IDeltaNeutralVault.sol";
import {INavOracle} from "../../../src/interfaces/INavOracle.sol";
import {IStrategyManager} from "../../../src/interfaces/IStrategyManager.sol";
import {DeltaNeutralVault} from "../../../src/vault/DeltaNeutralVault.sol";
import {StrategyManager} from "../../../src/vault/StrategyManager.sol";
import {NavOracle} from "../../../src/vault/NavOracle.sol";
import {MockPerpVenue} from "../../mocks/MockPerpVenue.sol";
import {MockPayFirstSwap} from "../../mocks/MockPayFirstSwap.sol";
import {ForkConfig} from "../../../script/ForkConfig.sol";
import {Phase1ForkBase} from "../phase1/Phase1ForkBase.sol";

interface IUniversalRouterDn {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

interface AggregatorLikeDn {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

/// @notice Phase 4 task 17 (08 acceptance) on a fork of Robinhood Chain (4663) at `latest`: the delta-neutral vault on
/// the live Morpho Blue, the Lendora `rNVDA` Vault V2 built from the live factory, NVDA, USDG, the Chainlink feed and
/// the live UniversalRouter for spot trades, with the mock venue for the perp leg (no live venue adapter exists, A39).
/// Lifecycle: deposit → build → rebalance (price move, DN-R14 hedged NAV) → instant withdraw → queued withdraw
/// settled
/// after a weekend (DN-R12) → funding kill switch unwinds the sleeve → margin top-up; then the four sim stresses
/// (+20% Monday gap, −100% APR funding week, 72h venue withdrawal halt, rSTOCK 100% utilization for 48h).
/// The vault pieces are constructed directly: the deploy script refuses the mock venue on chain id 4663 (MN-R7).
/// forge-config: default.isolate = true
/// forge-config: ci.isolate = true
contract DnVaultForkTest is Phase1ForkBase, ForkConfig {
    using MarketParamsLib for MarketParams;
    uint24 internal constant FEE = 500;
    bytes32 internal constant MKT = keccak256("NVDA");
    address internal deployer = makeAddr("deployer");
    address internal operator = makeAddr("dn.operator");
    address internal dnGuardian = makeAddr("dn.guardian");
    address internal alice = makeAddr("alice");
    address internal borrower = makeAddr("borrower");
    CoreConfig internal c;
    Core internal core;
    StockDeployment internal nvda;
    StockConfig internal nvdaCfg;
    Vm.Wallet internal attester;
    Vm.Wallet internal s1;
    Vm.Wallet internal s2;
    DeltaNeutralVault internal vault;
    StrategyManager internal strat;
    NavOracle internal nav;
    MockPerpVenue internal venue;
    MockPayFirstSwap internal dex; // a second allowlisted target at the feed price, for trades after a shocked price
    int256 internal price; // current NVDA feed answer (8 dp), mocked fresh

    function setUp() public override {
        super.setUp();
        c = forkCoreConfig(deployer);
        nvdaCfg = forkStocks()[1];
        StockConfig[] memory one = new StockConfig[](1);
        one[0] = nvdaCfg;
        deal(nvdaCfg.token, deployer, 2 * SEED, true);
        vm.startPrank(deployer);
        core = _deployCore(c, one);
        nvda = _deployStock(c, core, nvdaCfg);
        core = _finalize(c, core);
        vm.stopPrank();
        attester = vm.createWallet("attester");
        vm.prank(address(core.timelock));
        core.router.setAttestationSigner(attester.addr);
        Vm.Wallet memory a = vm.createWallet("nav1");
        Vm.Wallet memory b = vm.createWallet("nav2");
        (s1, s2) = a.addr < b.addr ? (a, b) : (b, a);

        _openSession();
        (, price,,,) = AggregatorLikeDn(nvdaCfg.feed).latestRoundData();
        _fresh();

        vault = new DeltaNeutralVault(
            IERC20(USDG),
            address(this),
            address(core.router),
            address(core.marketHours),
            dnGuardian,
            address(core.feeSplitter),
            500
        );
        strat = new StrategyManager(address(this), address(vault), operator, dnGuardian, 100);
        venue = new MockPerpVenue(USDG, address(strat));
        venue.listMarket(MKT, nvdaCfg.feed, 0.03e18, 0.05e18);
        nav = new NavOracle(address(this), address(vault), address(strat), 15 minutes, 15 minutes);
        nav.setSigner(s1.addr, true);
        nav.setSigner(s2.addr, true);
        vault.setStrategy(address(strat));
        vault.setNavOracle(address(nav));
        vault.setTotalCap(2_000_000e6);
        strat.setAdapter(address(venue));
        strat.addSleeve(
            IStrategyManager.Sleeve({
                stockToken: nvdaCfg.token,
                wrapper: address(nvda.wrapper),
                rVault: nvda.vault,
                oracle: address(nvda.oracle),
                perpMarket: MKT,
                capUsdg: 1_000_000e6,
                maxLendBps: 9000,
                active: true
            })
        );
        strat.setSwapTarget(c.swapTarget, IStrategyManager.SwapMode.Transfer); // UniversalRouter (Q4)
        dex = new MockPayFirstSwap();
        strat.setSwapTarget(address(dex), IStrategyManager.SwapMode.Transfer);
        deal(USDG, address(venue), 10_000_000e6, true); // venue liquidity for PnL
        deal(USDG, address(dex), 10_000_000e6, true);
        deal(nvdaCfg.token, address(dex), 100_000e18, true);
        _setDexRates();
        _report();
    }

    // ------------------------------------------------------------------ helpers

    function _openSession() internal {
        uint256 t = vm.getBlockTimestamp();
        if (!core.marketHours.isOpen(t)) {
            (IMarketHours.Session memory s, bool found) = core.marketHours.currentOrNextSession(t);
            require(found, "calendar ends");
            vm.warp(s.openTs + 14 hours); // 10:00 ET
        }
    }

    /// @dev The NVDA and USDG feeds answer `price` / 1.0 with `updatedAt = now` (guard clear, NAV marks fresh).
    function _fresh() internal {
        uint256 t = vm.getBlockTimestamp();
        vm.mockCall(
            nvdaCfg.feed,
            abi.encodeCall(AggregatorLikeDn.latestRoundData, ()),
            abi.encode(uint80(1), price, t, t, uint80(1))
        );
        (uint80 id, int256 u,,, uint80 ai) = AggregatorLikeDn(c.usdgFeed).latestRoundData();
        vm.mockCall(c.usdgFeed, abi.encodeCall(AggregatorLikeDn.latestRoundData, ()), abi.encode(id, u, t, t, ai));
    }

    function _setDexRates() internal {
        uint256 p = uint256(price);
        dex.setRate(nvdaCfg.token, USDG, p * 1e6 / 1e8);
        dex.setRate(USDG, nvdaCfg.token, uint256(1e8) * 1e36 / (p * 1e6));
    }

    function _move(int256 bps) internal {
        price = price * (10_000 + bps) / 10_000;
        _fresh();
        _setDexRates();
    }

    function _report() internal {
        uint64 last = nav.lastReport().timestamp;
        if (vm.getBlockTimestamp() <= last) vm.warp(last + 1);
        _fresh();
        (, uint256 eq) = venue.onchainEquity();
        uint256[] memory sizes = new uint256[](1);
        (, sizes[0]) = venue.shortSize(MKT);
        INavOracle.Report memory r = INavOracle.Report(
            eq,
            venue.totalDeposited(),
            venue.totalRequested(),
            strat.tradeNonce(),
            uint64(vm.getBlockTimestamp()),
            sizes
        );
        bytes[] memory sigs = new bytes[](2);
        (uint8 v1, bytes32 r1, bytes32 x1) = vm.sign(s1.privateKey, nav.reportDigest(r));
        (uint8 v2, bytes32 r2, bytes32 x2) = vm.sign(s2.privateKey, nav.reportDigest(r));
        sigs[0] = abi.encodePacked(r1, x1, v1);
        sigs[1] = abi.encodePacked(r2, x2, v2);
        nav.submit(r, sigs);
    }

    function _deposit(address who, uint256 amount) internal {
        deal(USDG, who, amount, true);
        IDeltaNeutralVault.Attestation memory att;
        att.expiry = vm.getBlockTimestamp() + 1 days;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attester.privateKey, core.router.attestationDigest(who, att.expiry));
        att.signature = abi.encodePacked(r, s, v);
        vm.startPrank(who);
        IERC20(USDG).approve(address(vault), amount);
        vault.deposit(amount, who, att);
        vm.stopPrank();
    }

    /// @dev UniversalRouter V3_SWAP_EXACT_IN (A15), paid first (Transfer mode), proceeds to the strategy.
    function _ur(address tokenIn, address tokenOut, uint256 amountIn)
        internal
        view
        returns (IStrategyManager.Swap memory)
    {
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(
            address(strat), amountIn, uint256(0), abi.encodePacked(tokenIn, FEE, tokenOut), false, new uint256[](0)
        );
        return IStrategyManager.Swap(
            c.swapTarget, abi.encodeCall(IUniversalRouterDn.execute, (hex"00", inputs, vm.getBlockTimestamp() + 600))
        );
    }

    function _mock(address tokenIn, address tokenOut, uint256 amountIn)
        internal
        view
        returns (IStrategyManager.Swap memory)
    {
        return IStrategyManager.Swap(
            address(dex), abi.encodeCall(MockPayFirstSwap.swap, (tokenIn, tokenOut, amountIn, address(strat)))
        );
    }

    /// @dev 08 structure with `d` USDG: 3/4 spot bought on the live pool (90% lent), 1/4 margin, short = spot.
    function _build(uint256 d) internal {
        uint256 s = d * 3 / 4;
        uint256 fair = s * 1e18 / strat.quote(0, 1e18);
        IStrategyManager.Swap memory sw = _ur(USDG, nvdaCfg.token, s);
        vm.startPrank(operator);
        strat.pullFromVault(d);
        uint256 got = strat.buySpot(0, s, fair * 99 / 100 + 1, sw);
        strat.lend(0, got * 9 / 10);
        strat.depositMargin(d - s);
        strat.adjustShort(0, -int256(got), 0);
        vm.stopPrank();
        _report();
    }

    /// @dev Reduce the sleeve by `frac` bps (unlend what is needed, sell, buy the short back, reclaim margin) and
    /// return all cash to the vault. `live` = sell on the live pool, else on the feed-priced mock target.
    function _unwind(uint256 fracBps, bool live) internal {
        uint256 units = strat.spotUnits(0) * fracBps / 10_000;
        vm.startPrank(operator);
        uint256 wrapped = IERC20(address(nvda.wrapper)).balanceOf(address(strat));
        if (wrapped < units) {
            uint256 sh = IERC4626(nvda.vault).convertToShares(units - wrapped) + 1;
            uint256 bal = IERC20(nvda.vault).balanceOf(address(strat));
            strat.unlend(0, sh > bal ? bal : sh);
        }
        wrapped = IERC20(address(nvda.wrapper)).balanceOf(address(strat));
        uint256 sell = wrapped < units ? wrapped : units;
        uint256 fair = strat.quote(0, sell);
        strat.sellSpot(
            0, sell, fair * 99 / 100 + 1, live ? _ur(nvdaCfg.token, USDG, sell) : _mock(nvdaCfg.token, USDG, sell)
        );
        (, uint256 size) = venue.shortSize(MKT);
        strat.adjustShort(0, int256(sell > size ? size : sell), 0);
        uint256 im = venue.initialMargin();
        int256 eq = venue.equityRaw();
        if (eq > int256(im * 2)) strat.requestMarginWithdraw(uint256(eq) - im * 2);
        strat.claimMargin();
        uint256 cash = IERC20(USDG).balanceOf(address(strat));
        if (cash > 0) strat.returnToVault(cash);
        vm.stopPrank();
        _report();
    }

    function _built() internal {
        _deposit(alice, 200_000e6);
        _build(180_000e6);
    }

    // ------------------------------------------------------------------ lifecycle

    function test_DN_fork_lifecycle_depositBuildRebalanceWithdrawQueueWeekendKillTopUp() public {
        // Deposit and build (08 structure).
        _deposit(alice, 200_000e6);
        uint256 nav0 = vault.totalAssets();
        _build(180_000e6);
        emit log_named_uint("NAV after build (USDG raw)", vault.totalAssets());
        assertApproxEqRel(vault.totalAssets(), nav0, 0.01e18, "entry costs < 1% on the live pool");
        (, uint256 size) = venue.shortSize(MKT);
        assertEq(size, strat.spotUnits(0), "DN-R2: short = spot");

        // Rebalance after a +3% move: the NAV stays hedged between reports (DN-R14), the short is aligned.
        uint256 navB = vault.totalAssets();
        int256 real = price;
        _move(300);
        assertApproxEqRel(vault.totalAssets(), navB, 0.002e18, "hedged");
        _report();
        // Back to the live pool's price: trading there against a mocked feed would (rightly) hit the 1% floor.
        price = real;
        _fresh();
        _setDexRates();
        _report();

        // Instant withdrawal inside the buffer (DN-R1).
        uint256 u0 = IERC20(USDG).balanceOf(alice);
        vm.prank(alice);
        vault.withdraw(5000e6, alice, alice);
        assertEq(IERC20(USDG).balanceOf(alice) - u0, 5000e6);

        // Queued withdrawal: requested, the weekend passes (no settlement while closed, DN-R12), settled Monday.
        vm.prank(alice);
        uint256 id = vault.requestRedeem(80_000e18, alice, alice);
        vm.warp(_nextClose() + 1 hours); // inside the weekend closure
        uint256 reopen = _reopenAfter(vm.getBlockTimestamp());
        _report(); // a fresh report: the refusal below is the closed session itself
        assertFalse(vault.marketOpen());
        vm.expectRevert(IDeltaNeutralVault.MarketClosed.selector);
        vault.settle(1);
        vm.warp(reopen + 14 hours);
        _report();
        _unwind(5000, true); // raise cash on the live pool
        vault.settle(5);
        assertEq(uint8(vault.request(id).status), uint8(IDeltaNeutralVault.RequestStatus.Claimable));
        uint256 u1 = IERC20(USDG).balanceOf(alice);
        vault.claim(id);
        emit log_named_uint("queued claim (USDG raw)", IERC20(USDG).balanceOf(alice) - u1);
        assertGt(IERC20(USDG).balanceOf(alice) - u1, 75_000e6);

        // Funding kill switch (DN-R7): negative funding, the guardian kills the sleeve, it unwinds to USDG.
        for (uint256 h; h < 24; h++) {
            venue.applyFunding(MKT, -1e18 / int256(8760));
        }
        vm.prank(dnGuardian);
        strat.killSleeve(0);
        _unwind(10_000, true);
        assertFalse(strat.sleeve(0).active);
        (, size) = venue.shortSize(MKT);
        assertEq(size, 0);
        assertLe(strat.spotUnits(0), 1e6, "unwound to dust");
    }

    function test_DN_R3_fork_marginTopUp() public {
        _built();
        uint256 before = venue.marginRatio();
        _move(2500); // +25%: the short's equity drops
        uint256 low = venue.marginRatio();
        assertLt(low, before);
        uint256 need = venue.maintenanceMargin() * 3 - uint256(venue.equityRaw());
        vm.startPrank(operator);
        strat.pullFromVault(need);
        strat.depositMargin(need);
        vm.stopPrank();
        assertGe(venue.marginRatio(), 3e18, "back above 3x maintenance");
    }

    // ------------------------------------------------------------------ the four sim stresses (08 gate item 3)

    function test_DN_stress_fork_plus20pctMondayGap() public {
        _built();
        uint256 nav0 = vault.totalAssets();
        vm.warp(_nextClose() + 1 hours); // weekend: spot frozen, deposits closed (DN-R12)
        _fresh();
        vm.warp(_reopenAfter(vm.getBlockTimestamp()) + 5 minutes);
        _move(2000); // +20% at the open
        assertGt(venue.marginRatio(), 1e18, "no liquidation");
        emit log_named_uint("margin ratio after +20% (WAD)", venue.marginRatio());
        emit log_named_uint("NAV change (bps of NAV, marked)", _bps(vault.totalAssets(), nav0));
        assertApproxEqRel(vault.totalAssets(), nav0, 0.02e18, "gate: drawdown < 2%");
        _report();
        assertApproxEqRel(vault.totalAssets(), nav0, 0.02e18, "and after the report");
    }

    function test_DN_stress_fork_fundingMinus100AprForAWeek() public {
        _built();
        uint256 nav0 = vault.totalAssets();
        // −100% APR hourly for 3 days, then the kill switch (DN-R13's 24h rule would fire sooner) unwinds.
        for (uint256 h; h < 72; h++) {
            venue.applyFunding(MKT, -1e18 / int256(8760));
        }
        vm.prank(dnGuardian);
        strat.killSleeve(0);
        _unwind(10_000, false);
        emit log_named_uint("drawdown (bps of NAV)", _bps(nav0, vault.totalAssets()));
        assertGt(vault.totalAssets() * 10_000 / nav0, 9800, "gate: < 2% with the kill switch after 72h");
    }

    function test_DN_stress_fork_venueHaltsWithdrawals72h() public {
        _built();
        uint256 nav0 = vault.totalAssets();
        venue.setWithdrawalsHalted(true);
        vm.startPrank(operator);
        strat.requestMarginWithdraw(1000e6);
        assertEq(strat.claimMargin(), 0, "nothing comes back while halted");
        vm.stopPrank();
        // Exits keep working from the buffer; requests queue.
        vm.prank(alice);
        vault.withdraw(5000e6, alice, alice);
        vm.prank(alice);
        vault.requestRedeem(1000e18, alice, alice);
        vm.warp(vm.getBlockTimestamp() + 72 hours);
        venue.setWithdrawalsHalted(false);
        vm.prank(operator);
        assertEq(strat.claimMargin(), 1000e6);
        // Venue failure bound: the margin posted is the most the vault can lose there.
        assertLe(
            venue.totalDeposited() - venue.totalRequested(), nav0 * 2375 / 10_000 + 1e6, "margin share <= 23.75% of NAV"
        );
    }

    function test_DN_stress_fork_rStockUtilization100pctFor48h() public {
        _built();
        // Borrowers take every wNVDA the rNVDA vault has lent into the market (router borrow at 100% of supply).
        uint256 lent = strat.lentUnits(0);
        _borrowAll();
        // Market at 100%: only the rNVDA vault's idle 10% can be redeemed (DN-R8: why LEND_RATIO must be dynamic).
        uint256 shares = IERC20(nvda.vault).balanceOf(address(strat));
        vm.prank(operator);
        vm.expectRevert(); // not all of it
        strat.unlend(0, shares);
        uint256 idleUnits = IERC20(address(nvda.wrapper)).balanceOf(nvda.vault);
        emit log_named_uint("rNVDA idle units (worst-case redeemable)", idleUnits);
        assertLt(idleUnits, lent, "the vault's lent spot exceeds what can come back in 48h");
        vm.prank(alice);
        uint256 id = vault.requestRedeem(50_000e18, alice, alice);
        vm.warp(vm.getBlockTimestamp() + 48 hours);
        _fresh();
        _report();
        // Unlent spot and the buffer still pay what they can; the rest waits for borrowers to repay.
        emit log_named_uint("lent units stuck", lent);
        assertEq(uint8(vault.request(id).status), uint8(IDeltaNeutralVault.RequestStatus.Queued));
    }

    // ------------------------------------------------------------------ internals

    function _borrowAll() internal {
        MarketParams memory mp = nvda.market;
        uint256 supply = IMorpho(c.morpho).market(nvda.market.id()).totalSupplyAssets;
        uint256 borrowed = IMorpho(c.morpho).market(nvda.market.id()).totalBorrowAssets;
        // The allocator lends up to U_MAX (90% of the vault; relative cap), then borrowers take the whole market.
        IVaultV2Min rv = IVaultV2Min(nvda.vault);
        uint256 room = rv.totalAssets() * 9 / 10 - rv.allocation(keccak256(abi.encode("this", nvda.adapter)));
        vm.prank(c.allocator);
        rv.allocate(nvda.adapter, abi.encode(mp), room);
        supply = IMorpho(c.morpho).market(nvda.market.id()).totalSupplyAssets;
        uint256 amount = supply - borrowed;
        (uint256 p,) = nvda.oracle.stockAnswer();
        uint256 collateral = p * (amount / 1e18 + 1) * 3 / 100;
        deal(USDG, borrower, collateral, true);
        ILendoraRouter.Attestation memory att;
        att.expiry = vm.getBlockTimestamp() + 1 days;
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(attester.privateKey, core.router.attestationDigest(borrower, att.expiry));
        att.signature = abi.encodePacked(r, s, v);
        vm.startPrank(borrower);
        IERC20(USDG).approve(address(core.router), collateral);
        IMorpho(c.morpho).setAuthorization(address(core.router), true);
        core.router.borrow(nvdaCfg.token, collateral, amount, borrower, att, vm.getBlockTimestamp());
        vm.stopPrank();
    }

    function _nextClose() internal view returns (uint256) {
        (IMarketHours.Session memory s, bool found) = core.marketHours.currentOrNextSession(vm.getBlockTimestamp());
        require(found, "calendar ends");
        return s.closeTs;
    }

    function _reopenAfter(uint256 t) internal view returns (uint256 reopen) {
        (, reopen,,) = core.marketHours.closureWindows(t);
    }

    function _bps(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? (a - b) * 10_000 / b : (b - a) * 10_000 / b;
    }
}
