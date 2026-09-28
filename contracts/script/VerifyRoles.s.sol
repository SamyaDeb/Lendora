// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {MarketParams} from "morpho-blue/src/interfaces/IMorpho.sol";
import {MainnetConfig} from "./MainnetConfig.sol";
import {IStocklineRouter} from "../src/interfaces/IStocklineRouter.sol";
import {StocklineRouter} from "../src/StocklineRouter.sol";
import {IFeeSplitter} from "../src/interfaces/IFeeSplitter.sol";
import {IFeeConverter} from "../src/interfaces/IFeeConverter.sol";
import {ICollateralToken} from "../src/interfaces/ICollateralToken.sol";
import {StocklineOracleBase} from "../src/oracles/StocklineOracleBase.sol";
import {StocklineLiquidator} from "../src/StocklineLiquidator.sol";
import {FeeConverter} from "../src/fees/FeeConverter.sol";
import {VaultV2Ids} from "../src/libraries/VaultV2Ids.sol";
import {
    IVaultV2Min,
    IVaultV2FactoryMin,
    IMorphoMarketV1AdapterV2Min,
    IMorphoMarketV1AdapterV2FactoryMin
} from "../src/interfaces/external/IMorphoVaultV2.sol";

/// @notice Read-only role and configuration check of a Stockline deployment (mainnet-launch §3.4 and §3.5, MN-R5).
/// Prints a pass/fail table the launch log can paste and reverts if any check fails. Sends nothing.
///
///   STOCKLINE_DEPLOYMENT_JSON=deployments/4663.json STOCKLINE_DEPLOYER=<deployer> STOCKLINE_OWNER=… (all nine
///   STOCKLINE_* roles, as for DeployMainnet) forge script script/VerifyRoles.s.sol --rpc-url $ROBINHOOD_RPC_URL
///
/// Checks: every role distinct, non-zero, not the deployer; Safe thresholds (owner 4-of-7, guardian 2-of-4, other
/// multisigs ≥ 2); timelock 48h with the owner Safe as its only proposer/executor/canceller and no admin besides
/// itself; router owner, signer, implementation, global cap and swap target; MarketHours owner; liquidator owner and
/// swap target; FeeSplitter owner and 50/50 split to the converters; converter owner, keeper, destination and vaults;
/// per stock: oracle owner/guardian/keeper, vault owner/curator/sentinel/allocators, 10% fee to the splitter,
/// `forceDeallocatePenalty = 0`, U_MAX, every curator timelock at 48h, adapter timelocks, the router listing, and the
/// Vault V2 code (official factory byte-identical to the pinned source, `isVaultV2`, and the vault's runtime code
/// equal to the pinned `VaultV2` outside its immutables); the deployer holds nothing.
contract VerifyRoles is Script, MainnetConfig {
    struct StockAddrs {
        string ticker;
        address token;
        address wrapper;
        address oracle;
        address vault;
        address adapter;
    }

    struct Deployment {
        address timelock;
        address marketHours;
        address clUSDG;
        address router;
        address routerImplementation;
        address liquidator;
        address feeSplitter;
        address treasuryConverter;
        address backstopConverter;
        address vaultFactory;
        address adapterFactory;
        StockAddrs[] stocks;
    }

    struct Expected {
        Roles roles;
        address deployer;
        address swapTarget;
        uint256 timelockDelay;
    }

    struct Check {
        string name;
        bool ok;
        string detail;
    }

    /// @dev Growable check list (a fixed buffer and a counter).
    struct Out {
        Check[] checks;
        uint256 n;
    }

    bytes32 internal constant IMPLEMENTATION_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    /// @notice Script entry: load the deployment and the expected roles from env, print the table, revert on failure.
    function run() external view {
        Deployment memory d = loadDeployment(vm.envOr("STOCKLINE_DEPLOYMENT_JSON", string("deployments/4663.json")));
        Expected memory e = Expected({
            roles: mainnetRolesFromEnv(),
            deployer: vm.envAddress("STOCKLINE_DEPLOYER"),
            swapTarget: vm.envOr("STOCKLINE_SWAP_TARGET", _ext("uniswap.universalRouter")),
            timelockDelay: vm.envOr("STOCKLINE_TIMELOCK_DELAY", MAINNET_TIMELOCK)
        });
        Check[] memory cs = verify(d, e);
        uint256 failed = printTable(cs);
        require(failed == 0, string.concat("VerifyRoles: ", vm.toString(failed), " check(s) failed"));
    }

    /// @notice Parse a chain entry in the address-book shape (`deployments/4663.json` or `addresses.json` chains.X).
    function loadDeployment(string memory path) public view returns (Deployment memory d) {
        string memory j = vm.readFile(path);
        d.timelock = vm.parseJsonAddress(j, ".timelock");
        d.marketHours = vm.parseJsonAddress(j, ".marketHours");
        d.clUSDG = vm.parseJsonAddress(j, ".clUSDG");
        d.router = vm.parseJsonAddress(j, ".router");
        d.routerImplementation = vm.parseJsonAddress(j, ".routerImplementation");
        d.liquidator = vm.parseJsonAddress(j, ".liquidator");
        d.feeSplitter = vm.parseJsonAddress(j, ".feeSplitter");
        d.treasuryConverter = vm.parseJsonAddress(j, ".treasuryConverter");
        d.backstopConverter = vm.parseJsonAddress(j, ".backstopConverter");
        d.vaultFactory = vm.parseJsonAddress(j, ".vaultV2Factory");
        d.adapterFactory = vm.parseJsonAddress(j, ".adapterFactory");
        string[] memory tickers = vm.parseJsonKeys(j, ".stocks");
        d.stocks = new StockAddrs[](tickers.length);
        for (uint256 i; i < tickers.length; i++) {
            string memory b = string.concat(".stocks.", tickers[i], ".");
            d.stocks[i] = StockAddrs({
                ticker: tickers[i],
                token: vm.parseJsonAddress(j, string.concat(b, "stockToken")),
                wrapper: vm.parseJsonAddress(j, string.concat(b, "wrapper")),
                oracle: vm.parseJsonAddress(j, string.concat(b, "oracle")),
                vault: vm.parseJsonAddress(j, string.concat(b, "vault")),
                adapter: vm.parseJsonAddress(j, string.concat(b, "adapter"))
            });
        }
    }

    /// @notice Every check, in table order. View only.
    function verify(Deployment memory d, Expected memory e) public view returns (Check[] memory) {
        Out memory o = Out(new Check[](128 + 64 * d.stocks.length), 0);
        _roles(o, e);
        _timelock(o, d, e);
        _core(o, d, e);
        _fees(o, d, e);
        for (uint256 i; i < d.stocks.length; i++) {
            _stock(o, d, e, d.stocks[i]);
        }
        Check[] memory cs = o.checks;
        uint256 n = o.n;
        assembly ("memory-safe") {
            mstore(cs, n)
        }
        return cs;
    }

    /// @notice Print `| # | check | result | detail |` rows; returns the number of failures.
    function printTable(Check[] memory cs) public pure returns (uint256 failed) {
        console.log("| # | Check | Result | Detail |");
        console.log("|---|---|---|---|");
        for (uint256 i; i < cs.length; i++) {
            if (!cs[i].ok) failed++;
            console.log(
                string.concat(
                    "| ",
                    vm.toString(i + 1),
                    " | ",
                    cs[i].name,
                    " | ",
                    cs[i].ok ? "PASS" : "**FAIL**",
                    " | ",
                    cs[i].detail,
                    " |"
                )
            );
        }
        console.log(
            string.concat("VerifyRoles: ", vm.toString(cs.length - failed), "/", vm.toString(cs.length), " pass")
        );
    }

    // ------------------------------------------------------------------ sections

    function _roles(Out memory o, Expected memory e) internal view {
        CoreConfig memory c;
        c.owner = e.roles.owner;
        c.curator = e.roles.curator;
        c.guardian = e.roles.guardian;
        c.allocator = e.roles.allocator;
        c.guardKeeper = e.roles.guardKeeper;
        c.treasury = e.roles.treasury;
        c.backstopReserve = e.roles.backstopReserve;
        c.feeKeeper = e.roles.feeKeeper;
        c.attestationSigner = e.roles.attestationSigner;
        (, address[9] memory a) = _roleList(c);
        bool distinct = true;
        bool nonZero = true;
        bool notDeployer = true;
        for (uint256 i; i < 9; i++) {
            nonZero = nonZero && a[i] != address(0) && !_isPlaceholder(a[i]);
            notDeployer = notDeployer && a[i] != e.deployer;
            for (uint256 j = i + 1; j < 9; j++) {
                distinct = distinct && a[i] != a[j];
            }
        }
        _add(o, "roles: none zero or placeholder", nonZero, "9 roles");
        _add(o, "roles: all distinct (A27 not carried over)", distinct, "9 roles");
        _add(o, "roles: none is the deployer", notDeployer, vm.toString(e.deployer));
        _safe(o, "owner Safe", e.roles.owner, OWNER_THRESHOLD, OWNER_SIGNERS);
        _safe(o, "guardian Safe", e.roles.guardian, GUARDIAN_THRESHOLD, GUARDIAN_SIGNERS);
        _safe(o, "curator Safe", e.roles.curator, MULTISIG_MIN_THRESHOLD, 0);
        _safe(o, "treasury Safe", e.roles.treasury, MULTISIG_MIN_THRESHOLD, 0);
        _safe(o, "backstopReserve Safe", e.roles.backstopReserve, MULTISIG_MIN_THRESHOLD, 0);
    }

    function _safe(Out memory o, string memory name, address safe, uint256 minT, uint256 minN) internal view {
        uint256 t = safe.code.length > 0 ? _safeThreshold(safe) : 0;
        uint256 n = safe.code.length > 0 ? _safeSigners(safe) : 0;
        _add(
            o,
            string.concat(
                name, ": threshold >= ", vm.toString(minT), minN > 0 ? string.concat(" of ", vm.toString(minN)) : ""
            ),
            t >= minT && t <= n && n >= minN,
            string.concat(vm.toString(t), "-of-", vm.toString(n))
        );
    }

    function _timelock(Out memory o, Deployment memory d, Expected memory e) internal view {
        TimelockController t = TimelockController(payable(d.timelock));
        _add(o, "timelock: min delay", t.getMinDelay() == e.timelockDelay, vm.toString(t.getMinDelay()));
        address own = e.roles.owner;
        _add(
            o,
            "timelock: owner Safe proposes, executes, cancels",
            t.hasRole(t.PROPOSER_ROLE(), own) && t.hasRole(t.EXECUTOR_ROLE(), own)
                && t.hasRole(t.CANCELLER_ROLE(), own),
            vm.toString(own)
        );
        bool deployerNone = !t.hasRole(t.PROPOSER_ROLE(), e.deployer) && !t.hasRole(t.EXECUTOR_ROLE(), e.deployer)
            && !t.hasRole(t.CANCELLER_ROLE(), e.deployer) && !t.hasRole(t.DEFAULT_ADMIN_ROLE(), e.deployer);
        _add(o, "timelock: deployer holds no role", deployerNone, "");
        _add(
            o,
            "timelock: admin is only itself (no external admin)",
            t.hasRole(t.DEFAULT_ADMIN_ROLE(), d.timelock) && !t.hasRole(t.DEFAULT_ADMIN_ROLE(), own),
            ""
        );
        _add(o, "timelock: executor is not open (address(0))", !t.hasRole(t.EXECUTOR_ROLE(), address(0)), "");
    }

    function _core(Out memory o, Deployment memory d, Expected memory e) internal view {
        StocklineRouter r = StocklineRouter(d.router);
        _eq(o, "router: owner == timelock", r.owner(), d.timelock);
        _eq(o, "router: attestationSigner", r.attestationSigner(), e.roles.attestationSigner);
        _eq(
            o,
            "router: ERC1967 implementation",
            address(uint160(uint256(vm.load(d.router, IMPLEMENTATION_SLOT)))),
            d.routerImplementation
        );
        _add(o, "router: global clUSDG cap $4M", r.globalCap() == MAINNET_GLOBAL_CAP, vm.toString(r.globalCap()));
        _add(
            o,
            "router: swap target in Transfer mode (Q4)",
            r.swapMode(e.swapTarget) == IStocklineRouter.SwapMode.Transfer,
            vm.toString(e.swapTarget)
        );
        _eq(o, "clUSDG: router", ICollateralToken(d.clUSDG).router(), d.router);
        _eq(o, "MarketHours: owner == timelock", Ownable(d.marketHours).owner(), d.timelock);
        _eq(o, "liquidator: owner == owner Safe", Ownable(d.liquidator).owner(), e.roles.owner);
        _add(
            o,
            "liquidator: swap target in Transfer mode",
            StocklineLiquidator(d.liquidator).swapModes(e.swapTarget) == StocklineLiquidator.SwapMode.Transfer,
            ""
        );
    }

    function _fees(Out memory o, Deployment memory d, Expected memory e) internal view {
        _eq(o, "FeeSplitter: owner == timelock", Ownable(d.feeSplitter).owner(), d.timelock);
        IFeeSplitter.Recipient[] memory rs = IFeeSplitter(d.feeSplitter).recipients();
        bool split = rs.length == 2 && rs[0].account == d.treasuryConverter && rs[0].bps == 5000
            && rs[1].account == d.backstopConverter && rs[1].bps == 5000;
        _add(o, "FeeSplitter: 5,000 treasury / 5,000 backstop converters (Q8)", split, "");
        _converter(o, "treasury converter", d.treasuryConverter, d, e.roles.treasury, e);
        _converter(o, "backstop converter", d.backstopConverter, d, e.roles.backstopReserve, e);
    }

    function _converter(
        Out memory o,
        string memory name,
        address conv,
        Deployment memory d,
        address destination,
        Expected memory e
    ) internal view {
        _eq(o, string.concat(name, ": owner == timelock"), Ownable(conv).owner(), d.timelock);
        _eq(o, string.concat(name, ": keeper == feeKeeper"), IFeeConverter(conv).keeper(), e.roles.feeKeeper);
        _eq(o, string.concat(name, ": destination"), IFeeConverter(conv).destination(), destination);
        bool vaults = true;
        for (uint256 i; i < d.stocks.length; i++) {
            vaults = vaults && FeeConverter(conv).oracleOf(d.stocks[i].vault) == d.stocks[i].oracle;
        }
        _add(o, string.concat(name, ": every vault registered with its oracle"), vaults, "");
        _add(
            o,
            string.concat(name, ": swap target in Transfer mode"),
            FeeConverter(conv).swapModes(e.swapTarget) == IFeeConverter.SwapMode.Transfer,
            ""
        );
    }

    function _stock(Out memory o, Deployment memory d, Expected memory e, StockAddrs memory s) internal view {
        string memory t = string.concat(s.ticker, " ");
        StocklineOracleBase orc = StocklineOracleBase(s.oracle);
        _eq(o, string.concat(t, "oracle: owner == timelock"), orc.owner(), d.timelock);
        _eq(o, string.concat(t, "oracle: guardian"), orc.guardian(), e.roles.guardian);
        _eq(o, string.concat(t, "oracle: keeper == guardKeeper"), orc.keeper(), e.roles.guardKeeper);

        IVaultV2Min v = IVaultV2Min(s.vault);
        _eq(o, string.concat(t, "vault: owner == timelock"), v.owner(), d.timelock);
        _eq(o, string.concat(t, "vault: curator == curator Safe"), v.curator(), e.roles.curator);
        _add(o, string.concat(t, "vault: guardian is sentinel"), v.isSentinel(e.roles.guardian), "");
        _add(
            o,
            string.concat(t, "vault: allocators = keeper + owner Safe"),
            v.isAllocator(e.roles.allocator) && v.isAllocator(e.roles.owner),
            ""
        );
        _add(
            o,
            string.concat(t, "vault: deployer is not allocator or sentinel"),
            !v.isAllocator(e.deployer) && !v.isSentinel(e.deployer),
            ""
        );
        _add(o, string.concat(t, "vault: performance fee 10%"), v.performanceFee() == PERFORMANCE_FEE, "");
        _eq(o, string.concat(t, "vault: fee recipient == FeeSplitter"), v.performanceFeeRecipient(), d.feeSplitter);
        _add(o, string.concat(t, "vault: forceDeallocatePenalty 0 (A12)"), v.forceDeallocatePenalty(s.adapter) == 0, "");
        MarketParams memory mp = StocklineRouter(d.router).market(s.token).params;
        _add(
            o,
            string.concat(t, "vault: relative cap U_MAX 90%"),
            v.relativeCap(VaultV2Ids.marketId(s.adapter, mp)) == U_MAX,
            ""
        );
        _add(o, string.concat(t, "vault: every curator timelock 48h"), _vaultTimelocks(v, e.timelockDelay), "");
        _add(
            o,
            string.concat(t, "adapter: timelocks 48h"),
            _adapterTimelocks(IMorphoMarketV1AdapterV2Min(s.adapter), e.timelockDelay),
            ""
        );
        _eq(
            o,
            string.concat(t, "adapter: from the official factory for this vault"),
            IMorphoMarketV1AdapterV2FactoryMin(d.adapterFactory).morphoMarketV1AdapterV2(s.vault),
            s.adapter
        );

        IStocklineRouter.Market memory m = StocklineRouter(d.router).market(s.token);
        _add(
            o,
            string.concat(t, "router: listed with this wrapper, vault, adapter, oracle"),
            m.listed && m.wrapper == s.wrapper && m.vault == s.vault && m.adapter == s.adapter
                && m.params.oracle == s.oracle && m.params.lltv == LLTV,
            ""
        );
        _add(
            o,
            string.concat(t, "Vault V2: created by the official factory (isVaultV2)"),
            IVaultV2FactoryMin(d.vaultFactory).isVaultV2(s.vault),
            ""
        );
        _add(
            o,
            string.concat(t, "Vault V2: factory code == pinned source (LM-R20)"),
            keccak256(d.vaultFactory.code)
                == keccak256(vm.getDeployedCode("out/VaultV2Factory.sol/VaultV2Factory.json")),
            vm.toString(d.vaultFactory.codehash)
        );
        _add(
            o,
            string.concat(t, "Vault V2: runtime code == pinned VaultV2 outside immutables"),
            _vaultCodeMatches(s.vault),
            vm.toString(s.vault.codehash)
        );
    }

    // ------------------------------------------------------------------ helpers

    function _vaultTimelocks(IVaultV2Min v, uint256 delay) internal view returns (bool ok) {
        bytes4[17] memory sels = [
            IVaultV2Min.setIsAllocator.selector,
            IVaultV2Min.addAdapter.selector,
            IVaultV2Min.removeAdapter.selector,
            IVaultV2Min.increaseAbsoluteCap.selector,
            IVaultV2Min.increaseRelativeCap.selector,
            IVaultV2Min.setPerformanceFee.selector,
            IVaultV2Min.setPerformanceFeeRecipient.selector,
            IVaultV2Min.setManagementFee.selector,
            IVaultV2Min.setManagementFeeRecipient.selector,
            IVaultV2Min.setForceDeallocatePenalty.selector,
            IVaultV2Min.setReceiveSharesGate.selector,
            IVaultV2Min.setSendSharesGate.selector,
            IVaultV2Min.setReceiveAssetsGate.selector,
            IVaultV2Min.setSendAssetsGate.selector,
            IVaultV2Min.setAdapterRegistry.selector,
            IVaultV2Min.abdicate.selector,
            IVaultV2Min.increaseTimelock.selector
        ];
        ok = true;
        for (uint256 i; i < sels.length; i++) {
            ok = ok && v.timelock(sels[i]) == delay;
        }
    }

    function _adapterTimelocks(IMorphoMarketV1AdapterV2Min a, uint256 delay) internal view returns (bool ok) {
        bytes4[4] memory sels = [
            IMorphoMarketV1AdapterV2Min.setSkimRecipient.selector,
            IMorphoMarketV1AdapterV2Min.burnShares.selector,
            IMorphoMarketV1AdapterV2Min.abdicate.selector,
            IMorphoMarketV1AdapterV2Min.increaseTimelock.selector
        ];
        ok = true;
        for (uint256 i; i < sels.length; i++) {
            ok = ok && a.timelock(sels[i]) == delay;
        }
    }

    struct Ref {
        uint256 length;
        uint256 start;
    }

    /// @dev The vault's runtime code equals the pinned `VaultV2` deployed bytecode once every immutable range (from
    /// the artifact's `immutableReferences`) is zeroed in both (the artifact already has zeros there).
    function _vaultCodeMatches(address vault) internal view returns (bool) {
        string memory art = "out/VaultV2.sol/VaultV2.json";
        string memory json = vm.readFile(art);
        bytes memory pinned = vm.parseJsonBytes(json, ".deployedBytecode.object");
        bytes memory code = vault.code;
        if (code.length != pinned.length) return false;
        string[] memory ids = vm.parseJsonKeys(json, ".deployedBytecode.immutableReferences");
        for (uint256 i; i < ids.length; i++) {
            string memory base = string.concat(".deployedBytecode.immutableReferences.", ids[i]);
            Ref[] memory refs = abi.decode(vm.parseJson(json, base), (Ref[]));
            for (uint256 k; k < refs.length; k++) {
                for (uint256 b; b < refs[k].length; b++) {
                    code[refs[k].start + b] = 0;
                    pinned[refs[k].start + b] = 0;
                }
            }
        }
        return keccak256(code) == keccak256(pinned);
    }

    function _eq(Out memory o, string memory name, address got, address want) internal pure {
        _add(
            o,
            name,
            got == want,
            got == want ? vm.toString(got) : string.concat(vm.toString(got), " != ", vm.toString(want))
        );
    }

    function _add(Out memory o, string memory name, bool ok, string memory detail) internal pure {
        o.checks[o.n++] = Check(name, ok, detail);
    }
}
