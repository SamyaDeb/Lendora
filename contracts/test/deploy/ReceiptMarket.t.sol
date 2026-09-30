// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IMorpho, Id, MarketParams, Position} from "morpho-blue/src/interfaces/IMorpho.sol";
import {MarketParamsLib} from "morpho-blue/src/libraries/MarketParamsLib.sol";
import {VaultV2Ids} from "../../src/libraries/VaultV2Ids.sol";
import {IVaultV2Min} from "../../src/interfaces/external/IMorphoVaultV2.sol";
import {ReceiptMarketDeploy, IVaultV2Liquidity} from "../../script/ReceiptMarketDeploy.sol";
import {ListReceiptMarket} from "../../script/ListReceiptMarket.s.sol";
import {LocalLendora} from "../utils/LocalLendora.sol";

/// @notice G5 receipt market (A3; 05 §3, CL-R10…R12) on the full local deployment: stage 1 keeps every cap at 0 and
/// hands every role away; the listing only happens through the curator's 48h vault timelock; then lenders of USDG
/// supply through the vault, an `rNVDA` holder borrows at LLTV 62.5% against the buffered receipt price, exits work
/// with the oracle guard tripped, and a liquidator seizes `rNVDA` and redeems it for `wNVDA` (CL-R11).
/// forge-config: default.isolate = true
contract ReceiptMarketTest is LocalLendora, ReceiptMarketDeploy {
    using MarketParamsLib for MarketParams;

    uint256 internal constant NVDA = 1;
    uint256 internal constant CAP = 1_000_000e6;
    ReceiptDeployment internal r;
    address internal curator;
    address internal usdgLender = makeAddr("usdgLender");
    address internal borrower = makeAddr("borrower");

    function setUp() public override {
        super.setUp();
        curator = c.curator;
        m.usdg.mint(address(this), 2 * USDG_SEED);
        r = _deployReceiptMarket(address(this), _cfg());
    }

    function _cfg() internal view returns (ReceiptConfig memory) {
        return ReceiptConfig({
            ticker: "NVDA",
            stockToken: address(m.tokens[NVDA]),
            feed: address(m.feeds[NVDA]),
            wrapper: address(ds[NVDA].wrapper),
            rVault: ds[NVDA].vault,
            sigmaWad: 0.52e18,
            morpho: m.morpho,
            irm: m.irm,
            usdg: address(m.usdg),
            usdgFeed: address(m.usdgFeed),
            vaultFactory: m.vaultFactory,
            adapterFactory: m.adapterFactory,
            marketHours: address(core.marketHours),
            timelock: address(core.timelock),
            owner: owner,
            curator: curator,
            guardian: guardian,
            allocator: allocator,
            guardKeeper: c.guardKeeper,
            feeSplitter: address(core.feeSplitter),
            sequencerFeed: address(0),
            issuerRegistry: address(m.registry),
            timelockDelay: 48 hours
        });
    }

    function _list() internal {
        _list(0);
    }

    /// @dev Curator submits calls `from…5` (earlier ones already submitted), then anyone executes all six after 48h.
    function _list(uint256 from) internal {
        bytes[6] memory calls = _receiptListingCalls(r, ds[NVDA].vault, CAP);
        for (uint256 i = from; i < 6; i++) {
            vm.prank(curator);
            IVaultV2Min(r.usdgVault).submit(calls[i]);
        }
        vm.warp(block.timestamp + 48 hours);
        for (uint256 i; i < 6; i++) {
            (bool ok,) = r.usdgVault.call(calls[i]); // anyone executes after the delay
            assertTrue(ok, "listing call");
        }
    }

    /// @dev A lender of NVDA gets `rNVDA` through the router (the stock market must have borrowable liquidity for
    /// the receipt to be worth something; here it is simply the vault's idle wNVDA).
    function _receiptTo(address who, uint256 stockUnits) internal returns (uint256 shares) {
        _onboard(who, stockUnits, 0);
        uint256 before = IERC20(ds[NVDA].vault).balanceOf(who);
        vm.prank(who);
        core.router.lend(address(m.tokens[NVDA]), stockUnits, 0, who, block.timestamp);
        shares = IERC20(ds[NVDA].vault).balanceOf(who) - before;
    }

    function _depositUsdg(address who, uint256 amount) internal {
        m.usdg.mint(who, amount);
        vm.startPrank(who);
        IERC20(address(m.usdg)).approve(r.usdgVault, amount);
        IVaultV2Min(r.usdgVault).deposit(amount, who);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ stage 1

    function test_G5_stage1_wiringKeepsNoPowerAndEveryCapZero() public view {
        assertEq(r.oracle.owner(), address(core.timelock), "oracle owned by the timelock");
        assertEq(r.oracle.VAULT(), ds[NVDA].vault);
        assertEq(r.market.lltv, 0.625e18, "LLTV 62.5% (05 s3)");
        assertEq(r.market.loanToken, address(m.usdg));
        assertEq(r.market.collateralToken, ds[NVDA].vault);
        assertEq(IMorpho(m.morpho).market(r.market.id()).totalSupplyAssets, USDG_SEED, "market seeded");
        IVaultV2Min v = IVaultV2Min(r.usdgVault);
        assertEq(v.owner(), address(core.timelock));
        assertEq(v.curator(), curator);
        assertTrue(v.isSentinel(guardian));
        assertFalse(v.isAllocator(address(this)), "deployer dropped");
        assertTrue(v.isAllocator(allocator));
        assertEq(IVaultV2Liquidity(r.usdgVault).liquidityAdapter(), r.usdgAdapter);
        assertEq(v.timelock(IVaultV2Min.increaseAbsoluteCap.selector), 48 hours);
        assertEq(v.timelock(IVaultV2Min.increaseRelativeCap.selector), 48 hours);
        assertEq(v.performanceFeeRecipient(), address(core.feeSplitter), "FE-R1");
        assertEq(v.balanceOf(DEAD), USDG_SEED * 1e12, "vault seeded (USDG 6 dp, shares 18 dp)");
        assertEq(v.absoluteCap(keccak256(VaultV2Ids.adapterIdData(r.usdgAdapter))), 0);
        assertEq(v.absoluteCap(VaultV2Ids.marketId(r.usdgAdapter, r.market)), 0);
    }

    function test_G5_stage1_depositsRefusedUntilListed() public {
        m.usdg.mint(usdgLender, 1000e6);
        vm.startPrank(usdgLender);
        IERC20(address(m.usdg)).approve(r.usdgVault, 1000e6);
        vm.expectRevert(); // the liquidity adapter's allocation exceeds the 0 caps
        IVaultV2Min(r.usdgVault).deposit(1000e6, usdgLender);
        vm.stopPrank();
    }

    function test_G5_stage1_refusesWithoutLltvOrSeed() public {
        ReceiptConfig memory x = _cfg();
        x.ticker = "NVDA2";
        deal(address(m.usdg), address(this), 0);
        vm.expectRevert("deployer needs 2 * USDG_SEED raw USDG");
        this.deployExternal(x);
        vm.mockCall(m.morpho, abi.encodeWithSignature("isLltvEnabled(uint256)", uint256(0.625e18)), abi.encode(false));
        vm.expectRevert("receipt: LLTV 62.5% not enabled on Morpho");
        this.deployExternal(x);
    }

    function deployExternal(ReceiptConfig memory x) external returns (ReceiptDeployment memory) {
        return _deployReceiptMarket(address(this), x);
    }

    // ------------------------------------------------------------------ stage 2: listing through the timelock

    function test_G5_listing_onlyThroughCuratorTimelock() public {
        bytes[6] memory calls = _receiptListingCalls(r, ds[NVDA].vault, CAP);
        (bool ok,) = r.usdgVault.call(calls[0]);
        assertFalse(ok, "not submitted");
        vm.prank(owner);
        vm.expectRevert();
        IVaultV2Min(r.usdgVault).submit(calls[0]); // only the curator submits
        vm.prank(curator);
        IVaultV2Min(r.usdgVault).submit(calls[0]);
        vm.warp(block.timestamp + 48 hours - 1);
        (ok,) = r.usdgVault.call(calls[0]);
        assertFalse(ok, "before the 48h delay");
        _list(1);
        assertEq(IVaultV2Min(r.usdgVault).absoluteCap(VaultV2Ids.marketId(r.usdgAdapter, r.market)), CAP);
        _depositUsdg(usdgLender, 100_000e6);
        assertEq(
            IMorpho(m.morpho).market(r.market.id()).totalSupplyAssets, USDG_SEED + 100_000e6, "deposit lent at once"
        );
    }

    function test_CL_R10_listingWindowOnMainnetOnly() public {
        ListReceiptMarket s = new ListReceiptMarket();
        s.assertListingWindow(46_630, 0, 1);
        s.assertListingWindow(31_337, 0, 1);
        vm.expectRevert("CL-R10: set STOCK_LAUNCH_TS (the stock market's launch, from the launch log)");
        s.assertListingWindow(4663, 0, 1);
        vm.expectRevert("CL-R10: the receipt market lists >= 30 days after launch");
        s.assertListingWindow(4663, 1000, 1000 + 30 days - 1);
        s.assertListingWindow(4663, 1000, 1000 + 30 days);
    }

    function test_G5_scriptGuards() public {
        ListReceiptMarket s = new ListReceiptMarket();
        s.checkNetwork("fork-4663", 4663);
        s.checkNetwork("31337", 31_337);
        vm.expectRevert("LENDORA_NETWORK does not match the chain");
        s.checkNetwork("46630", 4663);
        vm.expectRevert("bad LENDORA_NETWORK");
        s.checkNetwork("46a30", 46_630);
        vm.expectRevert("MN-R4: no broadcast to 4663 without I_HAVE_THE_OWNERS_GO=1");
        s.checkGo(4663);
        vm.expectRevert("set TESTNET_GO=yes after the go-ahead");
        s.checkGo(46_630);
        s.checkGo(31_337);
    }

    // ------------------------------------------------------------------ borrowing, exits, liquidation

    function _openLoan(uint256 stockUnits) internal returns (uint256 shares, uint256 maxBorrow) {
        _list();
        _depositUsdg(usdgLender, 500_000e6);
        shares = _receiptTo(borrower, stockUnits);
        vm.startPrank(borrower);
        IERC20(ds[NVDA].vault).approve(m.morpho, shares);
        IMorpho(m.morpho).supplyCollateral(r.market, shares, borrower, "");
        vm.stopPrank();
        maxBorrow = shares * r.oracle.price() / 1e36 * r.market.lltv / 1e18;
    }

    function test_G5_borrowUpToLltvAgainstTheBufferedReceiptPrice() public {
        (, uint256 maxBorrow) = _openLoan(100e18);
        (uint256 p,) = ds[NVDA].oracle.stockAnswer();
        // 100 NVDA at the feed price (8 dp) in USDG (6 dp) is `p` raw USDG; in session the buffer is 0 (OR-R20).
        assertApproxEqRel(maxBorrow, p * 0.625e18 / 1e18, 1e12, "LLTV 62.5% of the receipt value");
        // Over the weekend the same receipt is marked down by the closure buffer (05 s3: collateral haircut).
        uint256 sat = block.timestamp + 3 days + 4 hours; // Wed 12:00 ET -> Sat 16:00 ET
        assertLt(r.oracle.priceAt(sat), r.oracle.price(), "buffer haircut while closed");
        vm.prank(borrower);
        vm.expectRevert(); // insufficient collateral
        IMorpho(m.morpho).borrow(r.market, maxBorrow + 2, 0, borrower, borrower);
        vm.prank(borrower);
        IMorpho(m.morpho).borrow(r.market, maxBorrow - 1e6, 0, borrower, borrower);
        assertEq(IERC20(address(m.usdg)).balanceOf(borrower), maxBorrow - 1e6);
    }

    function test_G5_CP_R4_exitsWorkWithTheGuardTripped() public {
        (uint256 shares, uint256 maxBorrow) = _openLoan(100e18);
        vm.prank(borrower);
        IMorpho(m.morpho).borrow(r.market, maxBorrow / 2, 0, borrower, borrower);
        vm.prank(guardian);
        r.oracle.trip(1); // MANUAL
        assertTrue(r.oracle.guardTripped());
        vm.startPrank(borrower);
        IERC20(address(m.usdg)).approve(m.morpho, type(uint256).max);
        Position memory pos = IMorpho(m.morpho).position(r.market.id(), borrower);
        m.usdg.mint(borrower, 10e6); // interest
        IMorpho(m.morpho).repay(r.market, 0, pos.borrowShares, borrower, "");
        IMorpho(m.morpho).withdrawCollateral(r.market, shares, borrower, borrower);
        vm.stopPrank();
        assertEq(IERC20(ds[NVDA].vault).balanceOf(borrower), shares, "rNVDA back");
        // USDG lenders exit too: the liquidity adapter pulls from the market.
        uint256 lenderShares = IERC20(r.usdgVault).balanceOf(usdgLender);
        vm.prank(usdgLender);
        IVaultV2Min(r.usdgVault).redeem(lenderShares, usdgLender, usdgLender);
        assertGe(IERC20(address(m.usdg)).balanceOf(usdgLender), 500_000e6);
    }

    function test_CL_R11_liquidatorSeizesReceiptAndRedeemsForWrappedStock() public {
        (, uint256 maxBorrow) = _openLoan(100e18);
        vm.prank(borrower);
        IMorpho(m.morpho).borrow(r.market, maxBorrow - 1e6, 0, borrower, borrower);
        (uint256 p,) = ds[NVDA].oracle.stockAnswer();
        m.feeds[NVDA].setAnswer(int256(p * 80 / 100)); // -20%
        address liq = makeAddr("liquidator");
        m.usdg.mint(liq, 1_000_000e6);
        vm.startPrank(liq);
        IERC20(address(m.usdg)).approve(m.morpho, type(uint256).max);
        uint256 seize = IMorpho(m.morpho).position(r.market.id(), borrower).collateral / 2;
        (uint256 seized,) = IMorpho(m.morpho).liquidate(r.market, borrower, seize, 0, "");
        uint256 wBefore = IERC20(address(ds[NVDA].wrapper)).balanceOf(liq);
        IVaultV2Min(ds[NVDA].vault).redeem(seized, liq, liq); // rNVDA → wNVDA from the vault's idle liquidity
        vm.stopPrank();
        assertGt(IERC20(address(ds[NVDA].wrapper)).balanceOf(liq) - wBefore, 0, "CL-R11 redeemable");
    }

    function test_G5_writesReceiptJsonUnderTheStock() public {
        string memory json = _receiptJson("31337", "NVDA", r);
        assertEq(vm.parseJsonAddress(json, ".oracle"), address(r.oracle));
        assertEq(vm.parseJsonBytes32(json, ".marketId"), Id.unwrap(r.market.id()));
        assertEq(vm.parseJsonUint(json, ".lltv"), 0.625e18);
    }

    /// @dev Shared vector with packages/sdk/test/vaultTimelock.test.ts (`receiptMarketCapId`).
    function test_G5_capIdVectorMatchesSdk() public pure {
        MarketParams memory mp = MarketParams(address(0x11), address(0x22), address(0x33), address(0x44), 0.625e18);
        assertEq(VaultV2Ids.marketId(address(0x66), mp), RECEIPT_CAP_ID_VECTOR);
    }

    bytes32 internal constant RECEIPT_CAP_ID_VECTOR =
        0xa375cf5a1815482cc748bf2e244ec447d687f4a44f0d7a404b3f082f83fe9654;
}
