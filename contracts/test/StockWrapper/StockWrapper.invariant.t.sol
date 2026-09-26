// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {StockWrapper} from "../../src/StockWrapper.sol";
import {MockStockToken} from "../mocks/MockStockToken.sol";

/// @notice Drives the wrapper with bounded, always-valid calls from a fixed set of actors and tracks ghost state.
contract StockWrapperHandler is Test {
    StockWrapper public immutable wrapper;
    MockStockToken public immutable stock;

    address[] public actors;
    mapping(address => uint256) public ghostBalance; // expected wrapper balance per actor (LM-R2)
    uint256 public ghostDonated; // underlying sent to the wrapper without `wrap`
    uint256 public ghostMultiplierChanges;

    constructor(StockWrapper wrapper_, MockStockToken stock_) {
        wrapper = wrapper_;
        stock = stock_;
        for (uint256 i; i < 4; i++) {
            address a = makeAddr(string.concat("actor", vm.toString(i)));
            actors.push(a);
            stock.mint(a, 1e30);
            vm.prank(a);
            stock.approve(address(wrapper), type(uint256).max);
        }
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function wrap(uint256 actorSeed, uint256 toSeed, uint256 amount) external {
        address from = _actor(actorSeed);
        address to = _actor(toSeed);
        amount = bound(amount, 1, stock.balanceOf(from) / 4 + 1);
        vm.prank(from);
        wrapper.wrap(amount, to);
        ghostBalance[to] += amount;
    }

    function unwrap(uint256 actorSeed, uint256 toSeed, uint256 amount) external {
        address from = _actor(actorSeed);
        uint256 bal = wrapper.balanceOf(from);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        vm.prank(from);
        wrapper.unwrap(amount, _actor(toSeed));
        ghostBalance[from] -= amount;
    }

    function transfer(uint256 fromSeed, uint256 toSeed, uint256 amount) external {
        address from = _actor(fromSeed);
        address to = _actor(toSeed);
        amount = bound(amount, 0, wrapper.balanceOf(from));
        vm.prank(from);
        wrapper.transfer(to, amount);
        ghostBalance[from] -= amount;
        ghostBalance[to] += amount;
    }

    /// Corporate action: split, reverse split or dividend-in-kind, immediate or scheduled.
    function corporateAction(uint256 m, uint256 delay) external {
        m = bound(m, 0.01e18, 100e18);
        delay = bound(delay, 0, 7 days);
        stock.scheduleUIMultiplier(m, block.timestamp + delay);
        ghostMultiplierChanges++;
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 3 days));
    }

    /// Direct transfer to the wrapper, bypassing `wrap` (the case that makes LM-R7 `>=` rather than `==`).
    function donate(uint256 actorSeed, uint256 amount) external {
        address from = _actor(actorSeed);
        amount = bound(amount, 1, 1e24);
        vm.prank(from);
        stock.transfer(address(wrapper), amount);
        ghostDonated += amount;
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }
}

contract StockWrapperInvariantTest is Test {
    MockStockToken internal stock;
    StockWrapper internal wrapper;
    StockWrapperHandler internal handler;

    function setUp() public {
        stock = new MockStockToken("NVIDIA Stock Token", "NVDA", 18);
        wrapper = new StockWrapper(address(stock), "NVDA", address(0));
        handler = new StockWrapperHandler(wrapper, stock);
        targetContract(address(handler));
    }

    /// LM-R7: every wrapper unit is backed by one raw Stock Token unit held by the wrapper.
    function invariant_LM_R7_fullyBacked() public view {
        assertGe(stock.balanceOf(address(wrapper)), wrapper.totalSupply());
    }

    /// LM-R7 exact form: the only surplus is what was sent without `wrap`.
    function invariant_LM_R7_backingEqualsSupplyPlusDonations() public view {
        assertEq(stock.balanceOf(address(wrapper)), wrapper.totalSupply() + handler.ghostDonated());
    }

    /// LM-R2: balances match transfer/mint/burn bookkeeping regardless of any multiplier changes.
    function invariant_LM_R2_balancesOnlyMoveByTransferMintBurn() public view {
        uint256 sum;
        for (uint256 i; i < handler.actorCount(); i++) {
            address a = handler.actors(i);
            assertEq(wrapper.balanceOf(a), handler.ghostBalance(a));
            sum += wrapper.balanceOf(a);
        }
        assertEq(sum, wrapper.totalSupply());
    }

    /// LM-R3: the wrapper always reports the token's effective multiplier.
    function invariant_LM_R3_multiplierPassThrough() public view {
        assertEq(wrapper.multiplier(), stock.uiMultiplier());
    }
}
