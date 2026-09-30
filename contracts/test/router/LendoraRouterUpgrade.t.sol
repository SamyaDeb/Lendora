// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {IMorpho, Id, MarketParams} from "morpho-blue/src/interfaces/IMorpho.sol";
import {MarketParamsLib} from "morpho-blue/src/libraries/MarketParamsLib.sol";
import {LendoraRouter} from "../../src/LendoraRouter.sol";
import {ILendoraRouter} from "../../src/interfaces/ILendoraRouter.sol";
import {LendoraRouterPhase2} from "../utils/legacy/LendoraRouterPhase2.sol";
import {LocalLendora} from "../utils/LocalLendora.sol";

/// @notice RT-R7 + RT-R8: the deployed router proxy running the Phase 2 implementation (before RT-R8) is upgraded
/// through the 48h timelock to the current one. The ERC-7201 storage (owner, signer, markets, caps, swap modes)
/// survives, and the unattested-collateral bypass that the Phase 2 code allowed is closed from the upgrade on.
/// forge-config: default.isolate = true
/// forge-config: ci.isolate = true
contract LendoraRouterUpgradeTest is LocalLendora {
    using MarketParamsLib for MarketParams;

    bytes32 internal constant SALT = "rt-r8";

    function _upgradeViaTimelock(address impl) internal {
        bytes memory call = abi.encodeCall(core.router.upgradeToAndCall, (impl, ""));
        vm.prank(owner);
        core.timelock.schedule(address(core.router), 0, call, bytes32(0), SALT, 48 hours);
        vm.prank(owner);
        vm.expectRevert(); // TimelockUnexpectedOperationState: not ready before 48h
        core.timelock.execute(address(core.router), 0, call, bytes32(0), SALT);
        vm.warp(block.timestamp + 48 hours);
        vm.prank(owner);
        core.timelock.execute(address(core.router), 0, call, bytes32(0), SALT);
        assertEq(address(uint160(uint256(vm.load(address(core.router), ERC1967Utils.IMPLEMENTATION_SLOT)))), impl);
    }

    function test_RT_R7_R8_upgradeFromPhase2ImplementationThroughTimelock() public {
        LendoraRouter r = core.router;
        address nvda = address(m.tokens[1]);
        address spy = address(m.tokens[0]);
        Id nvdaId = ds[1].market.id();

        // The state as deployed in Phase 2: Phase 2 code behind the proxy, plus some owner configuration.
        LendoraRouterPhase2 phase2Impl = new LendoraRouterPhase2(m.morpho, address(core.clUSDG));
        vm.prank(address(core.timelock));
        r.upgradeToAndCall(address(phase2Impl), "");
        vm.startPrank(address(core.timelock));
        r.setCapOverride(address(0xA11CE), nvda, 500_000e18);
        r.setSwapTarget(address(m.dex), ILendoraRouter.SwapMode.Transfer);
        r.delistMarket(spy);
        vm.stopPrank();
        ILendoraRouter.Market memory nvdaBefore = r.market(nvda);
        ILendoraRouter.Market memory spyBefore = r.market(spy);

        // Phase 2 code: a never-attested address can create collateral (the review finding).
        address eve = makeAddr("eve");
        _onboard(eve, 0, 20_000e6);
        vm.prank(eve);
        r.addCollateral(nvda, 1000e6, eve, block.timestamp);
        assertEq(IMorpho(m.morpho).position(nvdaId, eve).collateral, 1000e6, "bypass open before the upgrade");

        LendoraRouter newImpl = new LendoraRouter(m.morpho, address(core.clUSDG));
        _upgradeViaTimelock(address(newImpl));

        assertEq(r.owner(), address(core.timelock), "owner");
        assertEq(r.attestationSigner(), signer.addr, "signer");
        assertEq(r.globalCap(), 4_000_000e6, "global cap");
        assertEq(r.capOf(address(0xA11CE), nvda), 500_000e18, "cap override");
        assertEq(r.capOf(eve, nvda), nvdaBefore.perAddressCapUsd, "default cap");
        assertEq(uint8(r.swapMode(address(m.dex))), uint8(ILendoraRouter.SwapMode.Transfer), "swap mode");
        ILendoraRouter.Market memory nvdaAfter = r.market(nvda);
        assertEq(nvdaAfter.wrapper, nvdaBefore.wrapper);
        assertEq(nvdaAfter.vault, nvdaBefore.vault);
        assertEq(nvdaAfter.adapter, nvdaBefore.adapter);
        assertEq(Id.unwrap(nvdaAfter.params.id()), Id.unwrap(nvdaId));
        assertEq(nvdaAfter.perAddressCapUsd, nvdaBefore.perAddressCapUsd);
        assertTrue(nvdaAfter.listed);
        assertFalse(r.market(spy).listed, "delisting survives");
        assertEq(r.market(spy).wrapper, spyBefore.wrapper);

        // RT-R8 from the upgrade on; eve's pre-upgrade collateral stays withdrawable (exits are never blocked).
        uint256 supply = IERC20(address(core.clUSDG)).totalSupply();
        vm.prank(eve);
        vm.expectRevert(abi.encodeWithSelector(ILendoraRouter.NoDebtPosition.selector, eve));
        r.addCollateral(nvda, 1000e6, eve, block.timestamp);
        assertEq(IERC20(address(core.clUSDG)).totalSupply(), supply);
        vm.prank(eve);
        r.withdrawCollateral(nvda, type(uint256).max, eve, block.timestamp);
        assertEq(IERC20(address(m.usdg)).balanceOf(eve), 20_000e6);
    }
}
