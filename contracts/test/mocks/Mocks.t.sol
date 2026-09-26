// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {MockStockToken} from "./MockStockToken.sol";
import {MockChainlinkAggregator} from "./MockChainlinkAggregator.sol";
import {MockUSDG} from "./MockUSDG.sol";
import {MockSwapAggregator} from "./MockSwapAggregator.sol";
import {MockAccessControlsRegistry} from "./MockAccessControlsRegistry.sol";
import {MockSequencerUptimeFeed} from "./MockSequencerUptimeFeed.sol";
import {MockUniswapV3Pool} from "./MockUniswapV3Pool.sol";

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

    // ------------------------------------------------ D10 R5: issuer powers with live signatures and errors

    function test_mockStock_tokenPauseBlocksTransferApproveButNotAdminBurn() public {
        nvda.pause();
        assertTrue(nvda.paused());
        assertTrue(nvda.tokenPaused());
        vm.startPrank(alice);
        vm.expectRevert(MockStockToken.IsPaused.selector);
        nvda.transfer(bob, 1);
        vm.expectRevert(MockStockToken.IsPaused.selector);
        nvda.approve(bob, 1);
        vm.stopPrank();
        vm.expectRevert(MockStockToken.IsPaused.selector);
        nvda.transferFrom(alice, bob, 1);
        vm.expectRevert(MockStockToken.IsPaused.selector);
        nvda.updateMultiplier(2e18);
        nvda.adminBurn(alice, 1e18); // no pause check
        assertEq(nvda.balanceOf(alice), 99e18);
        nvda.unpause();
        assertFalse(nvda.paused());
        vm.prank(alice);
        nvda.transfer(bob, 1);
    }

    function test_mockStock_globalPauseViaSharedRegistry() public {
        MockAccessControlsRegistry shared = new MockAccessControlsRegistry();
        MockStockToken spy = new MockStockToken("SPY", "SPY", 18);
        nvda.setRegistry(shared);
        spy.setRegistry(shared);
        assertEq(nvda.ACCESS_CONTROLLED_REGISTRY(), address(shared));
        shared.pause();
        assertTrue(nvda.paused() && spy.paused());
        assertFalse(nvda.tokenPaused(), "global pause is not the per-token flag");
        vm.prank(alice);
        vm.expectRevert(MockStockToken.IsPaused.selector);
        nvda.transfer(bob, 1);
        shared.unpause();
        assertFalse(spy.paused());
    }

    function test_mockStock_blocklistRevertsLikeLiveToken() public {
        MockAccessControlsRegistry reg = nvda.registry();
        address[] memory list = new address[](1);
        list[0] = bob;
        reg.blockAccounts(list);
        assertTrue(reg.isBlocked(bob));
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(MockStockToken.Blocked.selector, bob));
        nvda.transfer(bob, 1);
        vm.expectRevert(abi.encodeWithSelector(MockStockToken.Blocked.selector, bob));
        nvda.approve(bob, 1);
        vm.stopPrank();
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(MockStockToken.Blocked.selector, bob)); // from ok, then `to` fails
        nvda.transferFrom(alice, bob, 1);
        reg.unblockAccounts(list);
        vm.prank(alice);
        nvda.transfer(bob, 1);
        assertEq(nvda.balanceOf(bob), 1);
    }

    function test_mockStock_blockedSenderAndSpenderInTransferFrom() public {
        vm.prank(alice);
        nvda.approve(bob, 10);
        nvda.registry().setBlocked(bob, true);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(MockStockToken.Blocked.selector, bob));
        nvda.transferFrom(alice, address(this), 1);
        nvda.registry().setBlocked(bob, false);
        vm.prank(bob);
        nvda.transferFrom(alice, address(this), 1);
    }

    function test_mockStock_permitVersionOneAndBlocklist() public {
        (uint256 pk, address owner) = (0xB0B, vm.addr(0xB0B));
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                owner,
                bob,
                5,
                0,
                block.timestamp
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", nvda.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        nvda.registry().setBlocked(bob, true);
        vm.expectRevert(abi.encodeWithSelector(MockStockToken.Blocked.selector, bob));
        nvda.permit(owner, bob, 5, block.timestamp, v, r, s);
        nvda.registry().setBlocked(bob, false);
        nvda.permit(owner, bob, 5, block.timestamp, v, r, s);
        assertEq(nvda.allowance(owner, bob), 5);
        (, string memory name, string memory version,,,,) = nvda.eip712Domain();
        assertEq(name, "NVIDIA Stock Token");
        assertEq(version, "1");
    }

    function test_mockStock_oraclePauseFlag() public {
        assertFalse(nvda.oraclePaused());
        vm.expectEmit(address(nvda));
        emit MockStockToken.OraclePaused();
        nvda.pauseOracle();
        assertTrue(nvda.oraclePaused());
        nvda.unpauseOracle();
        assertFalse(nvda.oraclePaused());
    }

    function test_mockStock_liveUpdateMultiplierOverloads() public {
        nvda.updateMultiplier(4e18); // immediate: a step with no notice
        assertEq(nvda.uiMultiplier(), 4e18);
        nvda.updateMultiplier(8e18, block.timestamp + 1 hours);
        assertEq(nvda.uiMultiplier(), 4e18);
        vm.warp(block.timestamp + 1 hours);
        assertEq(nvda.uiMultiplier(), 8e18);
        vm.expectRevert(MockStockToken.EffectiveInPast.selector);
        nvda.updateMultiplier(1e18, block.timestamp - 1);
    }
}

contract MockSequencerUptimeFeedTest is Test {
    function test_mockSequencer_statusAndRevert() public {
        vm.warp(1_700_000_000);
        MockSequencerUptimeFeed feed = new MockSequencerUptimeFeed();
        (, int256 answer, uint256 startedAt,,) = feed.latestRoundData();
        assertEq(answer, 0);
        assertEq(startedAt, block.timestamp);
        assertEq(feed.decimals(), 0);
        feed.setStatus(true, block.timestamp - 10);
        (uint80 id, int256 a2, uint256 s2,,) = feed.latestRoundData();
        assertEq(id, 2);
        assertEq(a2, 1);
        assertEq(s2, block.timestamp - 10);
        feed.setReverts(true);
        vm.expectRevert(MockSequencerUptimeFeed.MockFeedReverted.selector);
        feed.latestRoundData();
    }
}

contract MockUniswapV3PoolTest is Test {
    function test_mockPool_observeIntegratesTicks() public {
        vm.warp(1_700_000_000);
        MockUniswapV3Pool pool = new MockUniswapV3Pool(address(1), address(2), 500, 100);
        assertEq(pool.fee(), 500);
        assertEq(pool.token0(), address(1));
        vm.warp(block.timestamp + 600);
        pool.setTick(200);
        pool.setTick(300); // same timestamp overwrites the tick
        vm.warp(block.timestamp + 1200);
        (, int24 tick,,,,,) = pool.slot0();
        assertEq(tick, 300);

        uint32[] memory ago = new uint32[](3);
        ago[0] = 1800; // start
        ago[1] = 1200; // the change
        ago[2] = 0;
        (int56[] memory cum,) = pool.observe(ago);
        assertEq(cum[0], 0);
        assertEq(cum[1], 100 * 600);
        assertEq(cum[2], 100 * 600 + 300 * 1200);
        // 30-min TWAP tick = (cum now - cum 30m ago) / 1800
        assertEq((cum[2] - cum[0]) / 1800, 233);

        ago[0] = 1801;
        vm.expectRevert(MockUniswapV3Pool.OLD.selector);
        pool.observe(ago);
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
