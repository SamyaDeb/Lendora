// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IMorpho, MarketParams, Position, Market} from "morpho-blue/src/interfaces/IMorpho.sol";
import {MarketParamsLib} from "morpho-blue/src/libraries/MarketParamsLib.sol";
import {StocklineLiquidator} from "../../src/StocklineLiquidator.sol";
import {IStocklineRouter} from "../../src/interfaces/IStocklineRouter.sol";
import {MockSwapAggregator} from "../mocks/MockSwapAggregator.sol";
import {LocalStockline} from "../utils/LocalStockline.sol";

/// @notice Fallback liquidator (03 LM-R12, 02): seize clUSDG → unwrap → buy stock → wrap → repay, in one tx
/// through the
/// Morpho callback, for any position, holding nothing afterwards.
/// forge-config: default.isolate = true
/// forge-config: ci.isolate = true
contract StocklineLiquidatorTest is LocalStockline {
    using MarketParamsLib for MarketParams;

    uint256 internal constant I = 1; // NVDA
    uint256 internal constant DUST = 1e9; // router entry borrow that opens the position (RT-R8)
    address internal lender = makeAddr("lender");
    address internal alice = makeAddr("alice");
    address internal recipient = makeAddr("recipient");
    StocklineLiquidator internal liq;
    IMorpho internal morpho;
    address internal nvda;

    function setUp() public override {
        super.setUp();
        liq = core.liquidator;
        morpho = IMorpho(m.morpho);
        nvda = address(m.tokens[I]);
        _onboard(lender, 1000e18, 0);
        _onboard(alice, 0, 100_000e6);
        _lendAndAllocate(I, lender, 500e18);
    }

    function _setPrice(int256 p) internal {
        m.feeds[I].setAnswer(p);
        m.usdgFeed.setAnswer(1e8);
        uint256 up = uint256(p);
        m.dex.setRate(nvda, address(m.usdg), up * 1e6 / 1e8);
        m.dex.setRate(address(m.usdg), nvda, uint256(1e8) * 1e36 / (up * 1e6));
    }

    /// @dev alice: collateral with a dust borrow through the attested router entry (RT-R8: no debt-free collateral),
    /// then the rest borrowed directly on Morpho (a position sized outside the router's checks, 05 §1 residual).
    function _openDirect(uint256 collateral, uint256 debt) internal {
        IStocklineRouter.Attestation memory att = _attest(alice);
        vm.prank(alice);
        core.router.borrow(nvda, collateral, DUST, alice, att, block.timestamp);
        vm.prank(alice);
        morpho.borrow(ds[I].market, debt - DUST, 0, alice, alice);
    }

    function _buy(uint256 usdgIn, uint256 minOut) internal view returns (StocklineLiquidator.Swap memory) {
        return StocklineLiquidator.Swap({
            target: address(m.dex),
            data: abi.encodeCall(MockSwapAggregator.swap, (address(m.usdg), nvda, usdgIn, 0, address(liq))),
            amountIn: usdgIn,
            minOut: minOut
        });
    }

    function _liquidation(uint256 seized, uint256 shares, StocklineLiquidator.Swap memory s, uint256 minProfit)
        internal
        view
        returns (StocklineLiquidator.Liquidation memory)
    {
        return StocklineLiquidator.Liquidation({
            market: ds[I].market,
            borrower: alice,
            seizedAssets: seized,
            repaidShares: shares,
            swap: s,
            minProfit: minProfit,
            recipient: recipient,
            deadline: block.timestamp
        });
    }

    function _assertEmpty() internal view {
        assertEq(IERC20(nvda).balanceOf(address(liq)), 0);
        assertEq(IERC20(address(ds[I].wrapper)).balanceOf(address(liq)), 0);
        assertEq(IERC20(address(m.usdg)).balanceOf(address(liq)), 0);
        assertEq(IERC20(address(core.clUSDG)).balanceOf(address(liq)), 0);
        assertEq(IERC20(address(m.usdg)).allowance(address(liq), address(m.dex)), 0);
        assertEq(IERC20(address(ds[I].wrapper)).allowance(address(liq), m.morpho), 0);
    }

    function test_LM_R12_liquidatesADirectMorphoPositionAtAProfit() public {
        _openDirect(3500e6, 10e18); // HF 3500·0.77/2256.6 = 1.19
        _setPrice(320e8); // +42%: 3500·0.77/3200 = 0.84 → liquidatable
        Position memory pos = morpho.position(ds[I].market.id(), alice);
        uint256 usdgIn = 10.1e18 * 320 / 1e12; // debt value + 1% headroom (6 dp)
        uint256 gas = gasleft();
        vm.prank(makeAddr("anyone"));
        (uint256 seized, uint256 repaid, uint256 profit) =
            liq.liquidate(_liquidation(0, pos.borrowShares, _buy(usdgIn, 10e18), 1e6));
        emit log_named_uint("gas liquidate (mock DEX)", gas - gasleft());
        assertGe(repaid, 10e18);
        assertEq(morpho.position(ds[I].market.id(), alice).borrowShares, 0, "fully repaid");
        assertEq(profit, seized - usdgIn, "profit = seized USDG - USDG spent");
        assertGt(profit, 200e6, "about the 7.41% incentive on $3,200");
        assertEq(IERC20(address(m.usdg)).balanceOf(recipient), profit);
        assertGt(IERC20(nvda).balanceOf(recipient), 0, "excess stock refunded");
        _assertEmpty();
    }

    function test_LM_R12_routerOpenedShortIsLiquidatable() public {
        _onboard(makeAddr("bob"), 0, 100_000e6);
        address bob = makeAddr("bob");
        IStocklineRouter.Attestation memory att = _attest(bob);
        IStocklineRouter.Swap memory sell = IStocklineRouter.Swap({
            target: address(m.dex),
            data: abi.encodeCall(MockSwapAggregator.swap, (nvda, address(m.usdg), 10e18, 0, address(core.router))),
            amountIn: 10e18,
            minOut: 0
        });
        vm.prank(bob);
        core.router.openShort(nvda, 3500e6, 10e18, sell, false, bob, att, block.timestamp);
        _setPrice(320e8);
        StocklineLiquidator.Liquidation memory l = _liquidation(0, 0, _buy(10.1e18 * 320 / 1e12, 10e18), 0);
        l.borrower = bob;
        l.repaidShares = morpho.position(ds[I].market.id(), bob).borrowShares;
        liq.liquidate(l);
        assertEq(morpho.position(ds[I].market.id(), bob).borrowShares, 0);
        _assertEmpty();
    }

    /// Price +80%: collateral no longer covers debt × LIF. Seize all collateral; Morpho realizes the rest as bad debt.
    function test_LM_R12_seizeAllCollateralOnBadDebt() public {
        _openDirect(3500e6, 10e18);
        _setPrice(406e8); // debt value $4,060 > collateral $3,500
        Market memory before = morpho.market(ds[I].market.id());
        uint256 usdgIn = 3400e6;
        (uint256 seized,,) = liq.liquidate(_liquidation(3500e6, 0, _buy(usdgIn, 8e18), 0));
        assertEq(seized, 3500e6);
        Position memory pos = morpho.position(ds[I].market.id(), alice);
        assertEq(pos.collateral, 0);
        assertEq(pos.borrowShares, 0, "remaining debt socialized as bad debt");
        assertLt(morpho.market(ds[I].market.id()).totalSupplyAssets, before.totalSupplyAssets, "lenders absorb it");
        _assertEmpty();
    }

    /// LM-R12: a swap target that reverts makes the whole liquidation revert with the target's own error data (nothing
    /// is left half-done: Morpho's liquidation is undone with it).
    function test_LM_R12_revertingSwapBubblesUpAndUndoesTheLiquidation() public {
        _openDirect(3500e6, 10e18);
        _setPrice(320e8);
        uint256 shares = morpho.position(ds[I].market.id(), alice).borrowShares;
        StocklineLiquidator.Swap memory s = _buy(10.1e18 * 320 / 1e12, 10e18);
        s.data = abi.encodeWithSignature("doesNotExist()"); // the target has no such function: the call reverts
        vm.expectRevert();
        liq.liquidate(_liquidation(0, shares, s, 0));
        assertEq(morpho.position(ds[I].market.id(), alice).borrowShares, shares, "position untouched");
        _assertEmpty();
    }

    function test_guardsAndAuth() public {
        _openDirect(3500e6, 10e18);
        _setPrice(320e8);
        uint256 shares = morpho.position(ds[I].market.id(), alice).borrowShares;
        uint256 usdgIn = 10.1e18 * 320 / 1e12;

        StocklineLiquidator.Liquidation memory l = _liquidation(0, shares, _buy(usdgIn, 10e18), 1_000_000e6);
        vm.expectRevert(); // InsufficientProfit
        liq.liquidate(l);

        l = _liquidation(0, shares, _buy(usdgIn, 20e18), 0);
        vm.expectRevert(abi.encodeWithSelector(StocklineLiquidator.InsufficientOutput.selector, 10.1e18, 20e18));
        liq.liquidate(l);

        l = _liquidation(0, shares, _buy(usdgIn, 0), 0);
        l.swap.target = makeAddr("evil");
        vm.expectRevert(abi.encodeWithSelector(StocklineLiquidator.SwapTargetNotAllowed.selector, l.swap.target));
        liq.liquidate(l);

        l = _liquidation(0, shares, _buy(usdgIn, 0), 0);
        l.deadline = block.timestamp - 1;
        vm.expectRevert(StocklineLiquidator.Expired.selector);
        liq.liquidate(l);

        l = _liquidation(0, shares, _buy(usdgIn, 0), 0);
        l.market.collateralToken = address(m.usdg);
        vm.expectRevert(StocklineLiquidator.BadMarket.selector);
        liq.liquidate(l);

        l = _liquidation(0, shares, _buy(usdgIn, 0), 0);
        l.recipient = address(0);
        vm.expectRevert(StocklineLiquidator.ZeroAddress.selector);
        liq.liquidate(l);

        vm.expectRevert(StocklineLiquidator.NotMorpho.selector);
        liq.onMorphoLiquidate(1, abi.encode(ds[I].market));
        vm.prank(m.morpho);
        vm.expectRevert(StocklineLiquidator.NotMorpho.selector); // not inside our own liquidate()
        liq.onMorphoLiquidate(1, abi.encode(ds[I].market));

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        liq.setSwapTarget(address(1), StocklineLiquidator.SwapMode.Approve);
        vm.startPrank(owner);
        vm.expectRevert(StocklineLiquidator.ZeroAddress.selector);
        liq.setSwapTarget(m.morpho, StocklineLiquidator.SwapMode.Approve);
        liq.setSwapTarget(address(1), StocklineLiquidator.SwapMode.Transfer);
        vm.stopPrank();
        assertEq(uint256(liq.swapModes(address(1))), 2);
        vm.expectRevert(StocklineLiquidator.ZeroAddress.selector);
        new StocklineLiquidator(address(0), address(core.clUSDG), owner);
    }
}
