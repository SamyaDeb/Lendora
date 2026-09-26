// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {IMorpho, MarketParams} from "morpho-blue/src/interfaces/IMorpho.sol";
import {StockWrapper} from "../../src/StockWrapper.sol";
import {IStockWrapper} from "../../src/interfaces/IStockWrapper.sol";
import {MockStockToken} from "../mocks/MockStockToken.sol";
import {MorphoDeployer} from "../utils/MorphoDeployer.sol";

contract StockWrapperTest is Test {
    MockStockToken internal nvda;
    StockWrapper internal wNVDA;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal liquidator = makeAddr("liquidator");

    function setUp() public {
        nvda = new MockStockToken("NVIDIA Stock Token", "NVDA", 18);
        wNVDA = new StockWrapper(address(nvda), "NVDA", address(0));
        nvda.mint(alice, 1000e18);
        vm.prank(alice);
        nvda.approve(address(wNVDA), type(uint256).max);
    }

    function _wrap(address from, uint256 amount, address to) internal returns (uint256) {
        vm.prank(from);
        return wNVDA.wrap(amount, to);
    }

    // ------------------------------------------------------------------ LM-R1: 1:1 wrap / unwrap on raw units

    function test_LM_R1_wrapMintsOneToOneOnRawAmount() public {
        vm.expectEmit(address(wNVDA));
        emit IStockWrapper.Wrapped(alice, bob, 10e18);
        uint256 minted = _wrap(alice, 10e18, bob);

        assertEq(minted, 10e18);
        assertEq(wNVDA.balanceOf(bob), 10e18);
        assertEq(nvda.balanceOf(alice), 990e18);
        assertEq(nvda.balanceOf(address(wNVDA)), 10e18);
    }

    function test_LM_R1_wrapIgnoresMultiplier() public {
        nvda.setUIMultiplier(10e18); // 10:1 split already in effect
        _wrap(alice, 10e18, alice);
        assertEq(wNVDA.balanceOf(alice), 10e18, "minted on raw units, not UI units");
    }

    function test_LM_R1_unwrapBurnsAndReturnsRaw() public {
        _wrap(alice, 10e18, alice);
        vm.expectEmit(address(wNVDA));
        emit IStockWrapper.Unwrapped(alice, bob, 4e18);
        vm.prank(alice);
        uint256 out = wNVDA.unwrap(4e18, bob);

        assertEq(out, 4e18);
        assertEq(wNVDA.balanceOf(alice), 6e18);
        assertEq(wNVDA.totalSupply(), 6e18);
        assertEq(nvda.balanceOf(bob), 4e18);
    }

    function testFuzz_LM_R1_roundTripIsLossless(uint256 amount, uint256 m) public {
        amount = bound(amount, 1, 1000e18);
        m = bound(m, 1, 1000e18);
        nvda.setUIMultiplier(m);
        _wrap(alice, amount, alice);
        vm.prank(alice);
        wNVDA.unwrap(amount, alice);
        assertEq(nvda.balanceOf(alice), 1000e18);
        assertEq(wNVDA.totalSupply(), 0);
    }

    function test_LM_R1_zeroAmountAndZeroAddressRevert() public {
        vm.startPrank(alice);
        vm.expectRevert(IStockWrapper.ZeroAmount.selector);
        wNVDA.wrap(0, alice);
        vm.expectRevert(IStockWrapper.ZeroAddress.selector);
        wNVDA.wrap(1, address(0));
        wNVDA.wrap(1, alice);
        vm.expectRevert(IStockWrapper.ZeroAmount.selector);
        wNVDA.unwrap(0, alice);
        vm.expectRevert(IStockWrapper.ZeroAddress.selector);
        wNVDA.unwrap(1, address(0));
        vm.stopPrank();
    }

    function test_LM_R1_unwrapMoreThanBalanceReverts() public {
        _wrap(alice, 1e18, alice);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, bob, 0, 1e18));
        wNVDA.unwrap(1e18, bob);
    }

    /// A2: a fee-on-transfer (or otherwise short-delivering) underlying must not mint unbacked units.
    function test_LM_R1_revertsIfUnderlyingDeliversLess() public {
        nvda.setTransferFeeBps(10);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IStockWrapper.UnexpectedTransferAmount.selector, 10e18, 9.99e18));
        wNVDA.wrap(10e18, alice);
    }

    function test_constructor_rejectsZeroUnderlying() public {
        vm.expectRevert(IStockWrapper.ZeroAddress.selector);
        new StockWrapper(address(0), "NVDA", address(0));
    }

    // ------------------------------------------------------------------ LM-R2: balances only move by
    // transfer/mint/burn

    function test_LM_R2_corporateActionLeavesBalancesUnchanged() public {
        _wrap(alice, 100e18, alice);
        _wrap(alice, 50e18, bob);

        nvda.scheduleUIMultiplier(0.25e18, block.timestamp + 1 days); // 1:4 reverse split
        vm.warp(block.timestamp + 1 days);

        assertEq(wNVDA.multiplier(), 0.25e18);
        assertEq(wNVDA.balanceOf(alice), 100e18);
        assertEq(wNVDA.balanceOf(bob), 50e18);
        assertEq(wNVDA.totalSupply(), 150e18);
    }

    /// LM-R2 in the setting it exists for: Morpho accounting in wNVDA is unaffected by a corporate action.
    function test_LM_R2_morphoPositionUnaffectedByMultiplierChange() public {
        address owner = makeAddr("morphoOwner");
        IMorpho morpho = MorphoDeployer.deploy(owner);
        vm.startPrank(owner);
        morpho.enableIrm(address(0));
        morpho.enableLltv(0);
        vm.stopPrank();
        MarketParams memory idle = MarketParams({
            loanToken: address(wNVDA), collateralToken: address(0), oracle: address(0), irm: address(0), lltv: 0
        });
        morpho.createMarket(idle);

        _wrap(alice, 100e18, alice);
        vm.startPrank(alice);
        wNVDA.approve(address(morpho), type(uint256).max);
        (, uint256 shares) = morpho.supply(idle, 100e18, 0, alice, "");
        vm.stopPrank();

        nvda.setUIMultiplier(1.02e18); // 2% dividend paid via the multiplier

        vm.prank(alice);
        (uint256 assetsOut,) = morpho.withdraw(idle, 0, shares, alice, alice);
        assertEq(assetsOut, 100e18, "same wrapped units back");
        assertEq(wNVDA.underlyingEquivalent(assetsOut), 102e18, "worth 2% more stock");
    }

    // ------------------------------------------------------------------ LM-R3: multiplier pass-through

    function test_LM_R3_multiplierPassesThrough() public {
        assertEq(wNVDA.multiplier(), 1e18);
        nvda.setUIMultiplier(3e18);
        assertEq(wNVDA.multiplier(), 3e18);
    }

    function test_LM_R3_scheduledMultiplierPickedUpInSameBlock() public {
        uint256 at = block.timestamp + 3 days;
        nvda.scheduleUIMultiplier(2e18, at);
        vm.warp(at - 1);
        assertEq(wNVDA.multiplier(), 1e18);
        vm.warp(at);
        assertEq(wNVDA.multiplier(), 2e18);
    }

    function test_LM_R3_underlyingEquivalent() public {
        nvda.setUIMultiplier(1.5e18);
        assertEq(wNVDA.underlyingEquivalent(10e18), 15e18);
        nvda.setUIMultiplier(333_333_333_333_333_333); // ~1/3
        assertEq(wNVDA.underlyingEquivalent(1), 0, "rounds down");
        assertEq(wNVDA.underlyingEquivalent(3e18), 999_999_999_999_999_999);
    }

    function testFuzz_LM_R3_underlyingEquivalentMatchesMulDivDown(uint256 amount, uint256 m) public {
        amount = bound(amount, 0, type(uint128).max);
        m = bound(m, 0, type(uint128).max);
        nvda.setUIMultiplier(m);
        assertEq(wNVDA.underlyingEquivalent(amount), amount * m / 1e18);
        assertEq(wNVDA.underlyingEquivalent(amount), nvda.toUIAmount(amount), "matches the token's own conversion");
    }

    // ------------------------------------------------------------------ LM-R4: metadata

    function test_LM_R4_nameSymbolDecimals() public view {
        assertEq(wNVDA.name(), "Wrapped Stockline NVDA");
        assertEq(wNVDA.symbol(), "wNVDA");
        assertEq(wNVDA.decimals(), 18);
        assertEq(wNVDA.underlying(), address(nvda));
    }

    function testFuzz_LM_R4_decimalsFollowUnderlying(uint8 dec) public {
        MockStockToken t = new MockStockToken("SPDR", "SPY", dec);
        StockWrapper w = new StockWrapper(address(t), "SPY", address(0));
        assertEq(w.decimals(), dec);
        assertEq(w.symbol(), "wSPY");
    }

    // ------------------------------------------------------------------ LM-R5: no admin, anyone can unwrap

    function test_LM_R5_anyHolderCanUnwrap() public {
        _wrap(alice, 10e18, alice);
        vm.prank(alice);
        wNVDA.transfer(liquidator, 7e18); // e.g. seized and passed along
        vm.prank(liquidator);
        wNVDA.unwrap(7e18, liquidator);
        assertEq(nvda.balanceOf(liquidator), 7e18);
    }

    function test_LM_R5_noAdminSurface() public {
        bytes4[8] memory adminSelectors = [
            bytes4(keccak256("owner()")),
            bytes4(keccak256("pause()")),
            bytes4(keccak256("paused()")),
            bytes4(keccak256("upgradeToAndCall(address,bytes)")),
            bytes4(keccak256("proxiableUUID()")),
            bytes4(keccak256("transferOwnership(address)")),
            bytes4(keccak256("grantRole(bytes32,address)")),
            bytes4(keccak256("rescue(address,address,uint256)"))
        ];
        for (uint256 i; i < adminSelectors.length; i++) {
            (bool ok,) = address(wNVDA).call(abi.encodeWithSelector(adminSelectors[i]));
            assertFalse(ok);
        }
        // Not a proxy: the EIP-1967 implementation slot is empty.
        assertEq(vm.load(address(wNVDA), 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc), 0);
    }

    // ------------------------------------------------------------------ LM-R6: issuer allowlist

    function _allowlistedSetup() internal returns (StockWrapper w) {
        w = new StockWrapper(address(nvda), "NVDA", address(nvda)); // the mock token is its own adapter
        nvda.setAllowlistEnabled(true);
        nvda.setAllowed(alice, true);
        nvda.setAllowed(address(w), true); // LM-R6: the wrapper must be allowlisted
        vm.prank(alice);
        nvda.approve(address(w), type(uint256).max);
        vm.prank(alice);
        w.wrap(10e18, alice);
    }

    function test_LM_R6_unwrapToNotAllowedRecipientRevertsClearly() public {
        StockWrapper w = _allowlistedSetup();
        assertEq(w.holderAllowlist(), address(nvda));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IStockWrapper.RecipientNotAllowed.selector, bob));
        w.unwrap(1e18, bob);
    }

    function test_LM_R6_unwrapToAllowedRecipientWorks() public {
        StockWrapper w = _allowlistedSetup();
        nvda.setAllowed(bob, true);
        vm.prank(alice);
        w.unwrap(1e18, bob);
        assertEq(nvda.balanceOf(bob), 1e18);
    }

    /// A non-allowlisted holder of wrapper units (e.g. a liquidator) can still exit to an allowed address.
    function test_LM_R6_nonAllowedHolderCanUnwrapToAllowedAddress() public {
        StockWrapper w = _allowlistedSetup();
        vm.prank(alice);
        w.transfer(liquidator, 2e18);
        vm.prank(liquidator);
        w.unwrap(2e18, alice);
        assertEq(nvda.balanceOf(alice), 992e18);
    }

    function test_LM_R6_wrapperNotAllowlistedCannotWrap() public {
        StockWrapper w = new StockWrapper(address(nvda), "NVDA", address(nvda));
        nvda.setAllowlistEnabled(true);
        nvda.setAllowed(alice, true);
        vm.startPrank(alice);
        nvda.approve(address(w), 1e18);
        vm.expectRevert(abi.encodeWithSelector(MockStockToken.NotAllowed.selector, address(w)));
        w.wrap(1e18, alice);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ LM-R7: backing (unit-level; see invariant
    // suite)

    function test_LM_R7_directTransferIsStrandedNotMinted() public {
        _wrap(alice, 10e18, alice);
        vm.prank(alice);
        nvda.transfer(address(wNVDA), 5e18);
        assertEq(wNVDA.totalSupply(), 10e18);
        assertEq(nvda.balanceOf(address(wNVDA)), 15e18);
        // A later wrap still mints exactly what it receives; the donation does not leak into it.
        _wrap(alice, 1e18, bob);
        assertEq(wNVDA.balanceOf(bob), 1e18);
    }
}
