// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {MockGate} from "./MockGate.sol";

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @notice Test USDG: plain ERC-20 with EIP-2612 permit and open mint. Real USDG on Robinhood Chain has 6 decimals and
/// EIP-2612 `permit` (A7, verified Phase 0 on a fork: test/fork/phase0/UsdgPermit.fork.t.sol).
contract MockUSDG is ERC20, ERC20Permit, MockGate {
    uint8 internal immutable _decimals;

    constructor(uint8 decimals_) ERC20("Global Dollar", "USDG") ERC20Permit("Global Dollar") {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external gate {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external gate {
        _burn(from, amount);
    }
}
