// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {StocklineDeploy} from "../../script/StocklineDeploy.sol";
import {LocalMocks} from "../../script/LocalMocks.sol";
import {IStocklineRouter} from "../../src/interfaces/IStocklineRouter.sol";
import {IVaultV2Min} from "../../src/interfaces/external/IMorphoVaultV2.sol";

/// @notice Phase 2 fix (found by the testnet dry run): when one key holds every role (the testnet default), the
/// deploy script keeps it as the vault allocator instead of removing the temporary deployer allocator.
contract DeployRolesTest is Test, StocklineDeploy, LocalMocks {
    function test_LM_R30_deployerThatIsAlsoTheAllocatorKeepsTheRole() public {
        vm.warp(1_789_574_400);
        Mocks memory m = _deployLocalMocks(address(this));
        CoreConfig memory c = CoreConfig({
            deployer: address(this),
            morpho: m.morpho,
            irm: m.irm,
            usdg: address(m.usdg),
            usdgFeed: address(m.usdgFeed),
            vaultFactory: m.vaultFactory,
            adapterFactory: m.adapterFactory,
            issuerRegistry: address(m.registry),
            sequencerFeed: address(0),
            owner: address(this),
            curator: address(this),
            guardian: address(this),
            allocator: address(this),
            guardKeeper: address(this),
            feeSplitter: makeAddr("feeSplitter"),
            timelockDelay: 24 hours,
            attestationSigner: makeAddr("signer"),
            globalCollateralCap: 4_000_000e6,
            swapTarget: address(m.dex),
            swapMode: IStocklineRouter.SwapMode.Approve
        });
        StockConfig[] memory s = new StockConfig[](1);
        s[0] = StockConfig("NVDA", address(m.tokens[1]), address(m.feeds[1]), 0.52e18, 1_000_000, 250_000);
        Core memory core = _deployCore(c, s);
        StockDeployment memory d = _deployStock(c, core, s[0]);
        assertTrue(IVaultV2Min(d.vault).isAllocator(address(this)), "the configured allocator keeps the role");
    }
}
