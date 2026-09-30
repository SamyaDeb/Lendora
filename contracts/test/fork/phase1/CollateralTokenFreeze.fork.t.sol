// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IMorpho, MarketParams} from "morpho-blue/src/interfaces/IMorpho.sol";
import {CollateralToken} from "../../../src/CollateralToken.sol";
import {Phase1ForkBase} from "./Phase1ForkBase.sol";

interface IPaxosUsdg {
    function grantRole(bytes32 role, address account) external;
    function hasRole(bytes32 role, address account) external view returns (bool);
    function defaultAdmin() external view returns (address);
    function freeze(address account) external;
    function unfreeze(address account) external;
    function wipeFrozenAddress(address account) external;
    function isFrozen(address account) external view returns (bool);
}

/// @notice Risk finding (CL-R5, CL-R6), in the style of the Phase 0 wrapper admin tests: what a Paxos freeze or wipe of
/// the `clUSDG` address does, on the real USDG and the real Morpho Blue. Lendora cannot prevent it; the test records
/// the behavior so the risk disclosure and runbook match reality.
contract CollateralTokenFreezeForkTest is Phase1ForkBase {
    /// @dev `Roles.ASSET_PROTECTION_ROLE` in Paxos' verified USDG source (Sourcify 4663/0x68184C44…6f8F).
    bytes32 internal constant ASSET_PROTECTION_ROLE =
        0xe3e4f9d7569515307c0cdec302af069a93c9e33f325269bac70e6e22465a9796;

    IPaxosUsdg internal usdg = IPaxosUsdg(USDG);
    CollateralToken internal cl;
    address internal router = makeAddr("router");
    address internal borrower = makeAddr("borrower");
    address internal paxos = makeAddr("paxosAssetProtection");
    MarketParams internal mp;

    function setUp() public override {
        super.setUp();
        cl = new CollateralToken(USDG, MORPHO, "Lendora Collateral USDG", "clUSDG");
        cl.setRouter(router);
        // Stand-in holder of the asset-protection role, granted by the real default admin on the fork.
        vm.prank(usdg.defaultAdmin());
        usdg.grantRole(ASSET_PROTECTION_ROLE, paxos);

        _fundUsdg(router, 1000e6);
        vm.startPrank(router);
        IERC20(USDG).approve(address(cl), type(uint256).max);
        cl.mint(router, 1000e6);
        cl.approve(MORPHO, type(uint256).max);
        vm.stopPrank();

        // Collateral-only market on the real Morpho (irm 0 / lltv 0 are enabled, A5) to hold the clUSDG.
        mp = MarketParams(USDG, address(cl), address(0), address(0), 0);
        IMorpho(MORPHO).createMarket(mp);
        vm.prank(router);
        IMorpho(MORPHO).supplyCollateral(mp, 1000e6, borrower, "");
    }

    /// A frozen clUSDG address cannot send USDG: unwraps revert for everyone (borrowers, liquidators). clUSDG units and
    /// Morpho accounting keep moving; the backing is stuck until Paxos unfreezes.
    function test_CL_R5_fork_paxosFreezeOfClUsdgBlocksUnwrap() public {
        vm.prank(paxos);
        usdg.freeze(address(cl));
        assertTrue(usdg.isFrozen(address(cl)));

        vm.prank(borrower);
        IMorpho(MORPHO).withdrawCollateral(mp, 400e6, borrower, borrower); // Morpho → borrower still works
        assertEq(cl.balanceOf(borrower), 400e6);

        vm.prank(borrower);
        vm.expectRevert(); // Paxos `AddressFrozen()` from USDG
        cl.unwrap(400e6, borrower);
        assertEq(IERC20(USDG).balanceOf(address(cl)), 1000e6, "backing frozen in place");

        vm.prank(paxos);
        usdg.unfreeze(address(cl));
        vm.prank(borrower);
        cl.unwrap(400e6, borrower);
        assertEq(IERC20(USDG).balanceOf(borrower), 400e6);
    }

    /// A wipe burns the backing: CL-R6 no longer holds and every clUSDG unit is unbacked.
    function test_CL_R6_fork_paxosWipeBreaksBacking() public {
        vm.startPrank(paxos);
        usdg.freeze(address(cl));
        usdg.wipeFrozenAddress(address(cl));
        vm.stopPrank();
        assertEq(IERC20(USDG).balanceOf(address(cl)), 0);
        assertEq(cl.totalSupply(), 1000e6, "CL-R6 broken: supply without backing");
    }
}
