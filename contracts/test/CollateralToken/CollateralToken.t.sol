// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {IMorpho, MarketParams} from "morpho-blue/src/interfaces/IMorpho.sol";
import {CollateralToken} from "../../src/CollateralToken.sol";
import {ICollateralToken} from "../../src/interfaces/ICollateralToken.sol";
import {MockUSDG} from "../mocks/MockUSDG.sol";
import {MockStockToken} from "../mocks/MockStockToken.sol";
import {MorphoDeployer} from "../utils/MorphoDeployer.sol";

contract CollateralTokenTest is Test {
    MockUSDG internal usdg;
    CollateralToken internal cl;
    address internal morpho = makeAddr("morpho");
    address internal router = makeAddr("router");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        usdg = new MockUSDG(6);
        cl = new CollateralToken(address(usdg), morpho, "Lendora Collateral USDG", "clUSDG");
        cl.setRouter(router);
        usdg.mint(router, 1_000_000e6);
        vm.prank(router);
        usdg.approve(address(cl), type(uint256).max);
    }

    function _mint(address to, uint256 amount) internal {
        vm.prank(router);
        cl.mint(to, amount);
    }

    // ------------------------------------------------------------------ CL-R1 backing, decimals

    function test_CL_R1_backingAndMetadata() public view {
        assertEq(cl.backing(), address(usdg));
        assertEq(cl.morpho(), morpho);
        assertEq(cl.router(), router);
        assertEq(cl.decimals(), 6);
        assertEq(cl.symbol(), "clUSDG");
    }

    function test_CL_R1_constructorRejectsZero() public {
        vm.expectRevert(ICollateralToken.ZeroAddress.selector);
        new CollateralToken(address(0), morpho, "x", "x");
        vm.expectRevert(ICollateralToken.ZeroAddress.selector);
        new CollateralToken(address(usdg), address(0), "x", "x");
    }

    function test_CL_R2_routerSetOnceByDeployer() public {
        CollateralToken c = new CollateralToken(address(usdg), morpho, "x", "x");
        vm.prank(alice);
        vm.expectRevert(ICollateralToken.NotDeployer.selector);
        c.setRouter(router);
        vm.expectRevert(ICollateralToken.ZeroAddress.selector);
        c.setRouter(address(0));
        vm.prank(router);
        vm.expectRevert(ICollateralToken.NotRouter.selector); // no router yet
        c.mint(alice, 1);
        c.setRouter(router);
        vm.expectRevert(ICollateralToken.RouterAlreadySet.selector);
        c.setRouter(alice);
    }

    // ------------------------------------------------------------------ CL-R2 mint / unwrap

    function test_CL_R2_onlyRouterMints1to1() public {
        vm.expectEmit(address(cl));
        emit ICollateralToken.Minted(alice, 100e6);
        _mint(alice, 100e6);
        assertEq(cl.balanceOf(alice), 100e6);
        assertEq(usdg.balanceOf(address(cl)), 100e6);
        vm.prank(alice);
        vm.expectRevert(ICollateralToken.NotRouter.selector);
        cl.mint(alice, 1);
        vm.startPrank(router);
        vm.expectRevert(ICollateralToken.ZeroAmount.selector);
        cl.mint(alice, 0);
        vm.expectRevert(ICollateralToken.ZeroAddress.selector);
        cl.mint(address(0), 1);
        vm.stopPrank();
    }

    function test_CL_R2_R5_anyHolderUnwrapsAnytime() public {
        _mint(alice, 100e6);
        vm.prank(alice);
        uint256 out = cl.unwrap(40e6, bob);
        assertEq(out, 40e6);
        assertEq(usdg.balanceOf(bob), 40e6);
        assertEq(cl.totalSupply(), 60e6);
        vm.startPrank(alice);
        vm.expectRevert(ICollateralToken.ZeroAmount.selector);
        cl.unwrap(0, bob);
        vm.expectRevert(ICollateralToken.ZeroAddress.selector);
        cl.unwrap(1, address(0));
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, alice, 60e6, 61e6));
        cl.unwrap(61e6, alice);
        vm.stopPrank();
    }

    function test_CL_R2_mintRejectsShortDelivery() public {
        MockStockToken feeToken = new MockStockToken("fee", "FEE", 6);
        feeToken.setTransferFeeBps(10);
        CollateralToken c = new CollateralToken(address(feeToken), morpho, "x", "x");
        c.setRouter(router);
        feeToken.mint(router, 1000e6);
        vm.startPrank(router);
        feeToken.approve(address(c), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(ICollateralToken.UnexpectedTransferAmount.selector, 1000e6, 999e6));
        c.mint(alice, 1000e6);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ CL-R3 transfer rule

    function test_CL_R3_onlyMorphoOrRouterTransfers() public {
        _mint(alice, 100e6);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ICollateralToken.TransferNotAllowed.selector, alice, bob));
        cl.transfer(bob, 1);

        vm.prank(alice);
        cl.transfer(morpho, 10e6); // supply collateral directly (soft gate: existing holders)
        vm.prank(morpho);
        cl.transfer(bob, 5e6); // seized to a liquidator / withdrawn to anyone
        vm.prank(alice);
        cl.transfer(router, 1e6);
        vm.prank(router);
        cl.transfer(bob, 1e6);
        assertEq(cl.balanceOf(bob), 6e6);

        vm.prank(bob);
        cl.approve(alice, 6e6);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ICollateralToken.TransferNotAllowed.selector, bob, alice));
        cl.transferFrom(bob, alice, 1);
        vm.prank(alice);
        cl.transferFrom(bob, morpho, 1); // to Morpho is fine
    }

    function test_CL_R3_beforeRouterSetOnlyMorphoMoves() public {
        CollateralToken c = new CollateralToken(address(usdg), morpho, "x", "x");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ICollateralToken.TransferNotAllowed.selector, alice, bob));
        c.transfer(bob, 0);
    }

    // ------------------------------------------------------------------ CL-R4 value

    function test_CL_R4_valuePerTokenIsOneForUsdg() public view {
        assertEq(cl.valuePerToken(), 1e18);
    }

    // ------------------------------------------------------------------ Morpho integration (LM-R12 path)

    /// On the real Morpho Blue: collateral goes in from the router, is seized by a liquidator (from Morpho), and the
    /// liquidator unwraps to USDG. Nothing about the transfer rule blocks the standard liquidation path.
    function test_CL_R3_worksAsMorphoCollateralAndLiquidatorCanUnwrap() public {
        IMorpho m = MorphoDeployer.deploy(address(this));
        CollateralToken c = new CollateralToken(address(usdg), address(m), "clUSDG", "clUSDG");
        c.setRouter(router);
        vm.prank(router);
        usdg.approve(address(c), type(uint256).max);
        MarketParams memory mp = MarketParams(address(usdg), address(c), address(0), address(0), 0);
        m.enableIrm(address(0));
        m.enableLltv(0);
        m.createMarket(mp);
        vm.startPrank(router);
        c.mint(router, 50e6);
        c.approve(address(m), type(uint256).max);
        m.supplyCollateral(mp, 50e6, alice, "");
        vm.stopPrank();
        assertEq(c.balanceOf(address(m)), 50e6);
        vm.prank(alice);
        m.withdrawCollateral(mp, 50e6, alice, bob); // Morpho → bob
        vm.prank(bob);
        c.unwrap(50e6, bob);
        assertEq(usdg.balanceOf(bob), 50e6);
    }
}
