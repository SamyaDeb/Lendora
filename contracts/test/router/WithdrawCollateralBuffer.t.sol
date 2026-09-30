// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {IMorpho, MarketParams, Position} from "morpho-blue/src/interfaces/IMorpho.sol";
import {MarketParamsLib} from "morpho-blue/src/libraries/MarketParamsLib.sol";
import {StocklineRouter} from "../../src/StocklineRouter.sol";
import {IStocklineRouter} from "../../src/interfaces/IStocklineRouter.sol";
import {LocalStockline} from "../utils/LocalStockline.sol";

/// T10 / residual (e) in 05 §1: `withdrawCollateral` is an exit with no RT-R1 check, so a borrower with debt can
/// withdraw down to Morpho's LLTV at today's price, below the 24h weekend/earnings buffer.
///
/// `test_T10_residualE_*` documents today's behaviour (passes). `test_T10_proposed_*` is the regression test for the
/// proposed router change (docs/proposals/T10-withdraw-collateral-buffer.md): it fails on the deployed router, so it
/// is skipped until the owner approves the upgrade through the timelock.
/// forge-config: default.isolate = true
/// forge-config: ci.isolate = true
contract WithdrawCollateralBufferTest is LocalStockline {
    using MarketParamsLib for MarketParams;

    uint256 internal constant NVDA = 1;
    uint256 internal constant FRIDAY_1600_ET = 1_789_761_600; // at t + 24h the 9.6% weekend buffer is in force
    address internal lender = makeAddr("lender");
    address internal alice = makeAddr("alice");
    address internal nvdaToken;
    IMorpho internal morpho;
    StocklineRouter internal router;

    function setUp() public override {
        super.setUp();
        nvdaToken = address(m.tokens[NVDA]);
        morpho = IMorpho(m.morpho);
        router = core.router;
        _onboard(lender, 1000e18, 0);
        _onboard(alice, 100e18, 1_000_000e6);
        _lendAndAllocate(NVDA, lender, 500e18);
        // Friday 16:00 ET; fresh feeds at the fixture prices.
        vm.warp(FRIDAY_1600_ET);
        m.feeds[NVDA].setAnswer(225.66e8);
        m.usdgFeed.setAnswer(1e8);
        // A healthy position: $5,000 of clUSDG against 10 NVDA ($2,256.60), HF(t + 24h) well above 1.10.
        IStocklineRouter.Attestation memory att = _attest(alice);
        vm.prank(alice);
        router.borrow(nvdaToken, 5000e6, 10e18, alice, att, block.timestamp);
    }

    function _pos(address who) internal view returns (Position memory) {
        return morpho.position(ds[NVDA].market.id(), who);
    }

    function _hfNow() internal view returns (uint256) {
        return router.healthFactorAt(nvdaToken, alice, block.timestamp);
    }

    function _hf24() internal view returns (uint256) {
        return router.healthFactorAt(nvdaToken, alice, block.timestamp + router.HORIZON());
    }

    /// Collateral to withdraw so that HF now ends at `targetHfNow` (HF is linear in collateral).
    function _withdrawTo(uint256 targetHfNow) internal view returns (uint256) {
        uint256 coll = _pos(alice).collateral;
        uint256 keep = (coll * targetHfNow + _hfNow() - 1) / _hfNow();
        return coll - keep;
    }

    /// Today: Morpho and the router accept a withdrawal to HF 1.03 on a Friday afternoon; tomorrow the weekend buffer
    /// makes the position liquidatable (HF at t + 24h < 1.0, far below RT-R1's 1.10).
    function test_T10_residualE_withdrawLeavesHfAt24hBelowBuffer() public {
        assertGe(_hf24(), router.HF_MIN_OPEN(), "opened within RT-R1");
        uint256 amount = _withdrawTo(1.03e18);
        vm.prank(alice);
        router.withdrawCollateral(nvdaToken, amount, alice, block.timestamp);
        assertGt(_pos(alice).borrowShares, 0, "debt remains");
        emit log_named_decimal_uint("HF now", _hfNow(), 18);
        emit log_named_decimal_uint("HF t+24h", _hf24(), 18);
        assertGe(_hfNow(), 1e18, "Morpho: healthy at today's price");
        assertLt(_hf24(), router.HF_MIN_OPEN(), "below the 24h buffer");
        assertLt(_hf24(), 1e18, "liquidatable once the weekend buffer is in force");
    }

    /// Proposed (T10): `withdrawCollateral` with debt left requires HF(now + 24h) >= 1.0; a full exit at zero debt,
    /// and a withdrawal that keeps HF(t + 24h) >= 1.0, stay free.
    function test_T10_proposed_withdrawCollateralChecksHfAt24h() public {
        vm.skip(true, "T10: expected to fail until the router upgrade (owner's call, 24h timelock)");
        uint256 tooMuch = _withdrawTo(1.03e18);
        vm.prank(alice);
        vm.expectRevert(); // HealthTooLow(hf at t + 24h)
        router.withdrawCollateral(nvdaToken, tooMuch, alice, block.timestamp);

        // A smaller withdrawal that keeps HF(t + 24h) >= 1.0 still passes.
        uint256 ok = _withdrawTo(1.3e18);
        vm.prank(alice);
        router.withdrawCollateral(nvdaToken, ok, alice, block.timestamp);
        assertGe(_hf24(), 1e18);

        // Zero debt: the full exit needs no check.
        vm.prank(alice);
        router.repay(nvdaToken, 0, type(uint256).max, alice, block.timestamp);
        vm.prank(alice);
        router.withdrawCollateral(nvdaToken, type(uint256).max, alice, block.timestamp);
        assertEq(_pos(alice).collateral, 0);
    }
}
