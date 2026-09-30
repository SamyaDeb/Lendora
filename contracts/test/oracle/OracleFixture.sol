// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {StockWrapper} from "../../src/StockWrapper.sol";
import {MarketHours} from "../../src/MarketHours.sol";
import {IMarketHours} from "../../src/interfaces/IMarketHours.sol";
import {LendoraOracle} from "../../src/oracles/LendoraOracle.sol";
import {LendoraOracleBase} from "../../src/oracles/LendoraOracleBase.sol";
import {ILendoraOracle} from "../../src/interfaces/ILendoraOracle.sol";
import {MockStockToken} from "../mocks/MockStockToken.sol";
import {MockChainlinkAggregator} from "../mocks/MockChainlinkAggregator.sol";
import {MockCollateralToken} from "../mocks/MockCollateralToken.sol";
import {CalendarJson} from "../../script/lib/CalendarJson.sol";

/// @notice NVDA-like stock-loan oracle on the real generated feed calendar (packages/sdk/data/calendar.json), with
/// launch parameters from 10-risk (σ 52%, z 2.5, B_MIN 1%, B_MAX 20%, ramp 4h).
abstract contract OracleFixture is Test {
    // UTC timestamps (computed from the ET calendar; see packages/sdk/scripts/genSessions.ts).
    uint256 internal constant WED_0916_16Z = 1_789_574_400; // Wed 2026-09-16 12:00 ET, open
    uint256 internal constant FRI_0918_16ET = 1_789_761_600; // Fri 16:00 ET = 4h before the freeze
    uint256 internal constant CLOSE_0918 = 1_789_776_000; // Fri 2026-09-18 20:00 ET
    uint256 internal constant OPEN_0920 = 1_789_948_800; // Sun 2026-09-20 20:00 ET
    uint256 internal constant CLOSE_0702 = 1_783_036_800; // Thu 2026-07-02 20:00 ET (Jul 3 holiday)
    uint256 internal constant OPEN_0705 = 1_783_296_000; // Sun 2026-07-05 20:00 ET
    uint256 internal constant CLOSE_0904 = 1_788_566_400; // Fri 2026-09-04 20:00 ET (Labor Day weekend)
    uint256 internal constant OPEN_0907 = 1_788_825_600; // Mon 2026-09-07 20:00 ET
    uint256 internal constant CLOSE_1030 = 1_793_404_800; // Fri 2026-10-30 20:00 EDT
    uint256 internal constant OPEN_1101 = 1_793_581_200; // Sun 2026-11-01 20:00 EST (DST ended that morning)
    uint256 internal constant CLOSE_1125 = 1_795_654_800; // Wed 2026-11-25 20:00 ET (Thanksgiving)
    uint256 internal constant OPEN_1126 = 1_795_741_200; // Thu 2026-11-26 20:00 ET
    uint256 internal constant CLOSE_1127 = 1_795_816_800; // Fri 2026-11-27 17:00 ET (early close, A9)
    uint256 internal constant OPEN_1129 = 1_796_000_400; // Sun 2026-11-29 20:00 ET
    uint256 internal constant CLOSE_0325_27 = 1_806_019_200; // Thu 2027-03-25 20:00 ET (Good Friday)
    uint256 internal constant OPEN_0328_27 = 1_806_278_400; // Sun 2027-03-28 20:00 ET

    uint256 internal constant WAD = 1e18;
    int256 internal constant P0 = 100e8; // NVDA $100 at 8 dp

    MockStockToken internal nvda;
    StockWrapper internal wNVDA;
    MockChainlinkAggregator internal stockFeed;
    MockChainlinkAggregator internal usdgFeed;
    MockCollateralToken internal clUSDG;
    MarketHours internal mh;
    LendoraOracle internal oracle;

    address internal owner = makeAddr("timelock");
    address internal guardian = makeAddr("guardian");
    address internal keeper = makeAddr("keeper");

    function _params() internal pure returns (ILendoraOracle.Params memory) {
        return ILendoraOracle.Params({
            zWad: 2.5e18,
            sigmaWad: 0.52e18,
            bMinWad: 0.01e18,
            bMaxWad: 0.2e18,
            rampIn: 4 hours,
            stockHeartbeat: 86_400,
            usdgHeartbeat: 86_400,
            staleGrace: 10 minutes,
            sequencerGrace: 1 hours,
            bandLowWad: 0.5e18,
            bandHighWad: 2e18,
            maxQuietMultiplierStepWad: 0.05e18
        });
    }

    function _deployment() internal view returns (LendoraOracleBase.Deployment memory) {
        return LendoraOracleBase.Deployment({
            stockFeed: address(stockFeed),
            usdgFeed: address(usdgFeed),
            stockToken: address(nvda),
            wrapper: address(wNVDA),
            marketHours: address(mh),
            owner: owner,
            guardian: guardian,
            keeper: keeper,
            sequencerFeed: address(0),
            blocklist: address(nvda.registry())
        });
    }

    function setUp() public virtual {
        vm.warp(WED_0916_16Z);
        nvda = new MockStockToken("NVIDIA Stock Token", "NVDA", 18);
        wNVDA = new StockWrapper(address(nvda), "NVDA", address(0));
        stockFeed = new MockChainlinkAggregator(8, "RHNVDA / USD");
        usdgFeed = new MockChainlinkAggregator(8, "USDG / USD");
        stockFeed.setAnswer(P0);
        usdgFeed.setAnswer(1e8);
        clUSDG = new MockCollateralToken();

        mh = new MarketHours(owner);
        string memory json = CalendarJson.read();
        IMarketHours.Session[] memory s = CalendarJson.sessions(json);
        vm.prank(owner);
        mh.replaceSessionsFrom(0, s);

        oracle = new LendoraOracle(_deployment(), _params(), address(clUSDG));
    }

    // ------------------------------------------------------------------ helpers

    /// @dev b_full for a closure of `hours_` with the fixture params (SDK-identical math).
    function _full(uint256 seconds_) internal pure returns (uint256) {
        ILendoraOracle.Params memory p = _params();
        uint256 s = _sqrt(seconds_ * 1e36 / (8760 hours));
        uint256 b = uint256(p.zWad) * p.sigmaWad / WAD * s / WAD;
        if (b < p.bMinWad) b = p.bMinWad;
        if (b > p.bMaxWad) b = p.bMaxWad;
        return b;
    }

    function _sqrt(uint256 x) internal pure returns (uint256 y) {
        if (x == 0) return 0;
        y = x;
        uint256 z = (x + 1) / 2;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
    }

    /// @dev Morpho price for feed answer `p` (8 dp), buffer `b`, USDG $1, vpt 1 (scale 1e48).
    function _expectedPrice(uint256 p, uint256 b) internal pure returns (uint256) {
        return 1e18 * 1e8 * 1e48 / (p * (WAD + b));
    }

    function _pushEvent(uint64 start, uint64 end, uint64 bufferWad) internal {
        IMarketHours.EventWindow[] memory e = new IMarketHours.EventWindow[](1);
        e[0] = IMarketHours.EventWindow(start, end, bufferWad);
        uint256 n = mh.eventCount(address(nvda)); // before the prank: an argument call would consume it
        vm.prank(owner);
        mh.replaceEventsFrom(address(nvda), n, e);
    }

    /// @dev Warp and publish a fresh stock round at the new time (USDG refreshed too, it is 24/7).
    function _roundAt(uint256 t, int256 answer) internal {
        vm.warp(t);
        stockFeed.setAnswer(answer);
        usdgFeed.setAnswer(1e8);
    }

    function _warpKeepUsdgFresh(uint256 t) internal {
        vm.warp(t);
        usdgFeed.setAnswer(1e8);
    }
}
