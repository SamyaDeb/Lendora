// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

// Forces compilation of the unmodified Morpho Vault V2 factories (solc 0.8.28, via-IR, 100k runs; see foundry.toml)
// so scripts and tests can `deployCode` them on anvil. On Robinhood Chain the live official factories are used.
import {VaultV2Factory} from "../../../lib/vault-v2/src/VaultV2Factory.sol";
import {MorphoMarketV1AdapterV2Factory} from "../../../lib/vault-v2/src/adapters/MorphoMarketV1AdapterV2Factory.sol";
