// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.19;

// Forces compilation of the unmodified Morpho Blue v1.0.0 core (solc 0.8.19) so tests can `deployCode` it.
import {Morpho} from "morpho-blue/src/Morpho.sol";
// Unmodified AdaptiveCurveIrm (morpho-blue-irm, nested in lib/vault-v2) for local deployments; forks use the live one.
import {AdaptiveCurveIrm} from "../../lib/vault-v2/lib/morpho-blue-irm/src/adaptive-curve-irm/AdaptiveCurveIrm.sol";
