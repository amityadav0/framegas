// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title MockLendingPool
/// @notice A demo stand-in for a lending market, with Aave v3's `supply` and `withdraw` signatures. It holds deposits
///         one for one and pays no interest. It is a call target for the demo, not a lending protocol.
contract MockLendingPool {
    using SafeERC20 for IERC20;

    /// @notice Deposits held for each account, per asset.
    mapping(address asset => mapping(address account => uint256)) public supplied;

    event Supply(address indexed asset, address user, address indexed onBehalfOf, uint256 amount, uint16 indexed referralCode);
    event Withdraw(address indexed asset, address indexed user, address indexed to, uint256 amount);

    error InsufficientSupply(uint256 requested, uint256 available);

    /// @notice Pulls `amount` of `asset` from the caller and credits it to `onBehalfOf`.
    /// @param asset The token to deposit.
    /// @param amount The amount, in the token's base units.
    /// @param onBehalfOf The account credited.
    /// @param referralCode Unused, kept for Aave v3's signature.
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external {
        supplied[asset][onBehalfOf] += amount;
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
        emit Supply(asset, msg.sender, onBehalfOf, amount, referralCode);
    }

    /// @notice Returns up to the caller's deposit of `asset` to `to`.
    /// @param asset The token to withdraw.
    /// @param amount The amount, or type(uint256).max for all of it.
    /// @param to The recipient.
    /// @return The amount withdrawn.
    function withdraw(address asset, uint256 amount, address to) external returns (uint256) {
        uint256 available = supplied[asset][msg.sender];
        if (amount == type(uint256).max) amount = available;
        if (amount > available) revert InsufficientSupply(amount, available);
        supplied[asset][msg.sender] = available - amount;
        IERC20(asset).safeTransfer(to, amount);
        emit Withdraw(asset, msg.sender, to, amount);
        return amount;
    }
}
