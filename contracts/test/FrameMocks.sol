// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

/// @dev The test EVM has no frame opcodes. HegotaSupport creates its helpers in a fixed order from nonce 1, so their
/// addresses are known and stand-ins can be etched there.
abstract contract FrameMocks is Test {
    uint256 private constant APPROVE_NONCE = 1;
    uint256 private constant TX_PARAM_NONCE = 2;

    function mockFrame(address account, address sender, uint256 maxCost) internal {
        vm.etch(vm.computeCreateAddress(account, APPROVE_NONCE), address(new MockApprove()).code);
        address txParam = vm.computeCreateAddress(account, TX_PARAM_NONCE);
        vm.etch(txParam, address(new MockTxParam()).code);
        MockTxParam(payable(txParam)).set(0x02, uint256(uint160(sender)));
        MockTxParam(payable(txParam)).set(0x06, maxCost);
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

    fallback() external payable {
        uint256 value = values[abi.decode(msg.data, (uint256))];
        assembly {
            mstore(0, value)
            return(0, 32)
        }
    }
}
