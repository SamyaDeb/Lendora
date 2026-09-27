// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IMorpho, MarketParams, Position} from "morpho-blue/src/interfaces/IMorpho.sol";
import {MarketParamsLib} from "morpho-blue/src/libraries/MarketParamsLib.sol";
import {StocklineRouter} from "../../src/StocklineRouter.sol";
import {IStocklineRouter} from "../../src/interfaces/IStocklineRouter.sol";
import {MockSwapAggregator} from "../mocks/MockSwapAggregator.sol";
import {MockStockToken} from "../mocks/MockStockToken.sol";
import {MockChainlinkAggregator} from "../mocks/MockChainlinkAggregator.sol";
import {LocalStockline} from "../utils/LocalStockline.sol";

/// @notice Drives every router flow with fuzzed amounts, users and a misbehaving DEX (partial fills, fees, lying
/// return values). Reverts are expected for many inputs (health, caps, slippage) and are swallowed; the invariants
/// check what must hold whatever happened.
contract RouterHandler is Test {
    using MarketParamsLib for MarketParams;

    StocklineRouter internal router;
    IMorpho internal morpho;
    MockSwapAggregator internal dex;
    MockStockToken internal stock;
    MockChainlinkAggregator internal feed;
    MockChainlinkAggregator internal usdgFeed;
    IERC20 internal usdg;
    address internal vault;
    MarketParams internal mp;
    address[] public users;
    mapping(address => IStocklineRouter.Attestation) internal atts;
    uint256 public calls;
    uint256 public ok;

    constructor(
        StocklineRouter router_,
        IMorpho morpho_,
        MockSwapAggregator dex_,
        MockStockToken stock_,
        MockChainlinkAggregator feed_,
        MockChainlinkAggregator usdgFeed_,
        IERC20 usdg_,
        address vault_,
        MarketParams memory mp_,
        address[] memory users_,
        IStocklineRouter.Attestation[] memory atts_
    ) {
        router = router_;
        morpho = morpho_;
        dex = dex_;
        stock = stock_;
        feed = feed_;
        usdgFeed = usdgFeed_;
        usdg = usdg_;
        vault = vault_;
        mp = mp_;
        for (uint256 i; i < users_.length; i++) {
            users.push(users_[i]);
            atts[users_[i]] = atts_[i];
        }
    }

    function _u(uint256 seed) internal view returns (address) {
        return users[seed % users.length];
    }

    function _sell(uint256 amountIn) internal view returns (IStocklineRouter.Swap memory) {
        return IStocklineRouter.Swap(
            address(dex),
            abi.encodeCall(MockSwapAggregator.swap, (address(stock), address(usdg), amountIn, 0, address(router))),
            amountIn,
            0
        );
    }

    function _buy(uint256 amountIn) internal view returns (IStocklineRouter.Swap memory) {
        return IStocklineRouter.Swap(
            address(dex),
            abi.encodeCall(MockSwapAggregator.swap, (address(usdg), address(stock), amountIn, 0, address(router))),
            amountIn,
            0
        );
    }

    function lend(uint256 who, uint256 amount) external {
        address u = _u(who);
        vm.prank(u);
        try router.lend(address(stock), bound(amount, 1, 50e18), 0, u, block.timestamp) {
            ok++;
        } catch {}
        calls++;
    }

    function withdrawLend(uint256 who, uint256 frac) external {
        address u = _u(who);
        uint256 shares = IERC20(vault).balanceOf(u) * bound(frac, 1, 100) / 100;
        if (shares == 0) return;
        vm.prank(u);
        try router.withdrawLend(address(stock), shares, 0, u, block.timestamp) {
            ok++;
        } catch {}
        calls++;
    }

    function borrow(uint256 who, uint256 coll, uint256 amount) external {
        address u = _u(who);
        vm.prank(u);
        try router.borrow(
            address(stock), bound(coll, 0, 20_000e6), bound(amount, 1, 20e18), u, atts[u], block.timestamp
        ) {
            ok++;
        } catch {}
        calls++;
    }

    function openShort(uint256 who, uint256 coll, uint256 amount, uint256 fill, uint256 lie, bool compound) external {
        address u = _u(who);
        dex.setFillFraction(bound(fill, 0.3e18, 1e18));
        dex.setReportedAmountOut(lie % 3 == 0 ? 1e30 : 0);
        amount = bound(amount, 1e15, 20e18);
        vm.prank(u);
        try router.openShort(
            address(stock), bound(coll, 0, 20_000e6), amount, _sell(amount), compound, u, atts[u], block.timestamp
        ) {
            ok++;
        } catch {}
        dex.setFillFraction(1e18);
        dex.setReportedAmountOut(0);
        calls++;
    }

    function closeShort(uint256 who, uint256 usdgIn) external {
        address u = _u(who);
        usdgIn = bound(usdgIn, 1e6, 10_000e6);
        vm.prank(u);
        try router.closeShort(address(stock), usdgIn, _buy(usdgIn), u, block.timestamp) {
            ok++;
        } catch {}
        calls++;
    }

    function repay(uint256 who, uint256 amount, bool all) external {
        address u = _u(who);
        vm.prank(u);
        if (all) {
            try router.repay(address(stock), 0, type(uint256).max, u, block.timestamp) {
                ok++;
            } catch {}
        } else {
            try router.repay(address(stock), bound(amount, 1, 5e18), 0, u, block.timestamp) {
                ok++;
            } catch {}
        }
        calls++;
    }

    /// RT-R8: `addCollateral` is a rescue top-up, so it is only exercised for users with debt.
    function addCollateral(uint256 who, uint256 amount) external {
        address u = _u(who);
        if (morpho.position(mp.id(), u).borrowShares == 0) return;
        vm.prank(u);
        try router.addCollateral(address(stock), bound(amount, 1, 5000e6), u, block.timestamp) {
            ok++;
        } catch {}
        calls++;
    }

    function withdrawCollateral(uint256 who, uint256 amount) external {
        address u = _u(who);
        vm.prank(u);
        try router.withdrawCollateral(address(stock), bound(amount, 1, 5000e6), u, block.timestamp) {
            ok++;
        } catch {}
        calls++;
    }

    function movePrice(uint256 bps) external {
        (, int256 p,,,) = feed.latestRoundData();
        int256 next = p * int256(bound(bps, 9500, 10_500)) / 10_000;
        feed.setAnswer(next);
        usdgFeed.setAnswer(1e8);
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 6 hours));
        (, int256 p,,,) = feed.latestRoundData();
        feed.setAnswer(p);
        usdgFeed.setAnswer(1e8);
    }
}

/// @notice RT-R5: the router holds no balances after any fuzzed flow; CL-R6 holds for clUSDG in the full system.
/// forge-config: default.isolate = true
/// forge-config: ci.isolate = true
/// forge-config: deep.isolate = true
/// forge-config: default.invariant.runs = 64
/// forge-config: default.invariant.depth = 60
/// forge-config: default.invariant.fail-on-revert = true
/// forge-config: deep.invariant.runs = 1000
/// forge-config: deep.invariant.depth = 1000
contract StocklineRouterInvariantTest is LocalStockline {
    RouterHandler internal handler;
    uint256 internal constant I = 1; // NVDA

    function setUp() public override {
        super.setUp();
        address lender = makeAddr("lender");
        _onboard(lender, 5000e18, 0);
        _lendAndAllocate(I, lender, 2000e18);

        address[] memory us = new address[](3);
        IStocklineRouter.Attestation[] memory as_ = new IStocklineRouter.Attestation[](3);
        for (uint256 i; i < 3; i++) {
            us[i] = makeAddr(string.concat("user", vm.toString(i)));
            _onboard(us[i], 500e18, 5_000_000e6);
            as_[i] = _attest(us[i]);
            as_[i].expiry = type(uint256).max;
            (uint8 v, bytes32 r, bytes32 s) =
                vm.sign(signer.privateKey, core.router.attestationDigest(us[i], type(uint256).max));
            as_[i].signature = abi.encodePacked(r, s, v);
            m.usdg.mint(address(m.dex), 0);
        }
        handler = new RouterHandler(
            core.router,
            IMorpho(m.morpho),
            m.dex,
            m.tokens[I],
            m.feeds[I],
            m.usdgFeed,
            IERC20(address(m.usdg)),
            ds[I].vault,
            ds[I].market,
            us,
            as_
        );
        targetContract(address(handler));
    }

    function invariant_RT_R5_routerHoldsNothing() public view {
        address r = address(core.router);
        assertEq(IERC20(address(m.tokens[I])).balanceOf(r), 0);
        assertEq(IERC20(address(ds[I].wrapper)).balanceOf(r), 0);
        assertEq(IERC20(address(m.usdg)).balanceOf(r), 0);
        assertEq(IERC20(address(core.clUSDG)).balanceOf(r), 0);
        assertEq(IERC20(ds[I].vault).balanceOf(r), 0);
        assertEq(IERC20(address(m.tokens[I])).allowance(r, address(m.dex)), 0, "no dangling swap approval");
        assertEq(IERC20(address(m.usdg)).allowance(r, address(m.dex)), 0, "no dangling swap approval");
    }

    function invariant_CL_R6_clUsdgFullyBacked() public view {
        assertGe(IERC20(address(m.usdg)).balanceOf(address(core.clUSDG)), IERC20(address(core.clUSDG)).totalSupply());
    }

    function invariant_LM_R7_wrapperFullyBacked() public view {
        assertEq(ds[I].wrapper.backingShortfall(), 0);
    }

    /// Most fuzzed calls must actually go through, or the invariants above would be vacuous.
    function afterInvariant() public view {
        assertGt(handler.ok() * 3, handler.calls(), "at least a third of the flows succeed");
    }
}
