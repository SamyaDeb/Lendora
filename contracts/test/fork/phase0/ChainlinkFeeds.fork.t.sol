// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {AggregatorV3Interface} from "../../../src/interfaces/external/AggregatorV3Interface.sol";
import {Phase0ForkBase, IRobinhoodStock} from "./Phase0ForkBase.sol";

/// @notice WS-B.5: Chainlink feeds for the launch stocks and USDG/USD (OR-R4, OR-R13, PRD issues 1, 3, 4).
contract ChainlinkFeedsForkTest is Phase0ForkBase {
    function _check(address feed, string memory desc, address token) internal {
        AggregatorV3Interface f = AggregatorV3Interface(feed);
        assertEq(f.decimals(), 8, "decimals");
        assertEq(f.description(), desc, "description");
        (uint80 id, int256 answer,, uint256 updatedAt, uint80 answeredIn) = f.latestRoundData();
        assertGt(answer, 0);
        assertEq(id, answeredIn);
        assertLe(updatedAt, block.timestamp);
        emit log_named_string("feed", desc);
        emit log_named_decimal_int("  answer", answer, 8);
        emit log_named_uint("  age (s)", block.timestamp - updatedAt);
        emit log_named_uint("  round (phase-encoded)", id);
        if (token != address(0)) {
            // PRD issue 4: the advisory pause flag lives on the token, not on the feed.
            emit log_named_string("  oraclePaused()", IRobinhoodStock(token).oraclePaused() ? "true" : "false");
            emit log_named_decimal_uint("  uiMultiplier", IRobinhoodStock(token).uiMultiplier(), 18);
        }
    }

    function test_phase0_chainlink_latestRoundData() public {
        _check(FEED_SPY, "RHSPY / USD", SPY);
        _check(FEED_NVDA, "RHNVDA / USD", NVDA);
        _check(FEED_AAPL, "Robinhood AAPL / USD", AAPL);
        _check(FEED_USDG, "USDG / USD", address(0));
    }

    /// PRD issue 3: Chainlink lists no L2 Sequencer Uptime Feed for Robinhood Chain (docs.chain.link/data-feeds/
    /// l2-sequencer-feeds, read 2026-09-26). The Arbitrum One uptime feed address has no code here.
    function test_phase0_chainlink_noSequencerUptimeFeed() public view {
        assertEq(address(0xFdB631F5EE196F0ed6FAa767959853A9F217697D).code.length, 0);
    }
}
