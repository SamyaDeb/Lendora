// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {FeeConverter} from "../../src/fees/FeeConverter.sol";
import {IFeeConverter} from "../../src/interfaces/IFeeConverter.sol";
import {IVaultV2Min} from "../../src/interfaces/external/IMorphoVaultV2.sol";
import {IStocklineOracle} from "../../src/interfaces/IStocklineOracle.sol";
import {MockSwapAggregator} from "../mocks/MockSwapAggregator.sol";
import {MockChainlinkAggregator} from "../mocks/MockChainlinkAggregator.sol";
import {MockStockToken} from "../mocks/MockStockToken.sol";
import {MockUSDG} from "../mocks/MockUSDG.sol";
import {LocalStockline} from "../utils/LocalStockline.sol";

/// @notice Drives a live FeeConverter (full local deployment) with random conversions, DEX rates, price moves,
/// donations and calls from non-keepers.
contract FeeConverterHandler is Test {
    FeeConverter internal immutable conv;
    address internal immutable vault;
    MockStockToken internal immutable stock;
    MockUSDG internal immutable usdg;
    MockSwapAggregator internal immutable dex;
    MockChainlinkAggregator internal immutable feed;
    address internal immutable keeper;
    address public immutable attacker = makeAddr("attacker");

    uint256 public converted; // USDG the destination received from successful conversions
    uint256 public conversions;
    uint256 public floorBreaches; // a conversion that paid less than the onchain floor at its time
    uint256 public attackerSuccesses;
    uint256 public donatedUsdg;
    uint256 public donatedStock;

    constructor(
        FeeConverter conv_,
        address vault_,
        MockStockToken stock_,
        MockUSDG usdg_,
        MockSwapAggregator dex_,
        MockChainlinkAggregator feed_,
        address keeper_
    ) {
        conv = conv_;
        vault = vault_;
        stock = stock_;
        usdg = usdg_;
        dex = dex_;
        feed = feed_;
        keeper = keeper_;
    }

    function _answer() internal view returns (int256 a) {
        (, a,,,) = feed.latestRoundData();
    }

    function _swap(uint256 amountIn) internal view returns (IFeeConverter.Swap memory) {
        return IFeeConverter.Swap({
            target: address(dex),
            data: abi.encodeCall(MockSwapAggregator.swap, (address(stock), address(usdg), amountIn, 0, address(conv)))
        });
    }

    /// Keeper converts a random share of the balance, with a random minimum and a DEX paying 95%–105% of the oracle.
    function convert(uint256 frac, uint256 minBps, uint256 dexBps) external {
        uint256 bal = IERC20(vault).balanceOf(address(conv));
        uint256 shares = bal * bound(frac, 1, 100) / 100;
        if (shares == 0) return;
        uint256 stockIn = IVaultV2Min(vault).previewRedeem(shares);
        if (stockIn == 0) return;
        (uint256 value, uint256 floor) = conv.quote(vault, stockIn);
        uint256 rate = uint256(_answer()) * 1e6 / 1e8 * bound(dexBps, 9500, 10_500) / 10_000;
        dex.setRate(address(stock), address(usdg), rate);
        uint256 minOut = value * bound(minBps, 9800, 10_000) / 10_000;
        uint256 before = usdg.balanceOf(conv.destination());
        vm.prank(keeper);
        try conv.convert(vault, shares, minOut, _swap(stockIn)) returns (uint256 out) {
            uint256 got = usdg.balanceOf(conv.destination()) - before;
            if (got != out || out < floor || out < minOut) floorBreaches++;
            converted += got;
            conversions++;
        } catch {}
    }

    uint256 public honestAttempts;
    uint256 public honestFailures;
    bytes public lastHonestError;

    /// Liveness: a DEX paying at least the oracle value, with `minOut` = the onchain floor, always converts while the
    /// gates are open (market hours, guard clear).
    function convertAtOracle(uint256 frac, uint256 dexBps) external {
        uint256 shares = IERC20(vault).balanceOf(address(conv)) * bound(frac, 1, 100) / 100;
        if (shares == 0) return;
        uint256 stockIn = IVaultV2Min(vault).previewRedeem(shares);
        if (stockIn == 0) return;
        // Only while the gates are open: a long random walk can take the feed past the oracle's ×0.5–×2 sanity
        // band,
        // which trips the guard; conversion is then refused by design (tested in FeeConverter.t.sol).
        if (IStocklineOracle(conv.oracleOf(vault)).guardReasons() != 0) return;
        (, uint256 floor) = conv.quote(vault, stockIn);
        dex.setRate(
            address(stock), address(usdg), uint256(_answer()) * 1e6 / 1e8 * bound(dexBps, 10_000, 10_500) / 10_000
        );
        uint256 before = usdg.balanceOf(conv.destination());
        honestAttempts++;
        vm.prank(keeper);
        try conv.convert(vault, shares, floor, _swap(stockIn)) returns (uint256 out) {
            if (out < floor) floorBreaches++;
            converted += usdg.balanceOf(conv.destination()) - before;
            conversions++;
        } catch (bytes memory err) {
            honestFailures++;
            lastHonestError = err;
        }
    }

    /// Anyone but the keeper: every path must revert.
    function attack(uint256 frac, uint256 minOut) external {
        uint256 shares = IERC20(vault).balanceOf(address(conv)) * bound(frac, 1, 100) / 100;
        if (shares == 0) return;
        vm.prank(attacker);
        try conv.convert(vault, shares, minOut, _swap(IVaultV2Min(vault).previewRedeem(shares))) {
            attackerSuccesses++;
        } catch {}
    }

    /// The feed moves up to ±10% (the guard's deviation threshold stays out of scope here).
    function movePrice(uint256 bps) external {
        int256 p = _answer();
        feed.setAnswer(p * int256(bound(bps, 9000, 11_000)) / 10_000);
    }

    /// Donations of USDG or stock to the converter are never converted or swept by the keeper.
    function donate(uint256 amt, bool isUsdg) external {
        amt = bound(amt, 1, 1e12);
        if (isUsdg) {
            usdg.mint(address(conv), amt);
            donatedUsdg += amt;
        } else {
            stock.mint(address(conv), amt);
            donatedStock += amt;
        }
    }
}

/// @notice FE-R4 invariants (Phase 3 task 10, audit round 2): the keeper can only trigger; value leaves the converter
/// only to the owner-set destination; no conversion pays below the onchain 1% floor; nothing is stranded.
/// `FOUNDRY_PROFILE=deep` for 1,000 × 1,000 calls.
contract FeeConverterInvariantTest is LocalStockline {
    uint256 internal constant NVDA = 1;
    FeeConverter internal conv;
    FeeConverterHandler internal h;
    address internal keeper = makeAddr("feeKeeper");
    address internal treasury = makeAddr("treasuryMultisig");

    function setUp() public override {
        super.setUp();
        address vault = ds[NVDA].vault;
        conv = new FeeConverter(address(this), address(m.usdg), treasury, keeper);
        conv.setVault(vault, address(ds[NVDA].oracle));
        conv.setSwapTarget(address(m.dex), IFeeConverter.SwapMode.Approve);
        // Converter holds fee shares; idle covers every redemption (no allocation).
        address lender = makeAddr("lender");
        _onboard(lender, 1000e18, 0);
        vm.startPrank(lender);
        core.router.lend(address(_tok(NVDA)), 500e18, 0, lender, block.timestamp);
        IERC20(vault).transfer(address(conv), IERC20(vault).balanceOf(lender));
        vm.stopPrank();
        m.usdg.mint(address(m.dex), 1e18);
        h = new FeeConverterHandler(conv, vault, _tok(NVDA), m.usdg, m.dex, m.feeds[NVDA], keeper);
        targetContract(address(h));
    }

    function invariant_FE_R4_keeperAndOthersNeverReceiveValue() public view {
        for (uint256 i; i < 2; i++) {
            address a = i == 0 ? keeper : h.attacker();
            assertEq(IERC20(address(m.usdg)).balanceOf(a), 0);
            assertEq(IERC20(address(_tok(NVDA))).balanceOf(a), 0);
            assertEq(IERC20(ds[NVDA].vault).balanceOf(a), 0);
        }
        assertEq(h.attackerSuccesses(), 0, "only the keeper can convert");
    }

    /// Not vacuous: every run converts something.
    function afterInvariant() public view {
        if (h.honestAttempts() > 0) assertGt(h.conversions(), 0, "not vacuous: something was converted");
    }

    function invariant_FE_R4_conversionAtTheFloorAlwaysGoesThrough() public {
        if (h.honestFailures() != 0) emit log_named_bytes("revert", h.lastHonestError());
        assertEq(h.honestFailures(), 0, "a conversion meeting the floor reverted while the gates were open");
    }

    function invariant_FE_R4_neverBelowTheOnchainFloor() public view {
        assertEq(h.floorBreaches(), 0);
    }

    function invariant_FE_R4_usdgOnlyToDestinationAndNothingStranded() public view {
        assertEq(IERC20(address(m.usdg)).balanceOf(treasury), h.converted(), "destination got exactly the conversions");
        assertEq(IERC20(address(m.usdg)).balanceOf(address(conv)), h.donatedUsdg(), "no conversion USDG left behind");
        assertEq(IERC20(address(_tok(NVDA))).balanceOf(address(conv)), h.donatedStock(), "no stock left behind");
        assertEq(IERC20(address(ds[NVDA].wrapper)).balanceOf(address(conv)), 0, "no wSTOCK left behind");
        assertEq(IERC20(address(_tok(NVDA))).allowance(address(conv), address(m.dex)), 0, "approval reset");
    }
}

