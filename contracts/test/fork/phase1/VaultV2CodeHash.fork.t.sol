// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Phase1ForkBase} from "./Phase1ForkBase.sol";
import {
    IVaultV2FactoryMin,
    IMorphoMarketV1AdapterV2FactoryMin
} from "../../../src/interfaces/external/IMorphoVaultV2.sol";

/// @notice LM-R20: the `vault-v2` submodule (tag 2025-12-04, 425f6b1, compiled per foundry.toml) is the code Morpho
/// deployed on Robinhood Chain. Compares runtime code built from our pinned source with the live official factories and
/// with contracts they create. Differences are explained, not ignored: they are exactly the immutables.
contract VaultV2CodeHashForkTest is Phase1ForkBase {
    address internal constant LIVE_VAULT_FACTORY = 0x0FBad98595b0186dA120E41f77C102beb49f803c;
    address internal constant LIVE_ADAPTER_FACTORY = 0x79370Ed003CE325C088E530d5e8655c99c2993e1;
    address internal constant STEAKHOUSE_USDG = 0xBeEff033F34C046626B8D0A041844C5d1A5409dd;

    function test_LM_R20_factoriesAreByteIdentical() public {
        address ours = deployCode("out/VaultV2Factory.sol/VaultV2Factory.json");
        assertEq(keccak256(ours.code), keccak256(LIVE_VAULT_FACTORY.code), "VaultV2Factory runtime code");
        assertGt(ours.code.length, 1000);

        // The adapter factory's only immutables are (morpho, irm); built with the live values it is identical.
        address oursAdapter = deployCode(
            "out/MorphoMarketV1AdapterV2Factory.sol/MorphoMarketV1AdapterV2Factory.json",
            abi.encode(MORPHO, ADAPTIVE_CURVE_IRM)
        );
        assertEq(IMorphoMarketV1AdapterV2FactoryMin(LIVE_ADAPTER_FACTORY).morpho(), MORPHO);
        assertEq(IMorphoMarketV1AdapterV2FactoryMin(LIVE_ADAPTER_FACTORY).adaptiveCurveIrm(), ADAPTIVE_CURVE_IRM);
        assertEq(keccak256(oursAdapter.code), keccak256(LIVE_ADAPTER_FACTORY.code), "adapter factory runtime code");
    }

    /// A vault from our pinned factory and one from the live factory, same (owner, asset): identical runtime code and
    /// code hash (VaultV2's immutables `asset`, `decimals`, `virtualShares` depend only on the asset).
    function test_LM_R20_vaultRuntimeCodeHashMatchesLiveFactory() public {
        address ours = deployCode("out/VaultV2Factory.sol/VaultV2Factory.json");
        address owner = makeAddr("owner");
        address vLive = IVaultV2FactoryMin(LIVE_VAULT_FACTORY).createVaultV2(owner, NVDA, bytes32("stockline"));
        address vOurs = IVaultV2FactoryMin(ours).createVaultV2(owner, NVDA, bytes32("stockline"));
        assertTrue(IVaultV2FactoryMin(LIVE_VAULT_FACTORY).isVaultV2(vLive));
        assertEq(vLive.codehash, vOurs.codehash, "VaultV2 code hash");
        emit log_named_bytes32("VaultV2 runtime codehash (asset NVDA)", vLive.codehash);

        // An existing production vault (Steakhouse USDG, 6-dp asset) differs only in its immutables.
        address vUsdg = IVaultV2FactoryMin(ours).createVaultV2(owner, USDG, bytes32("stockline"));
        assertEq(
            keccak256(_masked(vUsdg.code, "out/VaultV2.sol/VaultV2.json")),
            keccak256(_masked(STEAKHOUSE_USDG.code, "out/VaultV2.sol/VaultV2.json")),
            "Steakhouse USDG vault equals ours outside immutables"
        );
        assertEq(vUsdg.codehash, STEAKHOUSE_USDG.codehash, "same asset, so even the immutables match");
    }

    /// Adapters embed their factory, parent vault and derived `adapterId` as immutables, so their code hashes differ by
    /// construction; with the immutable ranges masked (from the compiler's `immutableReferences`) they are identical.
    function test_LM_R20_adapterEqualOutsideImmutables() public {
        address oursVF = deployCode("out/VaultV2Factory.sol/VaultV2Factory.json");
        address oursAF = deployCode(
            "out/MorphoMarketV1AdapterV2Factory.sol/MorphoMarketV1AdapterV2Factory.json",
            abi.encode(MORPHO, ADAPTIVE_CURVE_IRM)
        );
        address owner = makeAddr("owner");
        address vLive = IVaultV2FactoryMin(LIVE_VAULT_FACTORY).createVaultV2(owner, NVDA, bytes32("a"));
        address vOurs = IVaultV2FactoryMin(oursVF).createVaultV2(owner, NVDA, bytes32("a"));
        address aLive = IMorphoMarketV1AdapterV2FactoryMin(LIVE_ADAPTER_FACTORY).createMorphoMarketV1AdapterV2(vLive);
        address aOurs = IMorphoMarketV1AdapterV2FactoryMin(oursAF).createMorphoMarketV1AdapterV2(vOurs);
        assertTrue(aLive.codehash != aOurs.codehash, "immutables differ (factory, parentVault, adapterId)");
        string memory art = "out/MorphoMarketV1AdapterV2.sol/MorphoMarketV1AdapterV2.json";
        assertEq(keccak256(_masked(aLive.code, art)), keccak256(_masked(aOurs.code, art)), "adapter code");
    }

    /// @dev Zero every immutable slot listed in the artifact's `deployedBytecode.immutableReferences`.
    function _masked(bytes memory code, string memory artifact) internal view returns (bytes memory) {
        string memory json = vm.readFile(artifact);
        string[] memory ids = vm.parseJsonKeys(json, ".deployedBytecode.immutableReferences");
        for (uint256 i; i < ids.length; i++) {
            string memory base = string.concat(".deployedBytecode.immutableReferences.", ids[i]);
            uint256 n = abi.decode(vm.parseJson(json, base), (Ref[])).length;
            for (uint256 j; j < n; j++) {
                string memory p = string.concat(base, "[", vm.toString(j), "]");
                uint256 start = vm.parseJsonUint(json, string.concat(p, ".start"));
                uint256 len = vm.parseJsonUint(json, string.concat(p, ".length"));
                for (uint256 k; k < len; k++) {
                    code[start + k] = 0;
                }
            }
        }
        return code;
    }

    struct Ref {
        uint256 length;
        uint256 start;
    }
}
