// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockStockToken} from "../../mocks/MockStockToken.sol";
import {Phase1ForkBase} from "./Phase1ForkBase.sol";
import {IRobinhoodStock, IAccessControlsRegistry} from "../phase0/Phase0ForkBase.sol";

/// @notice D10 R5: the extended `MockStockToken` reverts with the same errors, in the same order, as the live token.
/// Each case runs on the live NVDA token (impersonating role holders on the fork) and on the mock.
contract MockParityForkTest is Phase1ForkBase {
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function _live() internal returns (IRobinhoodStock t) {
        t = IRobinhoodStock(NVDA);
        deal(NVDA, alice, 10e18, true);
    }

    function test_mockParity_pausedTransferReverts() public {
        IRobinhoodStock live = _live();
        vm.prank(TOKEN_PAUSER);
        live.pause();
        vm.prank(alice);
        vm.expectRevert(MockStockToken.IsPaused.selector);
        live.transfer(bob, 1);

        MockStockToken mock = new MockStockToken("m", "m", 18);
        mock.mint(alice, 10e18);
        mock.pause();
        vm.prank(alice);
        vm.expectRevert(MockStockToken.IsPaused.selector);
        mock.transfer(bob, 1);
    }

    function test_mockParity_blockedRecipientReverts() public {
        IRobinhoodStock live = _live();
        address[] memory list = new address[](1);
        list[0] = bob;
        vm.prank(BLOCKER);
        IAccessControlsRegistry(REGISTRY).blockAccounts(list);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(MockStockToken.Blocked.selector, bob));
        live.transfer(bob, 1);

        MockStockToken mock = new MockStockToken("m", "m", 18);
        mock.mint(alice, 10e18);
        mock.registry().setBlocked(bob, true);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(MockStockToken.Blocked.selector, bob));
        mock.transfer(bob, 1);
    }

    function test_mockParity_adminBurnIgnoresPauseAndBlocklist() public {
        IRobinhoodStock live = _live();
        vm.prank(TOKEN_PAUSER);
        live.pause();
        vm.prank(ADMIN_BURNER);
        live.adminBurn(alice, 1e18);
        assertEq(IERC20(NVDA).balanceOf(alice), 9e18);

        MockStockToken mock = new MockStockToken("m", "m", 18);
        mock.mint(alice, 10e18);
        mock.pause();
        mock.registry().setBlocked(alice, true);
        mock.adminBurn(alice, 1e18);
        assertEq(mock.balanceOf(alice), 9e18);
    }

    function test_mockParity_viewSurface() public {
        IRobinhoodStock live = _live();
        MockStockToken mock = new MockStockToken("m", "m", 18);
        // Same selectors answer on both (reverts would fail the test).
        live.oraclePaused();
        live.tokenPaused();
        live.paused();
        assertEq(live.ACCESS_CONTROLLED_REGISTRY(), REGISTRY);
        mock.oraclePaused();
        mock.tokenPaused();
        mock.paused();
        assertTrue(mock.ACCESS_CONTROLLED_REGISTRY() != address(0));
    }
}
