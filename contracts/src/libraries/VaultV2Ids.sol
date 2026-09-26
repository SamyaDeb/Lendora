// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {MarketParams} from "morpho-blue/src/interfaces/IMorpho.sol";

/// @title VaultV2Ids
/// @notice Cap ids of a `MorphoMarketV1AdapterV2` market, exactly as `MorphoMarketV1AdapterV2.ids()` computes them
/// (vault-v2 @ 425f6b1). Vault V2 caps are keyed by `keccak256(idData)`.
library VaultV2Ids {
    function adapterIdData(address adapter) internal pure returns (bytes memory) {
        return abi.encode("this", adapter);
    }

    function collateralIdData(address collateralToken) internal pure returns (bytes memory) {
        return abi.encode("collateralToken", collateralToken);
    }

    function marketIdData(address adapter, MarketParams memory mp) internal pure returns (bytes memory) {
        return abi.encode("this/marketParams", adapter, mp);
    }

    function marketId(address adapter, MarketParams memory mp) internal pure returns (bytes32) {
        return keccak256(marketIdData(adapter, mp));
    }
}
