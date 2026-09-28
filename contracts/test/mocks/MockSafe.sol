// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

/// @notice Safe-like multisig placeholder for mainnet rehearsals (task 7): the two views the mainnet checks read
/// (`getThreshold`, `getOwners`) and a contract address that tests prank as. It executes nothing itself.
contract MockSafe {
    address[] internal _owners;
    uint256 internal _threshold;

    constructor(uint256 threshold_, uint256 signers, string memory label) {
        _threshold = threshold_;
        for (uint256 i; i < signers; i++) {
            _owners.push(address(uint160(uint256(keccak256(abi.encode(label, i))))));
        }
    }

    function getThreshold() external view returns (uint256) {
        return _threshold;
    }

    function getOwners() external view returns (address[] memory) {
        return _owners;
    }

    receive() external payable {}
}
