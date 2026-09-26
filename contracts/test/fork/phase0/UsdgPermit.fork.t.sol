// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Phase0ForkBase} from "./Phase0ForkBase.sol";

/// @notice WS-B.6: EIP-2612 `permit` on real USDG (A7). USDG routes `permit` to a facet via its fallback.
contract UsdgPermitForkTest is Phase0ForkBase {
    bytes32 internal constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    function test_phase0_usdg_decimalsAndPermit() public {
        assertEq(IERC20Metadata(USDG).decimals(), 6, "A7: 6 decimals");

        (address owner, uint256 key) = makeAddrAndKey("permitOwner");
        address spender = makeAddr("router");
        uint256 value = 1234.5e6;
        uint256 deadline = block.timestamp + 1 hours;
        uint256 nonce = IERC20Permit(USDG).nonces(owner);
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                IERC20Permit(USDG).DOMAIN_SEPARATOR(),
                keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, nonce, deadline))
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        IERC20Permit(USDG).permit(owner, spender, value, deadline, v, r, s);

        assertEq(IERC20Metadata(USDG).allowance(owner, spender), value, "A7: permit set allowance");
        assertEq(IERC20Permit(USDG).nonces(owner), nonce + 1);

        vm.expectRevert(); // replay
        IERC20Permit(USDG).permit(owner, spender, value, deadline, v, r, s);
    }
}
