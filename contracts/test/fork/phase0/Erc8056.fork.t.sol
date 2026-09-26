// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {StockWrapper} from "../../../src/StockWrapper.sol";
import {Phase0ForkBase, IRobinhoodStock, IAccessControlsRegistry} from "./Phase0ForkBase.sol";

/// @notice WS-B.3: ERC-8056 multiplier semantics on the real tokens (A1, LM-R3).
contract Erc8056ForkTest is Phase0ForkBase {
    function test_phase0_erc8056_readFields() public {
        address[3] memory stocks = _stocks();
        for (uint256 i; i < stocks.length; ++i) {
            IRobinhoodStock s = IRobinhoodStock(stocks[i]);
            uint256 m = s.uiMultiplier();
            emit log_named_address("token", stocks[i]);
            emit log_named_decimal_uint("  uiMultiplier", m, 18);
            emit log_named_decimal_uint("  newUIMultiplier", s.newUIMultiplier(), 18);
            emit log_named_uint("  effectiveAt", s.effectiveAt());
            assertGe(m, 1e18, "dividends only raise the multiplier so far");
            // No pending change at the fork block: the scheduled value is already the effective one.
            if (block.timestamp >= s.effectiveAt()) assertEq(m, s.newUIMultiplier());
            StockWrapper w = new StockWrapper(stocks[i], "T", address(0));
            assertEq(w.multiplier(), m, "LM-R3 passthrough");
            assertEq(w.underlyingEquivalent(1e18), m, "1 wrapped unit = m shares");
            assertEq(s.balanceOfUI(stocks[i]), s.balanceOf(stocks[i]) * m / 1e18);
        }
    }

    /// A1: a scheduled multiplier becomes effective at `effectiveAt` with no poke transaction.
    function test_phase0_erc8056_scheduledUpdateTakesEffectWithoutPoke() public {
        IRobinhoodStock s = IRobinhoodStock(NVDA);
        IAccessControlsRegistry registry = IAccessControlsRegistry(REGISTRY);
        assertTrue(registry.hasRole(MULTIPLIER_UPDATER_ROLE, MULTIPLIER_UPDATER), "MULTIPLIER_UPDATER_ROLE holder");
        StockWrapper w = new StockWrapper(NVDA, "NVDA", address(0));

        uint256 before = s.uiMultiplier();
        uint256 next = before * 1003 / 1000; // a +0.3% reinvested dividend
        uint256 at = block.timestamp + 1 hours;
        vm.prank(MULTIPLIER_UPDATER);
        s.updateMultiplier(next, at);

        assertEq(s.uiMultiplier(), before, "not yet effective");
        assertEq(s.newUIMultiplier(), next);
        assertEq(s.effectiveAt(), at);
        assertEq(w.multiplier(), before);

        vm.warp(at - 1);
        assertEq(w.multiplier(), before);
        vm.warp(at); // no transaction in between
        assertEq(s.uiMultiplier(), next, "A1: effective without poke");
        assertEq(w.multiplier(), next, "wrapper sees it in the same block");
        assertEq(w.underlyingEquivalent(1e18), next);
    }

    /// Immediate path (`updateMultiplier(uint256)`) exists too: a step change with no notice.
    function test_phase0_erc8056_immediateUpdateIsAStep() public {
        IRobinhoodStock s = IRobinhoodStock(NVDA);
        uint256 next = s.uiMultiplier() * 4; // e.g. a 4:1 forward split
        vm.prank(MULTIPLIER_UPDATER);
        (bool ok,) = NVDA.call(abi.encodeWithSignature("updateMultiplier(uint256)", next));
        assertTrue(ok);
        assertEq(s.uiMultiplier(), next);
    }
}
