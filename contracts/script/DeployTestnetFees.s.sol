// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {FeeSplitter} from "../src/fees/FeeSplitter.sol";
import {FeeConverter} from "../src/fees/FeeConverter.sol";
import {IFeeSplitter} from "../src/interfaces/IFeeSplitter.sol";
import {IFeeConverter} from "../src/interfaces/IFeeConverter.sol";

/// @notice Phase 3 task 11: add the fee contracts (FE-R1…R4) to the **existing** testnet (46630) deployment, which
/// predates them: two `FeeConverter`s (treasury, `BackstopReserve`; A33) and the `FeeSplitter` (50/50, Q8), each vault
/// registered with its oracle, the mock DEX allowlisted (Approve mode, as the testnet router), then everything owned by
/// the testnet timelock (24h). Turning the fee on in each vault is a separate curator-timelock step
/// (the SDK timelock tool, `vaultCuratorOperation`; docs/runbooks/list-stock.md).
///
///   Rehearsal on a local fork (no broadcast to the testnet):
///     anvil --fork-url https://rpc.testnet.chain.robinhood.com &
///     TESTNET_GO=fork-dry-run forge script script/DeployTestnetFees.s.sol --rpc-url http://127.0.0.1:8545 \
///       --broadcast --unlocked --sender <testnet deployer>
///   Testnet (only after the owner's "go testnet"; key from env, never in the repo):
///     TESTNET_GO=yes forge script script/DeployTestnetFees.s.sol --rpc-url $ROBINHOOD_TESTNET_RPC_URL \
///       --broadcast --slow --private-key $TESTNET_DEPLOYER_KEY
/// Output: `deployments/fork-46630-fees.json` on a fork rehearsal; on `TESTNET_GO=yes` also the three addresses in
/// `packages/sdk/addresses.json["46630"]`.
contract DeployTestnetFees is Script {
    string internal constant BOOK = "../packages/sdk/addresses.json";

    struct Out {
        FeeSplitter splitter;
        FeeConverter treasuryConverter;
        FeeConverter backstopConverter;
    }

    function run() external returns (Out memory o) {
        require(block.chainid == 46_630, "DeployTestnetFees is for Robinhood Chain testnet (46630) only");
        bytes32 go = keccak256(bytes(vm.envOr("TESTNET_GO", string(""))));
        bool live = go == keccak256("yes");
        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) || vm.isContext(VmSafe.ForgeContext.ScriptResume)) {
            require(
                live || go == keccak256("fork-dry-run"),
                "set TESTNET_GO=yes only after the go-ahead (TESTNET_GO=fork-dry-run on a local fork)"
            );
        }
        string memory j = vm.readFile(BOOK);
        address deployer = msg.sender;
        address timelock = vm.parseJsonAddress(j, ".chains.46630.timelock");
        address usdg = vm.parseJsonAddress(j, ".chains.46630.usdg");
        address dex = vm.parseJsonAddress(j, ".chains.46630.mocks.swapAggregator");
        address treasury = vm.envOr("STOCKLINE_TREASURY", deployer);
        address backstop = vm.envOr(
            "STOCKLINE_BACKSTOP_RESERVE", address(uint160(uint256(keccak256("stockline.placeholder.backstopReserve"))))
        );
        address feeKeeper = vm.envOr("STOCKLINE_FEE_KEEPER", deployer);
        string[] memory tickers = vm.parseJsonKeys(j, ".chains.46630.stocks");

        vm.startBroadcast(deployer);
        o.treasuryConverter = new FeeConverter(deployer, usdg, treasury, feeKeeper);
        o.backstopConverter = new FeeConverter(deployer, usdg, backstop, feeKeeper);
        IFeeSplitter.Recipient[] memory r = new IFeeSplitter.Recipient[](2);
        r[0] = IFeeSplitter.Recipient(address(o.treasuryConverter), 5000);
        r[1] = IFeeSplitter.Recipient(address(o.backstopConverter), 5000);
        o.splitter = new FeeSplitter(timelock, r);
        _register(o.treasuryConverter, j, tickers, dex, timelock);
        _register(o.backstopConverter, j, tickers, dex, timelock);
        vm.stopBroadcast();

        _write(o, live);
    }

    /// @dev Register every vault with its oracle, allowlist the mock DEX, hand the converter to the timelock.
    function _register(FeeConverter c, string memory j, string[] memory tickers, address dex, address timelock)
        internal
    {
        for (uint256 i; i < tickers.length; i++) {
            string memory b = string.concat(".chains.46630.stocks.", tickers[i], ".");
            c.setVault(
                vm.parseJsonAddress(j, string.concat(b, "vault")), vm.parseJsonAddress(j, string.concat(b, "oracle"))
            );
        }
        c.setSwapTarget(dex, IFeeConverter.SwapMode.Approve);
        c.transferOwnership(timelock);
    }

    function _write(Out memory o, bool live) internal {
        vm.serializeAddress("fees", "feeSplitter", address(o.splitter));
        vm.serializeAddress("fees", "treasuryConverter", address(o.treasuryConverter));
        string memory json = vm.serializeAddress("fees", "backstopConverter", address(o.backstopConverter));
        vm.writeJson(json, "deployments/fork-46630-fees.json");
        if (live) {
            vm.writeJson(vm.toString(address(o.splitter)), BOOK, ".chains.46630.feeSplitter");
            vm.writeJson(vm.toString(address(o.treasuryConverter)), BOOK, ".chains.46630.treasuryConverter");
            vm.writeJson(vm.toString(address(o.backstopConverter)), BOOK, ".chains.46630.backstopConverter");
        }
    }
}
