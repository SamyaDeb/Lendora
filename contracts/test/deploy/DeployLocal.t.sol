// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IMorpho, Id} from "morpho-blue/src/interfaces/IMorpho.sol";
import {StocklineDeploy} from "../../script/StocklineDeploy.sol";
import {LocalMocks} from "../../script/LocalMocks.sol";
import {VaultV2Ids} from "../../src/libraries/VaultV2Ids.sol";
import {IVaultV2Min} from "../../src/interfaces/external/IMorphoVaultV2.sol";

/// @notice The anvil deployment (script/DeployLocal.s.sol) run in-process: the same StocklineDeploy logic as the fork
/// test, against unmodified Morpho Blue, AdaptiveCurveIrm and Vault V2 built from our pinned sources, and mocks.
contract DeployLocalTest is Test, StocklineDeploy, LocalMocks {
    Mocks internal m;
    CoreConfig internal c;
    Core internal core;
    StockDeployment[] internal ds;

    function setUp() public {
        vm.warp(1_789_574_400); // Wed 2026-09-16 16:00Z, inside the generated calendar
        m = _deployLocalMocks(address(this));
        c = CoreConfig({
            deployer: address(this),
            morpho: m.morpho,
            irm: m.irm,
            usdg: address(m.usdg),
            usdgFeed: address(m.usdgFeed),
            vaultFactory: m.vaultFactory,
            adapterFactory: m.adapterFactory,
            issuerRegistry: address(m.registry),
            sequencerFeed: address(0),
            owner: makeAddr("owner"),
            curator: makeAddr("curator"),
            guardian: makeAddr("guardian"),
            allocator: makeAddr("allocator"),
            guardKeeper: makeAddr("guardKeeper"),
            feeSplitter: makeAddr("feeSplitter"),
            timelockDelay: 48 hours
        });
        StockConfig[] memory s = new StockConfig[](3);
        s[0] = StockConfig("SPY", address(m.tokens[0]), address(m.feeds[0]), 0.17e18, 1_000_000, 75_000);
        s[1] = StockConfig("NVDA", address(m.tokens[1]), address(m.feeds[1]), 0.52e18, 1_000_000, 250_000);
        s[2] = StockConfig("AAPL", address(m.tokens[2]), address(m.feeds[2]), 0.28e18, 250_000, 35_000);
        core = _deployCore(c, s);
        for (uint256 i; i < 3; i++) {
            ds.push(_deployStock(c, core, s[i]));
        }
    }

    function test_LM_R10_R23_localDeploymentWiring() public view {
        for (uint256 i; i < 3; i++) {
            StockDeployment memory d = ds[i];
            IVaultV2Min v = IVaultV2Min(d.vault);
            assertEq(v.owner(), address(core.timelock));
            assertEq(v.curator(), c.curator);
            assertTrue(v.isSentinel(c.guardian));
            assertEq(v.relativeCap(VaultV2Ids.marketId(d.adapter, d.market)), 0.9e18);
            assertEq(d.oracle.owner(), address(core.timelock));
            assertEq(IMorpho(m.morpho).market(Id.wrap(_id(d))).totalSupplyAssets, SEED);
            assertEq(v.balanceOf(DEAD), SEED, "vault seeded for a dead address");
        }
        // AAPL's cap is a quarter of NVDA's in USD (D8: $250k vs $1M).
        (uint256 pN,) = ds[1].oracle.stockAnswer();
        (uint256 pA,) = ds[2].oracle.stockAnswer();
        assertApproxEqRel(ds[2].capAssets * pA * 4, ds[1].capAssets * pN, 1e9);
        assertEq(core.marketHours.owner(), address(core.timelock));
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
        StockConfig[] memory s = new StockConfig[](0);
        _writeAddresses(key, c, core, s, new StockDeployment[](0), "", "");
    }

    function _id(StockDeployment memory d) internal pure returns (bytes32) {
        return keccak256(abi.encode(d.market));
    }
}

contract MockNoBalance {
    function balanceOf(address) external pure returns (uint256) {
        return 0;
    }
}
