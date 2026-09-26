// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IMorpho, MarketParams} from "morpho-blue/src/interfaces/IMorpho.sol";
import {MarketParamsLib} from "morpho-blue/src/libraries/MarketParamsLib.sol";
import {StockWrapper} from "../../../src/StockWrapper.sol";
import {Phase0ForkBase, IRobinhoodStock, IAccessControlsRegistry} from "./Phase0ForkBase.sol";

/// @notice WS-B.2 (risk finding, not pass/fail): what issuer admin powers do to wrapped balances and to Morpho.
/// Each test impersonates a live role holder on the fork only. Assertions record the observed behavior.
contract StockTokenAdminForkTest is Phase0ForkBase {
    using MarketParamsLib for MarketParams;

    IRobinhoodStock internal stock;
    IAccessControlsRegistry internal registry;
    StockWrapper internal wrapper;
    MarketParams internal idle;
    address internal lender = makeAddr("lender");
    address internal holder = makeAddr("holder");

    function setUp() public override {
        super.setUp();
        stock = IRobinhoodStock(NVDA);
        registry = IAccessControlsRegistry(stock.ACCESS_CONTROLLED_REGISTRY());
        assertEq(address(registry), REGISTRY);
        wrapper = new StockWrapper(NVDA, "NVDA", address(0));
        idle = MarketParams(address(wrapper), address(0), address(0), address(0), 0);
        IMorpho(MORPHO).createMarket(idle);

        deal(NVDA, lender, 10e18, true);
        deal(NVDA, holder, 10e18, true);
        vm.startPrank(lender);
        stock.approve(address(wrapper), type(uint256).max);
        wrapper.wrap(10e18, lender);
        IERC20(address(wrapper)).approve(MORPHO, type(uint256).max);
        IMorpho(MORPHO).supply(idle, 6e18, 0, lender, "");
        vm.stopPrank();
    }

    function _blockAccount(address a) internal {
        assertTrue(registry.hasRole(BLOCKER_ROLE, BLOCKER), "BLOCKER_ROLE holder changed");
        address[] memory list = new address[](1);
        list[0] = a;
        vm.prank(BLOCKER);
        registry.blockAccounts(list);
        assertTrue(registry.isBlocked(a));
    }

    /// Blocklisting the wrapper freezes the backing: nobody can unwrap or wrap, but wrapper units (and Morpho
    /// positions denominated in them) keep moving.
    function test_phase0_admin_blocklistWrapper() public {
        _blockAccount(address(wrapper));

        vm.prank(lender);
        vm.expectRevert(abi.encodeWithSignature("Blocked(address)", address(wrapper)));
        wrapper.unwrap(1e18, lender);

        vm.prank(holder); // approve checks the spender against the blocklist too, so wrap cannot even start
        vm.expectRevert(abi.encodeWithSignature("Blocked(address)", address(wrapper)));
        stock.approve(address(wrapper), 1e18);

        // Wrapped balances and Morpho accounting are untouched; wrapped units still transfer and withdraw.
        assertEq(IERC20(address(wrapper)).balanceOf(lender), 4e18);
        vm.startPrank(lender);
        IMorpho(MORPHO).withdraw(idle, 1e18, 0, lender, lender);
        IERC20(address(wrapper)).transfer(holder, 1e18);
        vm.stopPrank();
        assertEq(stock.balanceOf(address(wrapper)), 10e18, "backing is frozen in place, not seized");
    }

    function test_phase0_admin_blocklistRecipient() public {
        _blockAccount(holder);
        vm.prank(lender);
        vm.expectRevert(abi.encodeWithSignature("Blocked(address)", holder));
        wrapper.unwrap(1e18, holder); // LM-R6: the token itself reverts with a clear error
    }

    /// Blocklisting Morpho Blue only matters for markets whose loan or collateral is the raw Stock Token. Stockline
    /// markets hold wrapper units, so they are unaffected; the wrapper is the single choke point.
    function test_phase0_admin_blocklistMorpho_doesNotTouchWrappedMarkets() public {
        _blockAccount(MORPHO);
        vm.prank(lender);
        IMorpho(MORPHO).withdraw(idle, 1e18, 0, lender, lender);
        assertEq(IERC20(address(wrapper)).balanceOf(lender), 5e18);
    }

    /// Per-token pause: every transfer, approve and permit reverts, so wrap and unwrap stop. Wrapped units still move.
    function test_phase0_admin_tokenPause() public {
        assertTrue(registry.hasRole(TOKEN_PAUSER_ROLE, TOKEN_PAUSER), "TOKEN_PAUSER_ROLE holder changed");
        vm.prank(TOKEN_PAUSER);
        stock.pause();
        assertTrue(stock.paused());

        vm.prank(lender);
        vm.expectRevert(abi.encodeWithSignature("IsPaused()"));
        wrapper.unwrap(1e18, lender);

        vm.prank(lender);
        IMorpho(MORPHO).withdraw(idle, 1e18, 0, lender, lender);
    }

    /// Global pause on the registry pauses every Stock Token at once.
    function test_phase0_admin_globalPause() public {
        assertTrue(registry.hasRole(PAUSER_ROLE, GLOBAL_PAUSER), "PAUSER_ROLE holder changed");
        vm.prank(GLOBAL_PAUSER);
        registry.pause();
        assertTrue(IRobinhoodStock(SPY).paused());
        assertTrue(IRobinhoodStock(AAPL).paused());
        assertTrue(stock.paused());
        assertFalse(stock.tokenPaused(), "global pause is not the per-token flag");

        vm.prank(lender);
        vm.expectRevert(abi.encodeWithSignature("IsPaused()"));
        wrapper.unwrap(1e18, lender);
    }

    /// `adminBurn` has no pause or blocklist check and can burn the wrapper's backing. That breaks LM-R7's
    /// "at all times" invariant: the last unwrappers cannot exit.
    function test_phase0_admin_adminBurnFromWrapper_breaksLMR7() public {
        assertTrue(registry.hasRole(ADMIN_BURNER_ROLE, ADMIN_BURNER), "ADMIN_BURNER_ROLE holder changed");
        vm.prank(ADMIN_BURNER);
        stock.adminBurn(address(wrapper), 3e18);

        assertLt(stock.balanceOf(address(wrapper)), wrapper.totalSupply(), "LM-R7 no longer holds");
        assertEq(stock.balanceOf(address(wrapper)), 7e18);

        vm.prank(lender);
        wrapper.unwrap(4e18, lender); // first out is whole

        vm.prank(lender);
        IMorpho(MORPHO).withdraw(idle, 6e18, 0, lender, lender);
        vm.prank(lender);
        vm.expectRevert(); // ERC20InsufficientBalance: 3 wrapper units have no backing left
        wrapper.unwrap(6e18, lender);
    }
}
