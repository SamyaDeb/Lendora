// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

/// @notice Optional access control for the mocks, off by default (tests and anvil keep open setters). The testnet
/// deployment turns it on (`setGated(true)`), so only operators (the deployer, the feed-mirror keeper, the faucet)
/// can move feeds, DEX rates, pauses and mints: a public testnet must not let anyone rewrite prices.
abstract contract MockGate {
    address public gateAdmin;
    bool public gated;
    mapping(address => bool) public isOperator;

    error NotOperator(address caller);
    error NotGateAdmin(address caller);

    event GateSet(bool gated);
    event OperatorSet(address indexed operator, bool allowed);

    constructor() {
        gateAdmin = msg.sender;
    }

    modifier gate() {
        if (gated && !isOperator[msg.sender]) revert NotOperator(msg.sender);
        _;
    }

    function setGated(bool on) external {
        if (msg.sender != gateAdmin) revert NotGateAdmin(msg.sender);
        gated = on;
        emit GateSet(on);
    }

    function setOperator(address operator, bool allowed) external {
        if (msg.sender != gateAdmin) revert NotGateAdmin(msg.sender);
        isOperator[operator] = allowed;
        emit OperatorSet(operator, allowed);
    }

    function transferGateAdmin(address admin) external {
        if (msg.sender != gateAdmin) revert NotGateAdmin(msg.sender);
        gateAdmin = admin;
    }
}
