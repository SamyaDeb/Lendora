// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {StockWrapper} from "../../../src/StockWrapper.sol";
import {IStockWrapper} from "../../../src/interfaces/IStockWrapper.sol";
import {BlocklistHolderAllowlist} from "../../../src/adapters/BlocklistHolderAllowlist.sol";
import {Phase1ForkBase} from "./Phase1ForkBase.sol";
import {IAccessControlsRegistry} from "../phase0/Phase0ForkBase.sol";

/// @notice LM-R6 (D10 R3) on the live registry: the adapter mirrors `isBlocked`, and a wrapper built with it rejects a
/// blocklisted recipient with its own error before touching the token. Also LM-R8 on a real Stock Token.
contract BlocklistHolderAllowlistForkTest is Phase1ForkBase {
    BlocklistHolderAllowlist internal adapter;
    StockWrapper internal wrapper;
    address internal holder = makeAddr("holder");
    address internal recipient = makeAddr("recipient");

    function setUp() public override {
        super.setUp();
        adapter = new BlocklistHolderAllowlist(REGISTRY);
        wrapper = new StockWrapper(NVDA, "NVDA", address(adapter));
        deal(NVDA, holder, 10e18, true);
        vm.startPrank(holder);
        IERC20(NVDA).approve(address(wrapper), type(uint256).max);
        wrapper.wrap(10e18, holder);
        vm.stopPrank();
    }

    function test_LM_R6_fork_adapterMirrorsLiveBlocklist() public {
        assertTrue(adapter.isAllowed(recipient));
        address[] memory list = new address[](1);
        list[0] = recipient;
        vm.prank(BLOCKER);
        IAccessControlsRegistry(REGISTRY).blockAccounts(list);
        assertFalse(adapter.isAllowed(recipient));

        vm.prank(holder);
        vm.expectRevert(abi.encodeWithSelector(IStockWrapper.RecipientNotAllowed.selector, recipient));
        wrapper.unwrap(1e18, recipient);

        vm.prank(holder);
        wrapper.unwrap(1e18, holder); // the holder itself is not blocked
        assertEq(IERC20(NVDA).balanceOf(holder), 1e18);
    }

    function test_LM_R8_fork_adminBurnShowsShortfall() public {
        assertEq(wrapper.backingShortfall(), 0);
        vm.prank(ADMIN_BURNER);
        (bool ok,) = NVDA.call(abi.encodeWithSignature("adminBurn(address,uint256)", address(wrapper), 3e18));
        assertTrue(ok, "adminBurn");
        assertEq(wrapper.backingShortfall(), 3e18);
    }
}
