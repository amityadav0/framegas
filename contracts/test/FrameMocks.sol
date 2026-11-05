// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

/// @dev The test EVM has no frame opcodes. HegotaSupport creates its helpers in a fixed order from nonce 1, so their
/// addresses are known and stand-ins can be etched there.
abstract contract FrameMocks is Test {
    uint256 private constant APPROVE_NONCE = 1;
    uint256 private constant TX_PARAM_NONCE = 2;
    uint256 private constant FRAME_DATA_LOAD_NONCE = 3;
    uint256 private constant FRAME_PARAM_NONCE = 5;

    function etchFrameMocks(address account) internal returns (MockTxParam, MockFrameParam, MockFrameDataLoad) {
        vm.etch(vm.computeCreateAddress(account, APPROVE_NONCE), address(new MockApprove()).code);
        address txParam = vm.computeCreateAddress(account, TX_PARAM_NONCE);
        address frameParam = vm.computeCreateAddress(account, FRAME_PARAM_NONCE);
        address dataLoad = vm.computeCreateAddress(account, FRAME_DATA_LOAD_NONCE);
        vm.etch(txParam, address(new MockTxParam()).code);
        vm.etch(frameParam, address(new MockFrameParam()).code);
        vm.etch(dataLoad, address(new MockFrameDataLoad()).code);
        return (MockTxParam(payable(txParam)), MockFrameParam(payable(frameParam)), MockFrameDataLoad(payable(dataLoad)));
    }
}

contract MockApprove {
    event Approved(uint256 scope);

    fallback() external payable {
        emit Approved(abi.decode(msg.data, (uint256)));
    }
}

contract MockTxParam {
    mapping(uint256 => uint256) internal values;

    function set(uint256 param, uint256 value) external {
        values[param] = value;
    }

    receive() external payable {}

    fallback() external payable {
        uint256 value = values[abi.decode(msg.data, (uint256))];
        assembly {
            mstore(0, value)
            return(0, 32)
        }
    }
}

/// @dev Like the real opcode, it halts for a frame or parameter that has no value: a frame past the end, or the gas
/// used of a frame still running.
contract MockFrameParam {
    mapping(uint256 => mapping(uint256 => uint256)) internal values;
    mapping(uint256 => mapping(uint256 => bool)) internal present;

    function set(uint256 frame, uint256 param, uint256 value) external {
        values[frame][param] = value;
        present[frame][param] = true;
    }

    receive() external payable {}

    fallback() external payable {
        (uint256 frame, uint256 param) = abi.decode(msg.data, (uint256, uint256));
        if (!present[frame][param]) revert("exceptional halt");
        uint256 value = values[frame][param];
        assembly {
            mstore(0, value)
            return(0, 32)
        }
    }
}

contract MockFrameDataLoad {
    mapping(uint256 => bytes) internal data;

    function set(uint256 frame, bytes calldata value) external {
        data[frame] = value;
    }

    receive() external payable {}

    fallback() external payable {
        (uint256 offset, uint256 frame) = abi.decode(msg.data, (uint256, uint256));
        bytes memory source = data[frame];
        bytes32 word;
        for (uint256 i = 0; i < 32 && offset + i < source.length; i++) {
            word |= bytes32(source[offset + i]) >> (i * 8);
        }
        assembly {
            mstore(0, word)
            return(0, 32)
        }
    }
}
