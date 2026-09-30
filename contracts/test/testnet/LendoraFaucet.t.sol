// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {LendoraFaucet} from "../../testnet/LendoraFaucet.sol";
import {MockStockToken} from "../mocks/MockStockToken.sol";
import {MockUSDG} from "../mocks/MockUSDG.sol";
import {MockGate} from "../mocks/MockGate.sol";
import {MockChainlinkAggregator} from "../mocks/MockChainlinkAggregator.sol";

/// @notice Phase 2 task 7: the testnet faucet and the gated mocks (only operators move prices or mint).
contract LendoraFaucetTest is Test {
    LendoraFaucet internal faucet;
    MockStockToken internal nvda;
    MockUSDG internal usdg;
    address internal tester = makeAddr("tester");

    function setUp() public {
        faucet = new LendoraFaucet(address(this), 1 days);
        nvda = new MockStockToken("NVDA", "NVDA", 18);
        usdg = new MockUSDG(6);
        for (uint256 i; i < 2; i++) {
            MockGate g = i == 0 ? MockGate(address(nvda)) : MockGate(address(usdg));
            g.setGated(true);
            g.setOperator(address(faucet), true);
        }
        faucet.setDrip(address(nvda), 10e18);
        faucet.setDrip(address(usdg), 10_000e6);
    }

    function test_faucet_dripsOncePerCooldown() public {
        faucet.claim(tester);
        assertEq(nvda.balanceOf(tester), 10e18);
        assertEq(usdg.balanceOf(tester), 10_000e6);
        vm.expectRevert(abi.encodeWithSelector(LendoraFaucet.TooSoon.selector, block.timestamp + 1 days));
        faucet.claim(tester);
        vm.warp(block.timestamp + 1 days);
        faucet.claim(tester);
        assertEq(nvda.balanceOf(tester), 20e18);
    }

    function test_faucet_ownerSetsDripsAndCooldown() public {
        faucet.setDrip(address(nvda), 5e18); // update in place
        assertEq(faucet.drips().length, 2);
        assertEq(faucet.drips()[0].amount, 5e18);
        faucet.setCooldown(0);
        faucet.claim(tester);
        faucet.claim(tester);
        assertEq(nvda.balanceOf(tester), 10e18);
        vm.prank(tester);
        vm.expectRevert(LendoraFaucet.NotOwner.selector);
        faucet.setDrip(address(nvda), 1);
        vm.prank(tester);
        vm.expectRevert(LendoraFaucet.NotOwner.selector);
        faucet.setCooldown(1);
    }

    function test_gatedMocks_onlyOperatorsMintOrMovePrices() public {
        vm.prank(tester);
        vm.expectRevert(abi.encodeWithSelector(MockGate.NotOperator.selector, tester));
        nvda.mint(tester, 1);
        MockChainlinkAggregator feed = new MockChainlinkAggregator(8, "NVDA");
        feed.setGated(true);
        vm.prank(tester);
        vm.expectRevert(abi.encodeWithSelector(MockGate.NotOperator.selector, tester));
        feed.setAnswer(1e8);
        feed.setOperator(tester, true);
        vm.prank(tester);
        feed.setAnswer(1e8);
        vm.prank(tester);
        vm.expectRevert(abi.encodeWithSelector(MockGate.NotGateAdmin.selector, tester));
        feed.setGated(false);
    }
}
