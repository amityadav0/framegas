// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HegotaSupport} from "@forshtat/hegota-support/contracts/HegotaSupport.sol";
import {Devnet} from "@forshtat/hegota-support/contracts/Devnet.sol";
import {Scope} from "@forshtat/hegota-support/contracts/Params.sol";

/// @notice Test fixture that pays for anything. It sets up a contract wallet that cannot sign a permit.
contract UnconditionalPaymaster is HegotaSupport(Devnet.ERC8421_WORKSHOP) {
    constructor() payable {}

    fallback() external payable {
        approve(Scope.PAYMENT);
    }
}
