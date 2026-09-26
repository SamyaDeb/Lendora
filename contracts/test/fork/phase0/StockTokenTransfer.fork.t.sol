// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IMorpho, MarketParams, Id} from "morpho-blue/src/interfaces/IMorpho.sol";
import {MarketParamsLib} from "morpho-blue/src/libraries/MarketParamsLib.sol";
import {StockWrapper} from "../../../src/StockWrapper.sol";
import {Phase0ForkBase, IRobinhoodStock} from "./Phase0ForkBase.sol";

/// @notice WS-B.1: real Stock Tokens move exactly into an EOA, a fresh `StockWrapper` and Morpho Blue (A2, LM-R1).
contract StockTokenTransferForkTest is Phase0ForkBase {
    using MarketParamsLib for MarketParams;

    uint256 internal constant AMOUNT = 3.141592653589793238e18; // odd amount to catch rounding or fees

    function test_phase0_stockTokens_transferExactToEoaWrapperAndMorpho() public {
        address[3] memory stocks = _stocks();
        for (uint256 i; i < stocks.length; ++i) {
            _checkStock(IRobinhoodStock(stocks[i]));
        }
    }

    function _checkStock(IRobinhoodStock stock) internal {
        assertEq(stock.decimals(), 18, "A2: decimals");
        assertFalse(stock.paused(), "token paused at fork block");

        address alice = makeAddr("alice");
        address bob = makeAddr("bob");
        uint256 supplyBefore = stock.totalSupply();
        // Stock uses OZ ERC-7201 namespaced ERC20 storage; stdstore finds the balance slot. adjust=true keeps
        // totalSupply consistent. The assertions below prove the dealt balance behaves like a real one.
        deal(address(stock), alice, 4 * AMOUNT, true);
        assertEq(stock.balanceOf(alice), 4 * AMOUNT, "deal failed");
        assertEq(stock.totalSupply(), supplyBefore + 4 * AMOUNT, "totalSupply not adjusted");

        // (a) EOA → EOA, exact.
        vm.prank(alice);
        stock.transfer(bob, AMOUNT);
        assertEq(stock.balanceOf(bob), AMOUNT, "(a) EOA received != sent");
        assertEq(stock.balanceOf(alice), 3 * AMOUNT);

        // (b) into a freshly deployed StockWrapper: wrap() itself reverts unless exactly AMOUNT arrives (LM-R1).
        StockWrapper wrapper = new StockWrapper(address(stock), "TEST", address(0));
        vm.startPrank(alice);
        stock.approve(address(wrapper), AMOUNT);
        uint256 minted = wrapper.wrap(AMOUNT, alice);
        vm.stopPrank();
        assertEq(minted, AMOUNT);
        assertEq(stock.balanceOf(address(wrapper)), AMOUNT, "(b) wrapper received != sent");
        assertEq(wrapper.totalSupply(), stock.balanceOf(address(wrapper)), "LM-R7 equality");
        assertEq(wrapper.multiplier(), stock.uiMultiplier(), "LM-R3 passthrough");

        _checkMorpho(stock, wrapper, alice, bob);
    }

    function _checkMorpho(IRobinhoodStock stock, StockWrapper wrapper, address alice, address bob) internal {
        // (c) into Morpho Blue via supply: raw Stock Token into an idle market (irm 0 / lltv 0, both enabled), and
        // the wrapped token into its own idle market.
        IMorpho morpho = IMorpho(MORPHO);
        MarketParams memory rawIdle = MarketParams(address(stock), address(0), address(0), address(0), 0);
        MarketParams memory wrappedIdle = MarketParams(address(wrapper), address(0), address(0), address(0), 0);
        if (morpho.market(rawIdle.id()).lastUpdate == 0) morpho.createMarket(rawIdle);
        morpho.createMarket(wrappedIdle);

        uint256 morphoRawBefore = stock.balanceOf(MORPHO);
        vm.startPrank(alice);
        stock.approve(MORPHO, AMOUNT);
        (uint256 suppliedRaw,) = morpho.supply(rawIdle, AMOUNT, 0, alice, "");
        IERC20(address(wrapper)).approve(MORPHO, AMOUNT);
        (uint256 suppliedWrapped,) = morpho.supply(wrappedIdle, AMOUNT, 0, alice, "");
        vm.stopPrank();
        assertEq(suppliedRaw, AMOUNT);
        assertEq(stock.balanceOf(MORPHO) - morphoRawBefore, AMOUNT, "(c) Morpho received raw != sent");
        assertEq(IERC20(address(wrapper)).balanceOf(MORPHO), AMOUNT, "(c) Morpho received wrapped != sent");
        assertEq(suppliedWrapped, AMOUNT);

        // Out again: withdraw the wrapped supply and unwrap to an EOA.
        vm.startPrank(alice);
        morpho.withdraw(wrappedIdle, AMOUNT, 0, alice, alice);
        morpho.withdraw(rawIdle, AMOUNT, 0, alice, alice);
        uint256 out = wrapper.unwrap(AMOUNT, bob);
        vm.stopPrank();
        assertEq(out, AMOUNT);
        assertEq(stock.balanceOf(bob), 2 * AMOUNT, "unwrap to EOA != sent");
        assertEq(stock.balanceOf(alice), 2 * AMOUNT);
        assertEq(stock.balanceOf(address(wrapper)), 0);
        assertEq(wrapper.totalSupply(), 0);
    }
}
