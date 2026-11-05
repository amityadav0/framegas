// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IStakingRegistry
/// @notice The ERC-8421 staking registry. Every entry is keyed on `msg.sender`.
interface IStakingRegistry {
    /// @notice Locks `msg.value` as the caller's stake, with the given unstake delay.
    function addStake(uint32 unstakeDelaySec) external payable;

    /// @notice Returns the stake recorded for `account`.
    function getDepositInfo(address account)
        external
        view
        returns (uint256 stake, uint32 unstakeDelaySec, uint64 withdrawTime);
}
