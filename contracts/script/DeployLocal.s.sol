// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {DnVaultDeploy} from "./DnVaultDeploy.sol";
import {ReceiptMarketDeploy} from "./ReceiptMarketDeploy.sol";
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
/// Phase 4: the delta-neutral vault on the mock venue, written as `dnVault`. **Anvil only** gets non-zero caps (dev and
/// e2e: $2M total, sleeves $1M / $500k / $500k); testnet and mainnet configs pass 0 (Q11). Operator: anvil #6; NAV
/// signers: anvil #8 and #9 (the NAV reporter signs through the node's unlocked accounts; no key in the repo).
contract DeployLocal is Script, DnVaultDeploy, ReceiptMarketDeploy, LocalMocks {
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
        DnDeployment memory dn = deployDn(c, core, stocks, ds, m);
        ReceiptDeployment memory rNvda = deployReceipt(c, core, stocks[1], ds[1]);
        vm.stopBroadcast();
        _writeAddresses("31337", c, core, stocks, ds, "mocks", _mocksJson(m));
        _writeDn("31337", dn);
        vm.writeJson(
            _receiptJson("31337", "NVDA", rNvda), "../packages/sdk/addresses.json", ".chains.31337.stocks.NVDA.receipt"
        );
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
            treasury: vm.envOr("STOCKLINE_TREASURY", address(0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65)),
            backstopReserve: vm.envOr(
                "STOCKLINE_BACKSTOP_RESERVE", address(0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f)
            ),
            feeKeeper: vm.envOr("STOCKLINE_FEE_KEEPER", address(0xa0Ee7A142d267C1f36714E4a8F75612F20a79720)),
            timelockDelay: 48 hours,
            attestationSigner: vm.envOr(
                "STOCKLINE_ATTESTATION_SIGNER", address(0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc)
            ),
            globalCollateralCap: 4_000_000e6,
            swapTarget: address(m.dex),
            swapMode: IStocklineRouter.SwapMode.Approve
        });
    }

    /// @notice Phase 4 on anvil: mock venue funded for PnL, dev caps.
    function deployDn(
        CoreConfig memory c,
        Core memory core,
        StockConfig[] memory stocks,
        StockDeployment[] memory ds,
        Mocks memory m
    ) public returns (DnDeployment memory dn) {
        address[] memory signers = new address[](2);
        signers[0] = vm.envOr("STOCKLINE_NAV_SIGNER_1", address(0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f));
        signers[1] = vm.envOr("STOCKLINE_NAV_SIGNER_2", address(0xa0Ee7A142d267C1f36714E4a8F75612F20a79720));
        uint128[] memory caps = new uint128[](3);
        caps[0] = 1_000_000e6;
        caps[1] = 500_000e6;
        caps[2] = 500_000e6;
        address operator = vm.envOr("STOCKLINE_DN_OPERATOR", address(0x976EA74026E726554dB657fA54763abd0C3a0aa9));
        dn = _deployDnVault(_dnConfig(c, core, operator, signers, true, 2_000_000e6), _dnSleeves(stocks, ds, caps));
        m.usdg.mint(dn.adapter, 10_000_000e6); // venue liquidity for positive PnL
    }

    /// @notice G5 (A3) stage 1 for NVDA on anvil: oracle, market, USDG vault with caps 0 (listing is the curator's
    /// timelocked step, as on mainnet).
    function deployReceipt(CoreConfig memory c, Core memory core, StockConfig memory s, StockDeployment memory d)
        public
        returns (ReceiptDeployment memory)
    {
        return _deployReceiptMarket(
            c.deployer,
            ReceiptConfig({
                ticker: s.ticker,
                stockToken: s.token,
                feed: s.feed,
                wrapper: address(d.wrapper),
                rVault: d.vault,
                sigmaWad: s.sigmaWad,
                morpho: c.morpho,
                irm: c.irm,
                usdg: c.usdg,
                usdgFeed: c.usdgFeed,
                vaultFactory: c.vaultFactory,
                adapterFactory: c.adapterFactory,
                marketHours: address(core.marketHours),
                timelock: address(core.timelock),
                owner: c.owner,
                curator: c.curator,
                guardian: c.guardian,
                allocator: c.allocator,
                guardKeeper: c.guardKeeper,
                feeSplitter: address(core.feeSplitter),
                sequencerFeed: c.sequencerFeed,
                issuerRegistry: c.issuerRegistry,
                timelockDelay: c.timelockDelay
            })
        );
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
        core = _deployLens(core, stocks);
    }
}
