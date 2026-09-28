// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IStocklineOracle} from "../src/interfaces/IStocklineOracle.sol";
import {StocklineOracleBase} from "../src/oracles/StocklineOracleBase.sol";
import {ReceiptMarketDeploy} from "./ReceiptMarketDeploy.sol";

/// @notice G5 receipt market for one listed stock (A3; docs/runbooks/list-receipt-market.md). **Stage 1 only**: deploys
/// the `ReceiptCollateralOracle`, the Morpho market (LLTV 62.5%) and the USDG Vault V2 with **every cap at 0**; the
/// deployer keeps no role. The listing (stage 2) is the curator multisig's timelocked cap raise, encoded by the SDK
/// tool (SDK package), never sent from here:
///
///   (in packages/sdk) pnpm timelock receipt.list ticker=NVDA capUsdg=250000 --network <key>
///
/// Inputs come from the address book (`packages/sdk/addresses.json`, key `STOCKLINE_NETWORK`): the stock's wrapper,
/// `rSTOCK` vault and feed; the oracle's guardian, keeper, sequencer feed, blocklist and parameters are copied from the
/// live stock oracle so both markets share one risk configuration.
///
///   Local / fork:   STOCKLINE_NETWORK=31337 TICKER=NVDA forge script script/ListReceiptMarket.s.sol \
///                     --rpc-url http://127.0.0.1:8545 --broadcast --unlocked --sender <deployer>
///   Testnet:        + TESTNET_GO=yes (only after the owner's go)
///   Mainnet (4663): + I_HAVE_THE_OWNERS_GO=1 and STOCK_LAUNCH_TS=<launch unix ts>; refused before launch + 30 days
///                     (CL-R10). Output `deployments/4663-receipt-<TICKER>.json`; the publish tool copies it into the
///                     address book (scripts never write the 4663 key).
contract ListReceiptMarket is Script, ReceiptMarketDeploy {
    string internal constant BOOK = "../packages/sdk/addresses.json";

    function run() external returns (ReceiptDeployment memory d) {
        string memory key = vm.envString("STOCKLINE_NETWORK");
        string memory ticker = vm.envString("TICKER");
        _checkNetwork(key, block.chainid);
        _assertListingWindow(block.chainid, vm.envOr("STOCK_LAUNCH_TS", uint256(0)), block.timestamp);
        bool broadcasting =
            vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) || vm.isContext(VmSafe.ForgeContext.ScriptResume);
        if (broadcasting) _checkGo(block.chainid);

        ReceiptConfig memory r = receiptConfigFromBook(vm.readFile(BOOK), key, ticker);
        vm.startBroadcast();
        d = _deployReceiptMarket(msg.sender, r);
        vm.stopBroadcast();

        string memory json = _receiptJson(key, ticker, d);
        if (block.chainid == 4663) {
            vm.writeJson(json, string.concat("deployments/4663-receipt-", ticker, ".json"));
        } else if (block.chainid != 46_630 || keccak256(bytes(vm.envOr("TESTNET_GO", string("")))) == keccak256("yes"))
        {
            vm.writeJson(json, BOOK, string.concat(".chains.", key, ".stocks.", ticker, ".receipt"));
        }
    }

    /// @notice The receipt config for `ticker` from an address-book chain entry. Public so the tests can check it.
    function receiptConfigFromBook(string memory j, string memory key, string memory ticker)
        public
        view
        returns (ReceiptConfig memory r)
    {
        string memory c = string.concat(".chains.", key, ".");
        string memory s = string.concat(c, "stocks.", ticker, ".");
        StocklineOracleBase stockOracle = StocklineOracleBase(vm.parseJsonAddress(j, string.concat(s, "oracle")));
        IStocklineOracle.Params memory p = stockOracle.params();
        address timelock = vm.parseJsonAddress(j, string.concat(c, "timelock"));
        r = ReceiptConfig({
            ticker: ticker,
            stockToken: vm.parseJsonAddress(j, string.concat(s, "stockToken")),
            feed: vm.parseJsonAddress(j, string.concat(s, "feed")),
            wrapper: vm.parseJsonAddress(j, string.concat(s, "wrapper")),
            rVault: vm.parseJsonAddress(j, string.concat(s, "vault")),
            sigmaWad: uint64(p.sigmaWad),
            morpho: vm.parseJsonAddress(j, string.concat(c, "morpho")),
            irm: vm.parseJsonAddress(j, string.concat(c, "adaptiveCurveIrm")),
            usdg: vm.parseJsonAddress(j, string.concat(c, "usdg")),
            usdgFeed: vm.parseJsonAddress(j, string.concat(c, "usdgFeed")),
            vaultFactory: vm.parseJsonAddress(j, string.concat(c, "vaultV2Factory")),
            adapterFactory: vm.parseJsonAddress(j, string.concat(c, "adapterFactory")),
            marketHours: vm.parseJsonAddress(j, string.concat(c, "marketHours")),
            timelock: timelock,
            owner: vm.parseJsonAddress(j, string.concat(c, "roles.owner")),
            curator: vm.parseJsonAddress(j, string.concat(c, "roles.curator")),
            guardian: stockOracle.guardian(),
            allocator: vm.parseJsonAddress(j, string.concat(c, "roles.allocator")),
            guardKeeper: stockOracle.keeper(),
            feeSplitter: vm.keyExistsJson(j, string.concat(c, "feeSplitter"))
                ? vm.parseJsonAddress(j, string.concat(c, "feeSplitter"))
                : address(0),
            sequencerFeed: stockOracle.sequencerFeed(),
            issuerRegistry: stockOracle.blocklist(),
            timelockDelay: TimelockController(payable(timelock)).getMinDelay()
        });
    }

    /// @notice The key must name the chain the script runs on ("fork-4663" runs on 4663).
    function checkNetwork(string memory key, uint256 chainId) external pure {
        _checkNetwork(key, chainId);
    }

    /// @notice Broadcast guards: 46630 needs `TESTNET_GO=yes` (or `fork-dry-run`), 4663 `I_HAVE_THE_OWNERS_GO=1`.
    function checkGo(uint256 chainId) external view {
        _checkGo(chainId);
    }

    /// @notice CL-R10 (exposed for the tests).
    function assertListingWindow(uint256 chainId, uint256 launchTs, uint256 nowTs) external pure {
        _assertListingWindow(chainId, launchTs, nowTs);
    }

    function _checkNetwork(string memory key, uint256 chainId) internal pure {
        bytes32 k = keccak256(bytes(key));
        uint256 expected = k == keccak256("fork-4663") ? 4663 : _parseUint(key);
        require(expected == chainId, "STOCKLINE_NETWORK does not match the chain");
    }

    function _checkGo(uint256 chainId) internal view {
        if (chainId == 4663) {
            require(
                keccak256(bytes(vm.envOr("I_HAVE_THE_OWNERS_GO", string("")))) == keccak256("1"),
                "MN-R4: no broadcast to 4663 without I_HAVE_THE_OWNERS_GO=1"
            );
        } else if (chainId == 46_630) {
            bytes32 go = keccak256(bytes(vm.envOr("TESTNET_GO", string(""))));
            require(go == keccak256("yes") || go == keccak256("fork-dry-run"), "set TESTNET_GO=yes after the go-ahead");
        }
    }

    function _parseUint(string memory s) internal pure returns (uint256 n) {
        bytes memory b = bytes(s);
        require(b.length > 0 && b.length < 78, "bad STOCKLINE_NETWORK");
        for (uint256 i; i < b.length; i++) {
            require(b[i] >= "0" && b[i] <= "9", "bad STOCKLINE_NETWORK");
            n = n * 10 + (uint8(b[i]) - 48);
        }
    }
}
