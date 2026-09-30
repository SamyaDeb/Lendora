// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {ForkConfig} from "./ForkConfig.sol";
import {DnVaultDeploy} from "./DnVaultDeploy.sol";
import {ILendoraRouter} from "../src/interfaces/ILendoraRouter.sol";

/// @notice Safe views the mainnet checks read (owner count and threshold).
interface ISafeMin {
    /// @notice Signatures needed to execute.
    function getThreshold() external view returns (uint256);
    /// @notice Current signers.
    function getOwners() external view returns (address[] memory);
}

/// @title MainnetConfig
/// @notice The guarded-mainnet configuration for Robinhood Chain (4663), mainnet-launch §1–§2 (MN-R1…MN-R4 in
/// docs/prd/10-risk-compliance.md): the live Morpho Blue, Vault V2 factories, Stock Tokens, USDG, Chainlink feeds and
/// UniversalRouter from `packages/sdk/external-addresses.json` (Phase 0 verified), 48h timelocks, vault caps at 25% of
/// the D8 targets, D8 per-address and global caps, 10-risk oracle parameters, `sequencerFeed = address(0)`, and every
/// role from env with **no default** (A27 must not carry over). Nothing here broadcasts.
abstract contract MainnetConfig is ForkConfig, DnVaultDeploy {
    Vm private constant VM_M = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant MAINNET_TIMELOCK = 48 hours;
    /// @notice Launch caps are 25% of the D8 targets (mainnet-launch §2, list-stock §3).
    uint256 internal constant LAUNCH_CAP_BPS = 2500;
    uint256 internal constant MAINNET_GLOBAL_CAP = 4_000_000e6;
    /// @notice Minimum Safe thresholds (mainnet-launch §1): owner 4-of-7, guardian 2-of-4, other multisigs ≥ 2.
    uint256 internal constant OWNER_THRESHOLD = 4;
    uint256 internal constant OWNER_SIGNERS = 7;
    uint256 internal constant GUARDIAN_THRESHOLD = 2;
    uint256 internal constant GUARDIAN_SIGNERS = 4;
    uint256 internal constant MULTISIG_MIN_THRESHOLD = 2;

    /// @notice Every role holder of a mainnet deployment. Multisigs: owner, curator, guardian, treasury,
    /// backstopReserve. Keys (KMS/HSM): allocator, guardKeeper, feeKeeper, attestationSigner.
    struct Roles {
        address owner;
        address curator;
        address guardian;
        address allocator;
        address guardKeeper;
        address treasury;
        address backstopReserve;
        address feeKeeper;
        address attestationSigner;
    }

    /// @notice Phase 4 keys (KMS): the delta-neutral strategy operator (rebalancer) and the two NAV report signers
    /// (DN-R4). Distinct from each other and from the nine core roles (MN-R8).
    struct DnRoles {
        address operator;
        address navSigner1;
        address navSigner2;
    }

    /// @notice Phase 4 roles from `LENDORA_DN_OPERATOR`, `LENDORA_NAV_SIGNER_1`, `LENDORA_NAV_SIGNER_2`
    /// (required).
    function dnRolesFromEnv() public view returns (DnRoles memory) {
        return DnRoles({
            operator: VM_M.envAddress("LENDORA_DN_OPERATOR"),
            navSigner1: VM_M.envAddress("LENDORA_NAV_SIGNER_1"),
            navSigner2: VM_M.envAddress("LENDORA_NAV_SIGNER_2")
        });
    }

    /// @notice Roles from `LENDORA_*` env vars; each one is required (an unset var reverts).
    function mainnetRolesFromEnv() public view returns (Roles memory r) {
        r = Roles({
            owner: VM_M.envAddress("LENDORA_OWNER"),
            curator: VM_M.envAddress("LENDORA_CURATOR"),
            guardian: VM_M.envAddress("LENDORA_GUARDIAN"),
            allocator: VM_M.envAddress("LENDORA_ALLOCATOR"),
            guardKeeper: VM_M.envAddress("LENDORA_GUARD_KEEPER"),
            treasury: VM_M.envAddress("LENDORA_TREASURY"),
            backstopReserve: VM_M.envAddress("LENDORA_BACKSTOP_RESERVE"),
            feeKeeper: VM_M.envAddress("LENDORA_FEE_KEEPER"),
            attestationSigner: VM_M.envAddress("LENDORA_ATTESTATION_SIGNER")
        });
    }

    /// @notice Mainnet core config: live externals (4663 address book) and the given roles.
    function mainnetCoreConfig(address deployer, Roles memory r) public view returns (CoreConfig memory c) {
        c = forkCoreConfig(deployer); // live externals; its placeholder roles are all replaced below
        _applyMainnetRoles(c, r);
    }

    /// @dev Roles and the non-address launch parameters, shared by the 4663 config and the anvil rehearsal.
    function _applyMainnetRoles(CoreConfig memory c, Roles memory r) internal pure {
        c.owner = r.owner;
        c.curator = r.curator;
        c.guardian = r.guardian;
        c.allocator = r.allocator;
        c.guardKeeper = r.guardKeeper;
        c.treasury = r.treasury;
        c.backstopReserve = r.backstopReserve;
        c.feeKeeper = r.feeKeeper;
        c.attestationSigner = r.attestationSigner;
        c.timelockDelay = MAINNET_TIMELOCK;
        c.sequencerFeed = address(0); // none on 4663 (D3); L2_GAP keeper path
        c.globalCollateralCap = MAINNET_GLOBAL_CAP;
        c.swapMode = ILendoraRouter.SwapMode.Transfer; // Q4: UniversalRouter, pay-first
    }

    /// @notice Launch set on 4663 with caps at 25% of the D8 targets.
    function mainnetStocks() public view returns (StockConfig[] memory s) {
        s = _launchCaps(forkStocks());
    }

    /// @dev D8 targets → launch caps (25%); per-address caps unchanged (10 launch parameters).
    function _launchCaps(StockConfig[] memory s) internal pure returns (StockConfig[] memory) {
        for (uint256 i; i < s.length; i++) {
            s[i].launchCapUsd = s[i].launchCapUsd * LAUNCH_CAP_BPS / 10_000;
        }
        return s;
    }

    /// @notice The roles as (name, address) pairs, in a fixed order, for the checks and the launch log.
    function _roleList(CoreConfig memory c) internal pure returns (string[9] memory names, address[9] memory a) {
        names = [
            "owner",
            "curator",
            "guardian",
            "allocator",
            "guardKeeper",
            "treasury",
            "backstopReserve",
            "feeKeeper",
            "attestationSigner"
        ];
        a = [
            c.owner,
            c.curator,
            c.guardian,
            c.allocator,
            c.guardKeeper,
            c.treasury,
            c.backstopReserve,
            c.feeKeeper,
            c.attestationSigner
        ];
    }

    /// @notice MN-R1…MN-R3: refuse any mainnet config that is not the launch config. Reverts with the first problem.
    /// MN-R1 every role is non-zero, not a `lendora.placeholder.*` address, distinct from every other role and from
    /// the deployer. MN-R2 the five multisigs are contracts with Safe thresholds (owner 4-of-7, guardian 2-of-4, the
    /// rest ≥ 2), so an EOA or an undeployed placeholder is refused. MN-R3 48h timelock, no sequencer feed, $4M
    /// global
    /// cap, a swap target in `Transfer` mode, and every stock cap at 25% of its D8 target.
    function _assertMainnetConfig(CoreConfig memory c, StockConfig[] memory s, uint256[] memory d8TargetsUsd)
        internal
        view
    {
        (string[9] memory names, address[9] memory a) = _roleList(c);
        for (uint256 i; i < 9; i++) {
            require(a[i] != address(0), string.concat("MN-R1: role ", names[i], " is address(0)"));
            require(a[i] != c.deployer, string.concat("MN-R1: role ", names[i], " is the deployer"));
            require(!_isPlaceholder(a[i]), string.concat("MN-R1: role ", names[i], " is a placeholder address"));
            for (uint256 j = i + 1; j < 9; j++) {
                require(
                    a[i] != a[j],
                    string.concat("MN-R1: roles ", names[i], " and ", names[j], " are the same address (A27)")
                );
            }
        }
        _assertSafe(c.owner, "owner", OWNER_THRESHOLD, OWNER_SIGNERS);
        _assertSafe(c.guardian, "guardian", GUARDIAN_THRESHOLD, GUARDIAN_SIGNERS);
        _assertSafe(c.curator, "curator", MULTISIG_MIN_THRESHOLD, 0);
        _assertSafe(c.treasury, "treasury", MULTISIG_MIN_THRESHOLD, 0);
        _assertSafe(c.backstopReserve, "backstopReserve", MULTISIG_MIN_THRESHOLD, 0);

        require(c.timelockDelay == MAINNET_TIMELOCK, "MN-R3: timelock must be 48h");
        require(c.sequencerFeed == address(0), "MN-R3: no sequencer feed on 4663");
        require(c.globalCollateralCap == MAINNET_GLOBAL_CAP, "MN-R3: global clUSDG cap must be $4M");
        require(c.swapTarget != address(0), "MN-R3: swap target unset");
        require(c.swapMode == ILendoraRouter.SwapMode.Transfer, "MN-R3: swap mode must be Transfer (Q4)");
        require(s.length == d8TargetsUsd.length && s.length > 0, "MN-R3: stock list");
        for (uint256 i; i < s.length; i++) {
            require(
                s[i].launchCapUsd * 10_000 == d8TargetsUsd[i] * LAUNCH_CAP_BPS,
                string.concat("MN-R3: ", s[i].ticker, " launch cap must be 25% of the D8 target")
            );
            require(s[i].perAddressCapUsd > 0, string.concat("MN-R3: ", s[i].ticker, " per-address cap is 0"));
        }
    }

    /// @notice MN-R8: the Phase 4 keys are non-zero, not the deployer, distinct from each other and from every core
    /// role.
    function _assertDnRoles(CoreConfig memory c, DnRoles memory r) internal pure {
        address[3] memory dn = [r.operator, r.navSigner1, r.navSigner2];
        string[3] memory dnNames = ["dnOperator", "navSigner1", "navSigner2"];
        (string[9] memory names, address[9] memory a) = _roleList(c);
        for (uint256 i; i < 3; i++) {
            require(dn[i] != address(0), string.concat("MN-R8: role ", dnNames[i], " is address(0)"));
            require(dn[i] != c.deployer, string.concat("MN-R8: role ", dnNames[i], " is the deployer"));
            for (uint256 j = i + 1; j < 3; j++) {
                require(
                    dn[i] != dn[j], string.concat("MN-R8: roles ", dnNames[i], " and ", dnNames[j], " are the same")
                );
            }
            for (uint256 k; k < 9; k++) {
                require(dn[i] != a[k], string.concat("MN-R8: role ", dnNames[i], " equals core role ", names[k]));
            }
        }
    }

    /// @notice Phase 4 on 4663 (MN-R7): the vault, strategy and NAV oracle, **no venue adapter** (no live adapter is
    /// verified: task 12 `[VERIFY]` items) and every cap at 0 until the sim gate passes and the risk owner signs.
    function _deployMainnetDn(
        CoreConfig memory c,
        Core memory core,
        StockConfig[] memory s,
        StockDeployment[] memory ds,
        DnRoles memory r
    ) internal returns (DnDeployment memory) {
        address[] memory signers = new address[](2);
        signers[0] = r.navSigner1;
        signers[1] = r.navSigner2;
        return
            _deployDnVault(
                _dnConfig(c, core, r.operator, signers, false, 0), _dnSleeves(s, ds, new uint128[](s.length))
            );
    }

    /// @notice D8 cap targets (USD) of `forkStocks()`, in the same order: SPY $1M, NVDA $1M, AAPL $250k.
    function d8Targets() public pure returns (uint256[] memory t) {
        t = new uint256[](3);
        t[0] = 1_000_000;
        t[1] = 1_000_000;
        t[2] = 250_000;
    }

    function _assertSafe(address safe, string memory name, uint256 minThreshold, uint256 minSigners) internal view {
        require(safe.code.length > 0, string.concat("MN-R2: ", name, " must be a deployed multisig, not an EOA"));
        uint256 t = _safeThreshold(safe);
        uint256 n = _safeSigners(safe);
        require(t >= minThreshold && t <= n, string.concat("MN-R2: ", name, " multisig threshold too low"));
        require(n >= minSigners, string.concat("MN-R2: ", name, " multisig has too few signers"));
    }

    function _safeThreshold(address safe) internal view returns (uint256 t) {
        (bool ok, bytes memory ret) = safe.staticcall(abi.encodeCall(ISafeMin.getThreshold, ()));
        if (ok && ret.length >= 32) t = abi.decode(ret, (uint256));
    }

    function _safeSigners(address safe) internal view returns (uint256 n) {
        (bool ok, bytes memory ret) = safe.staticcall(abi.encodeCall(ISafeMin.getOwners, ()));
        if (ok && ret.length >= 64) n = abi.decode(ret, (address[])).length;
    }

    function _isPlaceholder(address a) internal pure returns (bool) {
        string[9] memory names = [
            "owner",
            "curator",
            "guardian",
            "allocator",
            "guardKeeper",
            "treasury",
            "backstopReserve",
            "feeKeeper",
            "attestationSigner"
        ];
        for (uint256 i; i < 9; i++) {
            if (a == _placeholder(names[i])) return true;
        }
        return false;
    }

    /// @notice The full deployment in order (core → each stock → finalize → lens), after the checks.
    function _deployMainnet(CoreConfig memory c, StockConfig[] memory s)
        internal
        returns (Core memory core, StockDeployment[] memory ds)
    {
        core = _deployCore(c, s);
        ds = new StockDeployment[](s.length);
        for (uint256 i; i < s.length; i++) {
            ds[i] = _deployStock(c, core, s[i]);
        }
        core = _finalize(c, core);
        core = _deployLens(core, s);
    }
}
