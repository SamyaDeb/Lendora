// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Phase0ForkBase} from "./Phase0ForkBase.sol";

/// @dev Uses Cancun opcodes directly (TSTORE/TLOAD, MCOPY) plus PUSH0 (Shanghai), compiled with evm_version=cancun.
contract CancunProbe {
    function transientRoundTrip(uint256 x) external returns (uint256 y) {
        assembly {
            tstore(0x42, x)
            y := tload(0x42)
        }
    }

    function mcopyRoundTrip(bytes memory data) external pure returns (bytes memory out) {
        out = new bytes(data.length);
        assembly {
            mcopy(add(out, 0x20), add(data, 0x20), mload(data))
        }
    }

    function blobBaseFee() external view returns (uint256 f) {
        assembly {
            f := blobbasefee()
        }
    }
}

/// @notice WS-B.7: a contract built for `cancun` deploys and runs against Robinhood Chain state (A4).
/// @dev A fork runs Foundry's EVM, not Nitro, so this proves the toolchain path. The chain-side proof is that live
/// contracts compiled for cancun run there (Stock Token implementation, Sourcify evmVersion "cancun"); see
/// docs/phase0/01-chain-facts.md.
contract EvmVersionForkTest is Phase0ForkBase {
    function test_phase0_evm_cancunOpcodes() public {
        CancunProbe p = new CancunProbe();
        assertEq(p.transientRoundTrip(7), 7, "TSTORE/TLOAD");
        bytes memory d = hex"00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff0102";
        assertEq(p.mcopyRoundTrip(d), d, "MCOPY");
        p.blobBaseFee();
    }
}
