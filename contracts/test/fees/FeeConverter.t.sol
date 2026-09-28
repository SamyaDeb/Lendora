// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {FeeConverter} from "../../src/fees/FeeConverter.sol";
import {IFeeConverter} from "../../src/interfaces/IFeeConverter.sol";
import {MockSwapAggregator} from "../mocks/MockSwapAggregator.sol";
import {MockUSDG} from "../mocks/MockUSDG.sol";
import {LocalStockline} from "../utils/LocalStockline.sol";
import {IVaultV2Min} from "../../src/interfaces/external/IMorphoVaultV2.sol";

/// @notice UniversalRouter-style target (`SwapMode.Transfer`): the input is transferred first, then `sell` pays USDG
/// for whatever stock it holds at a fixed rate (and can be told to underpay).
contract TransferTarget {
    MockUSDG internal immutable usdg;
    uint256 public rateWad; // USDG raw per stock raw, WAD

    constructor(MockUSDG usdg_) {
        usdg = usdg_;
    }

    function setRate(uint256 r) external {
        rateWad = r;
    }

    function sell(IERC20 stock, address to) external {
        uint256 bal = stock.balanceOf(address(this));
        usdg.mint(to, bal * rateWad / 1e18);
    }
}

/// @notice FE-R4 unit tests: keeper-only, market hours only, guard clear only, onchain 1% bound against the oracle,
/// output measured by balance delta, USDG only to the owner-set destination.
/// Vault V2 keeps `firstTotalAssets` in transient storage; `isolate` runs every top-level call as its own transaction.
/// forge-config: default.isolate = true
/// forge-config: ci.isolate = true
contract FeeConverterTest is LocalStockline {
    uint256 internal constant NVDA = 1;
    uint256 internal constant SAT_0919_16Z = 1_789_833_600; // Sat 2026-09-19 12:00 ET: feed closed

    FeeConverter internal conv;
    address internal timelock = makeAddr("converterOwner");
    address internal keeper = makeAddr("feeKeeper");
    address internal treasury = makeAddr("treasuryMultisig");
    address internal lender = makeAddr("lender");
    address internal vault;
    uint256 internal shares;

    function setUp() public override {
        super.setUp();
        vault = ds[NVDA].vault;
        conv = new FeeConverter(timelock, address(m.usdg), treasury, keeper);
        vm.startPrank(timelock);
        conv.setVault(vault, address(ds[NVDA].oracle));
        conv.setSwapTarget(address(m.dex), IFeeConverter.SwapMode.Approve);
        vm.stopPrank();

        // The converter holds fee shares (as the FeeSplitter pays them); idle covers the redemption.
        _onboard(lender, 100e18, 0);
        vm.prank(lender);
        core.router.lend(address(_tok(NVDA)), 10e18, 0, lender, block.timestamp);
        shares = IERC20(vault).balanceOf(lender);
        vm.prank(lender);
        IERC20(vault).transfer(address(conv), shares);

        // DEX pays exactly the oracle value (feed price, USDG = $1).
        (uint256 p,) = ds[NVDA].oracle.stockAnswer();
        m.dex.setRate(address(_tok(NVDA)), address(m.usdg), p * 1e6 * 1e18 / 1e8 / 1e18);
        m.usdg.mint(address(m.dex), 1e15);
    }

    function _swap(uint256 amountIn) internal view returns (IFeeConverter.Swap memory) {
        return IFeeConverter.Swap({
            target: address(m.dex),
            data: abi.encodeCall(
                MockSwapAggregator.swap, (address(_tok(NVDA)), address(m.usdg), amountIn, 0, address(conv))
            )
        });
    }

    function _stockOut() internal view returns (uint256) {
        return IVaultV2Min(vault).previewRedeem(shares);
    }

    function test_FE_R4_convertForwardsUsdgToDestinationOnly() public {
        uint256 stockIn = _stockOut();
        (uint256 value, uint256 floor) = conv.quote(vault, stockIn);
        assertEq(floor, (value * 9900 + 9999) / 10_000, "floor = value - 1%, rounded up");
        vm.expectEmit(address(conv));
        emit IFeeConverter.Converted(vault, shares, stockIn, value, value, treasury);
        vm.prank(keeper);
        uint256 out = conv.convert(vault, shares, floor, _swap(stockIn));
        assertEq(out, value);
        assertEq(IERC20(address(m.usdg)).balanceOf(treasury), value, "destination receives the USDG");
        assertEq(IERC20(address(m.usdg)).balanceOf(keeper), 0, "keeper receives nothing");
        assertEq(IERC20(vault).balanceOf(address(conv)), 0);
        assertEq(IERC20(address(m.usdg)).balanceOf(address(conv)), 0);
        assertEq(IERC20(address(_tok(NVDA))).balanceOf(address(conv)), 0);
        assertEq(IERC20(address(_tok(NVDA))).allowance(address(conv), address(m.dex)), 0, "approval reset");
        // 10 NVDA at the feed price, in USDG raw: sanity of the quote math (D1, no buffer).
        (uint256 p,) = ds[NVDA].oracle.stockAnswer();
        assertApproxEqAbs(value, stockIn * p / 1e20, 1);
    }

    function test_FE_R4_onlyKeeper() public {
        uint256 stockIn = _stockOut();
        vm.expectRevert(IFeeConverter.NotKeeper.selector);
        conv.convert(vault, shares, 0, _swap(stockIn));
        vm.prank(timelock);
        vm.expectRevert(IFeeConverter.NotKeeper.selector);
        conv.convert(vault, shares, 0, _swap(stockIn));
    }

    function test_FE_R4_onlyDuringMarketHours() public {
        vm.warp(SAT_0919_16Z);
        uint256 stockIn = _stockOut();
        vm.prank(keeper);
        vm.expectRevert(IFeeConverter.MarketClosed.selector);
        conv.convert(vault, shares, type(uint256).max, _swap(stockIn));
    }

    function test_FE_R4_onlyWithGuardClear() public {
        vm.prank(c.guardian);
        ds[NVDA].oracle.trip(1); // MANUAL
        uint256 stockIn = _stockOut();
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IFeeConverter.GuardTripped.selector, 1));
        conv.convert(vault, shares, type(uint256).max, _swap(stockIn));
    }

    function test_FE_R4_minOutBelowOracleFloorRejected() public {
        uint256 stockIn = _stockOut();
        (, uint256 floor) = conv.quote(vault, stockIn);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IFeeConverter.SlippageTooLoose.selector, floor - 1, floor));
        conv.convert(vault, shares, floor - 1, _swap(stockIn));
    }

    function test_FE_R4_dexUnderpayingIsRejected() public {
        uint256 stockIn = _stockOut();
        (, uint256 floor) = conv.quote(vault, stockIn);
        m.dex.setFeeBps(101); // 1.01% worse than the oracle
        uint256 wouldGet = m.dex.quote(address(_tok(NVDA)), address(m.usdg), stockIn);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IFeeConverter.InsufficientOutput.selector, wouldGet, floor));
        conv.convert(vault, shares, floor, _swap(stockIn));
        // Within 1% goes through.
        m.dex.setFeeBps(99);
        vm.prank(keeper);
        uint256 out = conv.convert(vault, shares, floor, _swap(stockIn));
        assertGe(out, floor);
    }

    function test_FE_R4_lyingReturnDataIsIgnored() public {
        uint256 stockIn = _stockOut();
        (, uint256 floor) = conv.quote(vault, stockIn);
        m.dex.setFeeBps(500);
        m.dex.setReportedAmountOut(type(uint128).max); // claims a huge output
        vm.prank(keeper);
        vm.expectRevert(); // InsufficientOutput from the measured delta
        conv.convert(vault, shares, floor, _swap(stockIn));
    }

    function test_FE_R4_transferModeTarget() public {
        TransferTarget t = new TransferTarget(m.usdg);
        (uint256 p,) = ds[NVDA].oracle.stockAnswer();
        t.setRate(p * 1e6 / 1e8);
        vm.prank(timelock);
        conv.setSwapTarget(address(t), IFeeConverter.SwapMode.Transfer);
        uint256 stockIn = _stockOut();
        (uint256 value, uint256 floor) = conv.quote(vault, stockIn);
        vm.prank(keeper);
        uint256 out = conv.convert(
            vault,
            shares,
            floor,
            IFeeConverter.Swap(
                address(t), abi.encodeCall(TransferTarget.sell, (IERC20(address(_tok(NVDA))), address(conv)))
            )
        );
        assertApproxEqAbs(out, value, 1e6);
        assertEq(IERC20(address(m.usdg)).balanceOf(treasury), out);
    }

    function test_FE_R4_unlistedTargetVaultAndZeroShares() public {
        uint256 stockIn = _stockOut();
        IFeeConverter.Swap memory s = _swap(stockIn);
        s.target = makeAddr("rogueTarget");
        vm.startPrank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IFeeConverter.SwapTargetNotAllowed.selector, s.target));
        conv.convert(vault, shares, 0, s);
        vm.expectRevert(abi.encodeWithSelector(IFeeConverter.VaultNotSet.selector, ds[0].vault));
        conv.convert(ds[0].vault, 1, 0, _swap(1));
        vm.expectRevert(IFeeConverter.ZeroShares.selector);
        conv.convert(vault, 0, 0, _swap(0));
        vm.stopPrank();
        vm.expectRevert(abi.encodeWithSelector(IFeeConverter.VaultNotSet.selector, ds[0].vault));
        conv.quote(ds[0].vault, 1);
    }

    function test_FE_R4_ownerSettersAndChecks() public {
        bytes memory unauth = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, keeper);
        vm.startPrank(keeper); // the keeper can change nothing
        vm.expectRevert(unauth);
        conv.setDestination(keeper);
        vm.expectRevert(unauth);
        conv.setKeeper(keeper);
        vm.expectRevert(unauth);
        conv.setVault(vault, address(0));
        vm.expectRevert(unauth);
        conv.setSwapTarget(keeper, IFeeConverter.SwapMode.Approve);
        vm.expectRevert(unauth);
        conv.forwardUnconverted(vault, 1);
        vm.stopPrank();

        vm.startPrank(timelock);
        vm.expectRevert(abi.encodeWithSelector(IFeeConverter.BadVault.selector, vault));
        conv.setVault(vault, address(ds[0].oracle)); // SPY oracle for the NVDA vault
        vm.expectRevert(IFeeConverter.ZeroAddress.selector);
        conv.setVault(address(0), address(ds[1].oracle));
        vm.expectRevert(IFeeConverter.ZeroAddress.selector);
        conv.setSwapTarget(address(m.usdg), IFeeConverter.SwapMode.Approve);
        vm.expectRevert(IFeeConverter.ZeroAddress.selector);
        conv.setSwapTarget(address(0), IFeeConverter.SwapMode.Approve);
        vm.expectRevert(IFeeConverter.ZeroAddress.selector);
        conv.setDestination(address(0));
        vm.expectRevert(IFeeConverter.ZeroAddress.selector);
        conv.setKeeper(address(0));

        address newDest = makeAddr("backstopReserve");
        vm.expectEmit(address(conv));
        emit IFeeConverter.DestinationSet(newDest);
        conv.setDestination(newDest);
        address newKeeper = makeAddr("newKeeper");
        conv.setKeeper(newKeeper);
        assertEq(conv.keeper(), newKeeper);
        conv.setVault(vault, address(0)); // delist
        assertEq(conv.oracleOf(vault), address(0));

        // Exit path: raw shares go to the destination and nowhere else.
        vm.expectEmit(address(conv));
        emit IFeeConverter.Forwarded(vault, shares, newDest);
        conv.forwardUnconverted(vault, shares);
        vm.stopPrank();
        assertEq(IERC20(vault).balanceOf(newDest), shares);

        vm.expectRevert(IFeeConverter.ZeroAddress.selector);
        new FeeConverter(timelock, address(m.usdg), address(0), keeper);
        vm.expectRevert(IFeeConverter.ZeroAddress.selector);
        new FeeConverter(timelock, address(m.usdg), treasury, address(0));
        vm.expectRevert(IFeeConverter.ZeroAddress.selector);
        new FeeConverter(timelock, address(0), treasury, keeper);
    }

    function testFuzz_FE_R4_floorIsExactlyOnePercentBelowValue(uint256 amount) public view {
        amount = bound(amount, 0, 1e30);
        (uint256 value, uint256 floor) = conv.quote(vault, amount);
        assertLe(floor, value);
        assertGe(floor * 10_000, value * 9900, "never looser than 1%");
        assertLt((floor - (floor > 0 ? 1 : 0)) * 10_000, value * 9900 + 10_000, "tight up to rounding");
    }
}
