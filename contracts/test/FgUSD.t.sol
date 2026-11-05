// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {FgUSD} from "../src/FgUSD.sol";

contract FgUSDTest is Test {
    FgUSD internal token;
    uint256 internal constant OWNER_KEY = 0xA11CE;
    address internal owner;
    address internal constant SPENDER = address(0xBEEF);

    function setUp() public {
        token = new FgUSD(1_000_000e6);
        owner = vm.addr(OWNER_KEY);
    }

    function test_metadataMatchesUsdcShape() public view {
        assertEq(token.decimals(), 6);
        assertEq(token.symbol(), "fgUSD");
        assertEq(token.balanceOf(address(this)), 1_000_000e6);
    }

    function test_permitSetsAllowanceWithoutEthFromOwner() public {
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _sign(OWNER_KEY, 5e6, token.nonces(owner), deadline);
        assertEq(owner.balance, 0);
        token.permit(owner, SPENDER, 5e6, deadline, v, r, s);
        assertEq(token.allowance(owner, SPENDER), 5e6);
    }

    function test_permitRejectsWrongSigner() public {
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _sign(0xB0B, 5e6, 0, deadline);
        vm.expectRevert();
        token.permit(owner, SPENDER, 5e6, deadline, v, r, s);
    }

    function _sign(uint256 key, uint256 value, uint256 nonce, uint256 deadline)
        internal
        view
        returns (uint8, bytes32, bytes32)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                owner,
                SPENDER,
                value,
                nonce,
                deadline
            )
        );
        return vm.sign(key, keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash)));
    }
}
