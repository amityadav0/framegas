// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// PoolManager pins solc 0.8.26 and HegotaSupport pins 0.8.28, so no file can import both. Importing it here gets it
// compiled on its own, and tests deploy the artifact with `deployCode`.
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
