// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HegotaSupport} from "@forshtat/hegota-support/contracts/HegotaSupport.sol";
import {Devnet} from "@forshtat/hegota-support/contracts/Devnet.sol";
import {Scope} from "@forshtat/hegota-support/contracts/Params.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";

/// @notice Negative control for the live proof. It reads only PoolManager storage and keeps nothing of its own, so a
/// rejection of this contract can only be about the PoolManager read. Immutables live in code, not storage.
contract PoolReadProbe is HegotaSupport(Devnet.ERC8421_WORKSHOP) {
    using StateLibrary for IPoolManager;

    IPoolManager internal immutable MANAGER;
    PoolId internal immutable POOL;

    constructor(IPoolManager manager, PoolId pool) payable {
        MANAGER = manager;
        POOL = pool;
    }

    fallback() external payable {
        (uint160 sqrtPriceX96,,,) = MANAGER.getSlot0(POOL);
        require(sqrtPriceX96 != 0, "no pool");
        approve(Scope.PAYMENT);
    }
}
