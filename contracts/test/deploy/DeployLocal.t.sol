// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IMorpho, Id} from "morpho-blue/src/interfaces/IMorpho.sol";
import {VaultV2Ids} from "../../src/libraries/VaultV2Ids.sol";
import {IVaultV2Min} from "../../src/interfaces/external/IMorphoVaultV2.sol";
import {IStocklineRouter} from "../../src/interfaces/IStocklineRouter.sol";
import {LocalStockline} from "../utils/LocalStockline.sol";

/// @notice The anvil deployment (script/DeployLocal.s.sol) run in-process.
contract DeployLocalTest is LocalStockline {
    function test_LM_R10_R23_localDeploymentWiring() public view {
        for (uint256 i; i < 3; i++) {
            StockDeployment memory d = ds[i];
            IVaultV2Min v = IVaultV2Min(d.vault);
            assertEq(v.owner(), address(core.timelock));
            assertEq(v.curator(), c.curator);
            assertTrue(v.isSentinel(c.guardian));
            assertEq(v.relativeCap(VaultV2Ids.marketId(d.adapter, d.market)), 0.9e18);
            assertEq(d.oracle.owner(), address(core.timelock));
            assertEq(IMorpho(m.morpho).market(Id.wrap(keccak256(abi.encode(d.market)))).totalSupplyAssets, SEED);
            assertEq(v.balanceOf(DEAD), SEED, "vault seeded for a dead address");
            IStocklineRouter.Market memory rm = core.router.market(address(m.tokens[i]));
            assertTrue(rm.listed);
            assertEq(rm.vault, d.vault);
        }
        (uint256 pN,) = ds[1].oracle.stockAnswer();
        (uint256 pA,) = ds[2].oracle.stockAnswer();
        assertApproxEqRel(ds[2].capAssets * pA * 4, ds[1].capAssets * pN, 1e9, "AAPL cap = 1/4 of NVDA's in USD");
        assertEq(core.marketHours.owner(), address(core.timelock));
        assertEq(core.router.owner(), address(core.timelock), "router handed to the timelock");
        assertEq(core.clUSDG.router(), address(core.router));
        assertEq(core.router.capOf(address(1), address(m.tokens[2])), 35_000e18);
        assertEq(IERC20(address(core.clUSDG)).totalSupply(), 0);
    }

    function test_deployStockRequiresSeedFunds() public {
        StockConfig memory s =
            StockConfig("TSLA", address(new MockNoBalance()), address(m.feeds[0]), 0.5e18, 1_000_000, 50_000);
        vm.expectRevert("deployer needs 2 * SEED raw stock units");
        this.deployStockExternal(s);
    }

    function deployStockExternal(StockConfig memory s) external {
        _deployStock(c, core, s);
    }

    function test_writeAddressesRefusesRealChainKey() public {
        vm.expectRevert("never write the real 4663 key from a script");
        this.writeExternal("4663");
    }

    function writeExternal(string memory key) external {
        _writeAddresses(key, c, core, new StockConfig[](0), new StockDeployment[](0), "", "");
    }
}

contract MockNoBalance {
    function balanceOf(address) external pure returns (uint256) {
        return 0;
    }
}
