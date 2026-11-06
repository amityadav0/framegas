// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {FgUSD} from "../src/FgUSD.sol";
import {MockLendingPool} from "../src/demo/MockLendingPool.sol";

contract MockLendingPoolTest is Test {
    FgUSD internal token;
    MockLendingPool internal pool;
    address internal constant USER = address(0xA11CE);

    function setUp() public {
        token = new FgUSD(1_000e6);
        pool = new MockLendingPool();
        token.transfer(USER, 10e6);
        vm.prank(USER);
        token.approve(address(pool), type(uint256).max);
    }

    function test_supplyPullsTokensAndCredits() public {
        vm.prank(USER);
        pool.supply(address(token), 5e6, USER, 0);
        assertEq(pool.supplied(address(token), USER), 5e6);
        assertEq(token.balanceOf(USER), 5e6);
        assertEq(token.balanceOf(address(pool)), 5e6);
    }

    function test_withdrawAllReturnsTheDeposit() public {
        vm.startPrank(USER);
        pool.supply(address(token), 5e6, USER, 0);
        assertEq(pool.withdraw(address(token), type(uint256).max, USER), 5e6);
        vm.stopPrank();
        assertEq(token.balanceOf(USER), 10e6);
        assertEq(pool.supplied(address(token), USER), 0);
    }

    function test_withdrawMoreThanSuppliedReverts() public {
        vm.startPrank(USER);
        pool.supply(address(token), 1e6, USER, 0);
        vm.expectRevert(abi.encodeWithSelector(MockLendingPool.InsufficientSupply.selector, 2e6, 1e6));
        pool.withdraw(address(token), 2e6, USER);
        vm.stopPrank();
    }

    function test_supplyWithoutAllowanceReverts() public {
        vm.prank(address(0xB0B));
        vm.expectRevert();
        pool.supply(address(token), 1, address(0xB0B), 0);
    }
}
