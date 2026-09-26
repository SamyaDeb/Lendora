// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {MockStockToken} from "./MockStockToken.sol";
import {MockChainlinkAggregator} from "./MockChainlinkAggregator.sol";
import {MockUSDG} from "./MockUSDG.sol";
import {MockSwapAggregator} from "./MockSwapAggregator.sol";

/// @notice The mocks are test infrastructure for every later task, so their knobs are tested too.
contract MockStockTokenTest is Test {
    MockStockToken internal nvda;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        nvda = new MockStockToken("NVIDIA Stock Token", "NVDA", 18);
        nvda.mint(alice, 100e18);
    }

    function test_mockStock_multiplierDefaultsToOne() public view {
        assertEq(nvda.uiMultiplier(), 1e18);
        assertEq(nvda.balanceOfUI(alice), 100e18);
    }

    function test_mockStock_scheduledMultiplierAppliesAtEffectiveAt() public {
        uint256 at = block.timestamp + 1 days;
        nvda.scheduleUIMultiplier(10e18, at); // 10:1 split
        assertEq(nvda.uiMultiplier(), 1e18);
        vm.warp(at - 1);
        assertEq(nvda.uiMultiplier(), 1e18);
        vm.warp(at);
        assertEq(nvda.uiMultiplier(), 10e18);
        assertEq(nvda.balanceOfUI(alice), 1000e18);
        assertEq(nvda.balanceOf(alice), 100e18, "raw balance unchanged");
    }

    function test_mockStock_scheduleAfterEffectiveSettlesPrevious() public {
        nvda.scheduleUIMultiplier(2e18, block.timestamp + 1);
        vm.warp(block.timestamp + 2);
        nvda.scheduleUIMultiplier(3e18, block.timestamp + 10);
        assertEq(nvda.uiMultiplier(), 2e18);
        nvda.cancelUIMultiplierUpdate();
        vm.warp(block.timestamp + 100);
        assertEq(nvda.uiMultiplier(), 2e18);
    }

    function test_mockStock_allowlistBlocksUnlistedRecipient() public {
        nvda.setAllowlistEnabled(true);
        nvda.setAllowed(alice, true);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(MockStockToken.NotAllowed.selector, bob));
        nvda.transfer(bob, 1e18);
        assertFalse(nvda.isAllowed(bob));
        nvda.setAllowed(bob, true);
        vm.prank(alice);
        nvda.transfer(bob, 1e18);
        assertEq(nvda.balanceOf(bob), 1e18);
    }

    function test_mockStock_feeOnTransfer() public {
        nvda.setTransferFeeBps(100);
        vm.prank(alice);
        nvda.transfer(bob, 10e18);
        assertEq(nvda.balanceOf(bob), 9.9e18);
    }

    function test_mockStock_configurableDecimals() public {
        assertEq(new MockStockToken("x", "x", 6).decimals(), 6);
    }
}

contract MockChainlinkAggregatorTest is Test {
    MockChainlinkAggregator internal feed;

    function setUp() public {
        vm.warp(1_700_000_000);
        feed = new MockChainlinkAggregator(8, "NVDA / USD");
    }

    function test_mockFeed_noDataBeforeFirstAnswer() public {
        vm.expectRevert(MockChainlinkAggregator.NoDataPresent.selector);
        feed.latestRoundData();
    }

    function test_mockFeed_roundsAndTimestamps() public {
        feed.setAnswer(100e8);
        feed.setAnswerAt(101e8, block.timestamp - 3 hours);
        (uint80 id, int256 answer,, uint256 updatedAt, uint80 answeredIn) = feed.latestRoundData();
        assertEq(id, 2);
        assertEq(answer, 101e8);
        assertEq(updatedAt, block.timestamp - 3 hours);
        assertEq(answeredIn, 2);
        (, answer,, updatedAt,) = feed.getRoundData(1);
        assertEq(answer, 100e8);
        assertEq(updatedAt, block.timestamp);

        feed.setUpdatedAt(123);
        (,,, updatedAt,) = feed.latestRoundData();
        assertEq(updatedAt, 123);
        assertEq(feed.decimals(), 8);
    }

    function test_mockFeed_zeroAndNegativeAnswers() public {
        feed.setAnswer(0);
        (, int256 answer,,,) = feed.latestRoundData();
        assertEq(answer, 0);
        feed.setAnswer(-1);
        (, answer,,,) = feed.latestRoundData();
        assertEq(answer, -1);
    }

    function test_mockFeed_revertMode() public {
        feed.setAnswer(1e8);
        feed.setReverts(true);
        vm.expectRevert(MockChainlinkAggregator.MockFeedReverted.selector);
        feed.latestRoundData();
    }
}

contract MockSwapAggregatorTest is Test {
    MockSwapAggregator internal dex;
    MockUSDG internal usdg;
    MockStockToken internal nvda;
    address internal user = makeAddr("user");

    function setUp() public {
        dex = new MockSwapAggregator();
        usdg = new MockUSDG(6);
        nvda = new MockStockToken("NVDA", "NVDA", 18);
        // 1 NVDA (1e18 raw) = 100 USDG (100e6 raw) → rate = 100e6 * 1e18 / 1e18 = 100e6
        dex.setRate(address(nvda), address(usdg), 100e6);
        usdg.mint(address(dex), 1_000_000e6);
        nvda.mint(user, 10e18);
        vm.prank(user);
        nvda.approve(address(dex), type(uint256).max);
    }

    function test_mockDex_swapAtRate() public {
        vm.prank(user);
        uint256 out = dex.swap(address(nvda), address(usdg), 2e18, 200e6, user);
        assertEq(out, 200e6);
        assertEq(usdg.balanceOf(user), 200e6);
        assertEq(nvda.balanceOf(user), 8e18);
    }

    function test_mockDex_slippageReverts() public {
        dex.setFeeBps(50);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(MockSwapAggregator.InsufficientOutput.selector, 199e6, 200e6));
        dex.swap(address(nvda), address(usdg), 2e18, 200e6, user);
    }

    function test_mockDex_partialFillRefundsInput() public {
        dex.setFillFraction(0.5e18);
        vm.prank(user);
        dex.swap(address(nvda), address(usdg), 2e18, 0, user);
        assertEq(nvda.balanceOf(user), 9e18);
        assertEq(usdg.balanceOf(user), 100e6);
    }

    function test_mockDex_canLieAboutOutput() public {
        dex.setReportedAmountOut(1000e6);
        vm.prank(user);
        uint256 reported = dex.swap(address(nvda), address(usdg), 1e18, 0, user);
        assertEq(reported, 1000e6);
        assertEq(usdg.balanceOf(user), 100e6);
    }

    function test_mockDex_unknownPairReverts() public {
        vm.expectRevert(MockSwapAggregator.NoRate.selector);
        dex.quote(address(usdg), address(nvda), 1);
    }
}

contract MockUSDGTest is Test {
    function test_mockUsdg_decimalsAndPermit() public {
        MockUSDG usdg = new MockUSDG(6);
        assertEq(usdg.decimals(), 6);
        assertEq(usdg.symbol(), "USDG");
        (uint256 pk, address owner) = (0xA11CE, vm.addr(0xA11CE));
        address spender = makeAddr("spender");
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                usdg.DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                        owner,
                        spender,
                        5e6,
                        0,
                        block.timestamp
                    )
                )
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        usdg.permit(owner, spender, 5e6, block.timestamp, v, r, s);
        assertEq(usdg.allowance(owner, spender), 5e6);
    }
}
