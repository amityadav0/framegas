// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HegotaSupport} from "@forshtat/hegota-support/contracts/HegotaSupport.sol";
import {Devnet} from "@forshtat/hegota-support/contracts/Devnet.sol";
import {Scope, SigParam} from "@forshtat/hegota-support/contracts/Params.sol";

/// @title OwnerWallet
/// @notice Minimal single-owner contract wallet, used to measure how much validation gas a contract wallet needs.
/// @dev The protocol verifies the signature before any frame runs. The wallet only checks the verified signer. It
/// approves execution alone, leaving payment to a paymaster.
contract OwnerWallet is HegotaSupport(Devnet.ERC8421_WORKSHOP) {
    /// @notice The account allowed to authorise transactions.
    address public immutable OWNER;

    /// @dev The transaction was not signed by the owner.
    error NotOwner();

    /// @param owner The account allowed to authorise transactions.
    constructor(address owner) {
        OWNER = owner;
    }

    /// @notice The VERIFY frame targeting this wallet lands here.
    fallback() external {
        if (address(uint160(sigparam(0, SigParam.RESOLVED_SIGNER))) != OWNER) revert NotOwner();
        approve(Scope.EXECUTION);
    }
}
