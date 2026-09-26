// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @notice Test USDG: plain ERC-20 with EIP-2612 permit and open mint. 6 decimals like Paxos USDG on other chains;
/// [VERIFY] A7: decimals and permit support of USDG on Robinhood Chain.
contract MockUSDG is ERC20, ERC20Permit {
    uint8 internal immutable _decimals;

    constructor(uint8 decimals_) ERC20("Global Dollar", "USDG") ERC20Permit("Global Dollar") {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        _burn(from, amount);
    }
}
