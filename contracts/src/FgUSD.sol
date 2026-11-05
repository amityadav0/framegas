// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @title fgUSD
/// @notice Demo stablecoin shaped like mainnet USDC: 6 decimals and EIP-2612 permit.
/// @dev Fixed supply minted once to the deployer. There is no owner and no later mint.
contract FgUSD is ERC20Permit {
    /// @param initialSupply Whole supply in base units, minted to the deployer.
    constructor(uint256 initialSupply) ERC20("FrameGas USD", "fgUSD") ERC20Permit("FrameGas USD") {
        _mint(msg.sender, initialSupply);
    }

    /// @inheritdoc ERC20
    function decimals() public pure override returns (uint8) {
        return 6;
    }
}
