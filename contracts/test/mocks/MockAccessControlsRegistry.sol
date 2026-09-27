// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {MockGate} from "./MockGate.sol";

import {IAccessControlsRegistry} from "../../src/interfaces/external/IRobinhoodStock.sol";

/// @notice Stand-in for Robinhood's `AccessControlsRegistry`: blocklist and global pause shared by every mock Stock
/// Token that points at it. Events match the live registry. Setters are open: test use only.
contract MockAccessControlsRegistry is IAccessControlsRegistry, MockGate {
    mapping(address => bool) public isBlocked;
    bool public paused;

    event Blocked(address indexed account);
    event Unblocked(address indexed account);
    event Paused();
    event Unpaused();

    function blockAccounts(address[] calldata accounts) external gate {
        for (uint256 i; i < accounts.length; i++) {
            isBlocked[accounts[i]] = true;
            emit Blocked(accounts[i]);
        }
    }

    function unblockAccounts(address[] calldata accounts) external gate {
        for (uint256 i; i < accounts.length; i++) {
            isBlocked[accounts[i]] = false;
            emit Unblocked(accounts[i]);
        }
    }

    function setBlocked(address account, bool blocked) external gate {
        isBlocked[account] = blocked;
        if (blocked) emit Blocked(account);
        else emit Unblocked(account);
    }

    function pause() external gate {
        paused = true;
        emit Paused();
    }

    function unpause() external gate {
        paused = false;
        emit Unpaused();
    }
}
