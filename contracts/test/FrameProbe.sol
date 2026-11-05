// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HegotaSupport} from "@forshtat/hegota-support/contracts/HegotaSupport.sol";
import {Devnet} from "@forshtat/hegota-support/contracts/Devnet.sol";
import {FrameParam, TxParam} from "@forshtat/hegota-support/contracts/Params.sol";

/// @notice Measures what the devnet's frame opcodes actually return. It is not part of the product.
contract FrameProbe is HegotaSupport(Devnet.ERC8421_WORKSHOP) {
    event Reading(uint256 frameIndex, uint256 param, bool ok, uint256 value);
    event Facts(uint256 gasPrice, uint256 baseFee, uint256 maxFee, uint256 maxPriority, uint256 maxCost, uint256 currentFrame, uint256 transientSeen, uint256 gasLeft);

    uint256 private constant MARK = 0xF00D;

    /// @notice Writes transient storage, so a later frame can show whether it survives.
    function mark() external {
        assembly {
            tstore(0, MARK)
        }
    }

    /// @dev External so that a halting opcode only fails this call.
    function readFrameParam(uint256 frameIndex, uint256 param) external view returns (uint256) {
        return frameparam(frameIndex, FrameParam(param));
    }

    /// @notice Emits every FRAMEPARAM id for every frame before and including this one, plus transaction facts.
    function probe() external {
        uint256 current = txparam(TxParam.CURRENT_FRAME_INDEX);
        uint256 seen;
        assembly {
            seen := tload(0)
        }
        emit Facts(
            tx.gasprice,
            block.basefee,
            txparam(TxParam.MAX_FEE),
            txparam(TxParam.MAX_PRIORITY_FEE_PER_GAS),
            txparam(TxParam.MAX_COST),
            current,
            seen,
            gasleft()
        );
        for (uint256 i = 0; i <= current; i++) {
            for (uint256 p = 0; p <= 11; p++) {
                try this.readFrameParam{gas: 20_000}(i, p) returns (uint256 value) {
                    emit Reading(i, p, true, value);
                } catch {
                    emit Reading(i, p, false, 0);
                }
            }
        }
    }
}
