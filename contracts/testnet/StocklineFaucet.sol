// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

/// @notice Mint surface of the testnet mocks (MockStockToken, MockUSDG) the faucet is an operator of.
interface IMintableMock {
    function mint(address to, uint256 amount) external;
}

/// @title StocklineFaucet (testnet only)
/// @notice Hands testers mock Stock Tokens and USDG on Robinhood Chain testnet (46630): each address can claim a fixed
/// drip once per `cooldown`. The faucet is an operator of the gated mocks; it holds no funds. Never deployed on
/// mainnet (the deploy script refuses any other chain).
contract StocklineFaucet {
    struct Drip {
        address token;
        uint256 amount;
    }

    address public owner;
    uint256 public cooldown;
    Drip[] internal _drips;
    mapping(address => uint256) public lastClaim;

    event Claimed(address indexed to);
    event DripSet(address indexed token, uint256 amount);
    event CooldownSet(uint256 cooldown);

    error TooSoon(uint256 nextClaimAt);
    error NotOwner();

    constructor(address owner_, uint256 cooldown_) {
        owner = owner_;
        cooldown = cooldown_;
    }

    function drips() external view returns (Drip[] memory) {
        return _drips;
    }

    /// @notice Mint every configured drip to `to` (anyone can claim for anyone; the cooldown is per recipient).
    function claim(address to) external {
        uint256 next = lastClaim[to] + cooldown;
        if (lastClaim[to] != 0 && block.timestamp < next) revert TooSoon(next);
        lastClaim[to] = block.timestamp;
        for (uint256 i; i < _drips.length; i++) {
            IMintableMock(_drips[i].token).mint(to, _drips[i].amount);
        }
        emit Claimed(to);
    }

    function setDrip(address token, uint256 amount) external {
        if (msg.sender != owner) revert NotOwner();
        for (uint256 i; i < _drips.length; i++) {
            if (_drips[i].token == token) {
                _drips[i].amount = amount;
                emit DripSet(token, amount);
                return;
            }
        }
        _drips.push(Drip(token, amount));
        emit DripSet(token, amount);
    }

    function setCooldown(uint256 cooldown_) external {
        if (msg.sender != owner) revert NotOwner();
        cooldown = cooldown_;
        emit CooldownSet(cooldown_);
    }
}
