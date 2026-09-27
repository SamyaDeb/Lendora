// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {StocklineDeploy} from "./StocklineDeploy.sol";
import {IStocklineRouter} from "../src/interfaces/IStocklineRouter.sol";
import {LocalMocks} from "./LocalMocks.sol";

/// @notice Full Stockline deployment on a local anvil (chain 31337) against mocks of everything Robinhood Chain
/// provides. Writes `packages/sdk/addresses.json` under "31337" (incl. a "mocks" section for keepers and tests).
///
///   anvil &
///   forge script script/DeployLocal.s.sol --rpc-url http://127.0.0.1:8545 --broadcast --slow --unlocked \
///     --sender 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
///
/// Roles default to anvil's well-known accounts (addresses only; no keys in this repo) and can be overridden by env.
contract DeployLocal is Script, StocklineDeploy, LocalMocks {
    function run() external {
        require(block.chainid == 31_337, "DeployLocal is for anvil only");
        address deployer = msg.sender;
        vm.startBroadcast(deployer);
        (
            CoreConfig memory c,
            StockConfig[] memory stocks,
            Core memory core,
            StockDeployment[] memory ds,
            Mocks memory m
        ) = deployAll(deployer);
        vm.stopBroadcast();
        _writeAddresses("31337", c, core, stocks, ds, "mocks", _mocksJson(m));
    }

    function localConfig(address deployer, Mocks memory m) public view returns (CoreConfig memory c) {
        c = CoreConfig({
            deployer: deployer,
            morpho: m.morpho,
            irm: m.irm,
            usdg: address(m.usdg),
            usdgFeed: address(m.usdgFeed),
            vaultFactory: m.vaultFactory,
            adapterFactory: m.adapterFactory,
            issuerRegistry: address(m.registry),
            sequencerFeed: address(0),
            owner: vm.envOr("STOCKLINE_OWNER", deployer),
            curator: vm.envOr("STOCKLINE_CURATOR", deployer),
            guardian: vm.envOr("STOCKLINE_GUARDIAN", address(0x90F79bf6EB2c4f870365E785982E1f101E93b906)),
            allocator: vm.envOr("STOCKLINE_ALLOCATOR", address(0x70997970C51812dc3A010C7d01b50e0d17dc79C8)),
            guardKeeper: vm.envOr("STOCKLINE_GUARD_KEEPER", address(0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC)),
            feeSplitter: vm.envOr("STOCKLINE_FEE_SPLITTER", address(0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65)),
            timelockDelay: 48 hours,
            attestationSigner: vm.envOr(
                "STOCKLINE_ATTESTATION_SIGNER", address(0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc)
            ),
            globalCollateralCap: 4_000_000e6,
            swapTarget: address(m.dex),
            swapMode: IStocklineRouter.SwapMode.Approve
        });
    }

    function localStocks(Mocks memory m) public pure returns (StockConfig[] memory s) {
        s = new StockConfig[](3);
        s[0] = StockConfig("SPY", address(m.tokens[0]), address(m.feeds[0]), 0.17e18, 1_000_000, 75_000);
        s[1] = StockConfig("NVDA", address(m.tokens[1]), address(m.feeds[1]), 0.52e18, 1_000_000, 250_000);
        s[2] = StockConfig("AAPL", address(m.tokens[2]), address(m.feeds[2]), 0.28e18, 250_000, 35_000);
    }

    function deployAll(address deployer)
        public
        returns (
            CoreConfig memory c,
            StockConfig[] memory stocks,
            Core memory core,
            StockDeployment[] memory ds,
            Mocks memory m
        )
    {
        m = _deployLocalMocks(deployer);
        c = localConfig(deployer, m);
        stocks = localStocks(m);
        core = _deployCore(c, stocks);
        ds = new StockDeployment[](stocks.length);
        for (uint256 i; i < stocks.length; i++) {
            ds[i] = _deployStock(c, core, stocks[i]);
        }
        core = _finalize(c, core);
    }
}
