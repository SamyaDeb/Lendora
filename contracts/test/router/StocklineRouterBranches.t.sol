// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IMorpho, MarketParams, Position, Authorization, Signature} from "morpho-blue/src/interfaces/IMorpho.sol";
import {MarketParamsLib} from "morpho-blue/src/libraries/MarketParamsLib.sol";
import {StocklineRouter} from "../../src/StocklineRouter.sol";
import {IStocklineRouter} from "../../src/interfaces/IStocklineRouter.sol";
import {IVaultV2Min} from "../../src/interfaces/external/IMorphoVaultV2.sol";
import {MockSwapAggregator} from "../mocks/MockSwapAggregator.sol";
import {LocalStockline} from "../utils/LocalStockline.sol";

/// @notice Branch coverage for the router's exits and helpers (remediation task 6): deadline, zero-amount and
/// not-listed branches of every exit, permit / Morpho-signature failure paths, `repay` by `type(uint256).max`,
/// `withdrawLend` served from idle and `closeShort` with no debt (swaps in `Transfer` mode: real UniversalRouter, fork
/// suite). Exits never need an attestation (CP-R4), so none is passed here.
/// forge-config: default.isolate = true
/// forge-config: ci.isolate = true
contract StocklineRouterBranchesTest is LocalStockline {
    using MarketParamsLib for MarketParams;

    uint256 internal constant NVDA = 1;
    address internal lender = makeAddr("lender");
    address internal alice = makeAddr("alice");
    address internal nvda;
    IMorpho internal morpho;
    StocklineRouter internal router;
    address internal constant UNLISTED = address(0xbeef);

    function setUp() public override {
        super.setUp();
        nvda = address(m.tokens[NVDA]);
        morpho = IMorpho(m.morpho);
        router = core.router;
        _onboard(lender, 1000e18, 0);
        _onboard(alice, 100e18, 1_000_000e6);
        _lendAndAllocate(NVDA, lender, 500e18);
    }

    function _pos(address who) internal view returns (Position memory) {
        return morpho.position(ds[NVDA].market.id(), who);
    }

    function _open(address who, uint256 coll, uint256 amount) internal {
        IStocklineRouter.Attestation memory att = _attest(who);
        vm.prank(who);
        router.borrow(nvda, coll, amount, who, att, block.timestamp);
    }

    function _swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut)
        internal
        view
        returns (IStocklineRouter.Swap memory)
    {
        return IStocklineRouter.Swap({
            target: address(m.dex),
            data: abi.encodeCall(MockSwapAggregator.swap, (tokenIn, tokenOut, amountIn, 0, address(router))),
            amountIn: amountIn,
            minOut: minOut
        });
    }

    // ------------------------------------------------------------------ RT-R6 deadline and listing on every exit

    function test_RT_R6_exitsCheckDeadline() public {
        uint256 past = block.timestamp - 1;
        vm.startPrank(alice);
        vm.expectRevert(IStocklineRouter.Expired.selector);
        router.withdrawLend(nvda, 1, 0, alice, past);
        vm.expectRevert(IStocklineRouter.Expired.selector);
        router.closeShort(nvda, 1, _swap(address(m.usdg), nvda, 1, 0), alice, past);
        vm.expectRevert(IStocklineRouter.Expired.selector);
        router.addCollateral(nvda, 1, alice, past);
        vm.expectRevert(IStocklineRouter.Expired.selector);
        router.repay(nvda, 1, 0, alice, past);
        vm.expectRevert(IStocklineRouter.Expired.selector);
        router.withdrawCollateral(nvda, 1, alice, past);
        vm.stopPrank();
    }

    function test_RT_exitsRejectUnconfiguredMarkets() public {
        IStocklineRouter.Attestation memory att = _attest(alice);
        vm.startPrank(alice);
        bytes memory notListed = abi.encodeWithSelector(IStocklineRouter.NotListed.selector, UNLISTED);
        vm.expectRevert(notListed);
        router.withdrawLend(UNLISTED, 1, 0, alice, block.timestamp);
        vm.expectRevert(notListed);
        router.closeShort(UNLISTED, 1, _swap(address(m.usdg), nvda, 1, 0), alice, block.timestamp);
        vm.expectRevert(notListed);
        router.addCollateral(UNLISTED, 1, alice, block.timestamp);
        vm.expectRevert(notListed);
        router.repay(UNLISTED, 1, 0, alice, block.timestamp);
        vm.expectRevert(notListed);
        router.withdrawCollateral(UNLISTED, 1, alice, block.timestamp);
        vm.expectRevert(notListed);
        router.openShort(UNLISTED, 1, 1, _swap(nvda, address(m.usdg), 1, 0), false, alice, att, block.timestamp);
        vm.stopPrank();
    }

    function test_RT_zeroAmountsOnExits() public {
        vm.startPrank(alice);
        vm.expectRevert(IStocklineRouter.ZeroAmount.selector);
        router.repay(nvda, 0, 0, alice, block.timestamp); // neither assets nor shares
        vm.expectRevert(IStocklineRouter.ZeroAmount.selector);
        router.withdrawCollateral(nvda, 0, alice, block.timestamp);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ repay by max shares for someone else

    function test_RT_R4_repayAllSharesOnBehalfWithMax() public {
        _open(alice, 5000e6, 10e18);
        vm.warp(block.timestamp + 1 days);
        m.feeds[NVDA].setAnswer(225.66e8);
        m.usdgFeed.setAnswer(1e8);
        m.tokens[NVDA].mint(lender, 20e18);
        uint256 before = IERC20(nvda).balanceOf(lender);
        vm.prank(lender); // a third party repays everything by shares; the rounding excess comes back
        uint256 repaid = router.repay(nvda, 0, type(uint256).max, alice, block.timestamp);
        assertEq(_pos(alice).borrowShares, 0);
        assertEq(before - IERC20(nvda).balanceOf(lender), repaid);
    }

    // ------------------------------------------------------------------ withdrawLend served from idle (LM-R22)

    function test_LM_R22_withdrawLendFromIdleNeedsNoForceDeallocate() public {
        vm.prank(alice);
        uint256 shares = router.lend(nvda, 1e18, 0, alice, block.timestamp); // stays idle (no allocation)
        IVaultV2Min v = IVaultV2Min(ds[NVDA].vault);
        uint256 allocBefore = v.allocation(keccak256(abi.encode("this", ds[NVDA].adapter)));
        vm.prank(alice);
        uint256 out = router.withdrawLend(nvda, shares, 0, alice, block.timestamp);
        assertApproxEqAbs(out, 1e18, 1);
        assertEq(v.allocation(keccak256(abi.encode("this", ds[NVDA].adapter))), allocBefore, "no forceDeallocate");
        vm.prank(alice);
        uint256 more = router.lend(nvda, 1e18, 0, alice, block.timestamp);
        uint256 assets = IVaultV2Min(ds[NVDA].vault).previewRedeem(more);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IStocklineRouter.InsufficientOutput.selector, assets, assets + 1));
        router.withdrawLend(nvda, more, assets + 1, alice, block.timestamp);
    }

    // ------------------------------------------------------------------ closeShort without debt, Transfer-mode swaps

    function test_RT_closeShortWithNoDebtRefundsEverything() public {
        uint256 usdgBefore = IERC20(address(m.usdg)).balanceOf(alice);
        uint256 stockBefore = IERC20(nvda).balanceOf(alice);
        vm.prank(alice);
        uint256 coll = router.closeShort(nvda, 1000e6, _swap(address(m.usdg), nvda, 1000e6, 0), alice, block.timestamp);
        assertEq(coll, 0);
        assertEq(IERC20(address(m.usdg)).balanceOf(alice), usdgBefore - 1000e6);
        assertGt(IERC20(nvda).balanceOf(alice), stockBefore, "bought stock refunded (nothing to repay)");
        assertEq(IERC20(address(m.usdg)).balanceOf(address(router)), 0);
        assertEq(IERC20(nvda).balanceOf(address(router)), 0);
    }

    // RT-R3 Transfer mode is exercised against the real Uniswap UniversalRouter in test/fork/phase1/Router.fork.t.sol
    // (openShort/closeShort through the live pools); coverage runs include the fork suites.

    function test_RT_R3_revertingSwapTargetBubblesItsError() public {
        IStocklineRouter.Swap memory s = _swap(nvda, address(m.usdg), 10e18, 0);
        s.data = abi.encodeWithSignature("doesNotExist()");
        IStocklineRouter.Attestation memory att = _attest(alice);
        vm.prank(alice);
        vm.expectRevert();
        router.openShort(nvda, 5000e6, 10e18, s, false, alice, att, block.timestamp);
    }

    function test_RT_openShortRejectsSwapLargerThanBorrow() public {
        IStocklineRouter.Attestation memory att = _attest(alice);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IStocklineRouter.InsufficientOutput.selector, 10e18, 11e18));
        router.openShort(
            nvda, 5000e6, 10e18, _swap(nvda, address(m.usdg), 11e18, 0), false, alice, att, block.timestamp
        );
    }

    // ------------------------------------------------------------------ approval helpers: failures are ignored

    function test_RT_selfPermitFailureIsIgnored() public {
        vm.prank(alice); // bad signature: the permit reverts inside, selfPermit does not
        router.selfPermit(address(m.usdg), 1e6, block.timestamp, 27, bytes32(uint256(1)), bytes32(uint256(2)));
        vm.prank(alice); // a token without permit at all
        router.selfPermit(address(ds[NVDA].wrapper), 1e6, block.timestamp, 27, bytes32(0), bytes32(0));
    }

    function test_RT_morphoAuthorizeWithSigFailureIsIgnored() public {
        Authorization memory a = Authorization({
            authorizer: alice, authorized: address(router), isAuthorized: true, nonce: 0, deadline: block.timestamp
        });
        Signature memory sig = Signature({v: 27, r: bytes32(uint256(1)), s: bytes32(uint256(2))});
        router.morphoAuthorizeWithSig(a, sig); // invalid signature: Morpho reverts, the router swallows it
        assertTrue(morpho.isAuthorized(alice, address(router)), "unchanged (alice authorized in setUp)");
    }

    // ------------------------------------------------------------------ initialize (RT-R7)

    function test_RT_R7_initializeRejectsZeroOwner() public {
        StocklineRouter impl = new StocklineRouter(m.morpho, address(core.clUSDG));
        vm.expectRevert(IStocklineRouter.ZeroAddress.selector);
        new ERC1967Proxy(address(impl), abi.encodeCall(StocklineRouter.initialize, (address(0), signer.addr, 1)));
    }

    // ------------------------------------------------------------------ admin setters: zero-address guards

    function test_RT_setSwapTargetRejectsZeroAndClUsdg() public {
        vm.startPrank(address(core.timelock));
        vm.expectRevert(IStocklineRouter.ZeroAddress.selector);
        router.setSwapTarget(address(0), IStocklineRouter.SwapMode.Approve);
        vm.expectRevert(IStocklineRouter.ZeroAddress.selector);
        router.setSwapTarget(address(core.clUSDG), IStocklineRouter.SwapMode.Approve);
        vm.stopPrank();
        vm.expectRevert(IStocklineRouter.ZeroAddress.selector);
        new StocklineRouter(m.morpho, address(0));
    }
}
