// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {FgUSD} from "../src/FgUSD.sol";
import {FrameGasPaymaster} from "../src/FrameGasPaymaster.sol";
import {IStakingRegistry} from "../src/IStakingRegistry.sol";
import {FrameMocks, MockFrameDataLoad, MockFrameParam, MockTxParam} from "./FrameMocks.sol";

contract MockRegistry is IStakingRegistry {
    mapping(address => uint256) internal stakes;
    mapping(address => uint32) internal delays;

    function addStake(uint32 unstakeDelaySec) external payable {
        stakes[msg.sender] += msg.value;
        delays[msg.sender] = unstakeDelaySec;
    }

    function getDepositInfo(address account) external view returns (uint256, uint32, uint64) {
        return (stakes[account], delays[account], 0);
    }
}

abstract contract PaymasterBase is FrameMocks {
    using StateLibrary for IPoolManager;

    event Approved(uint256 scope);

    uint24 internal constant FEE = 3000;
    int24 internal constant SPACING = 60;
    int24 internal constant MAX_DEVIATION = 1000;
    uint256 internal constant BUFFER_BPS = 500;
    uint256 internal constant STAKE = 0.012 ether;
    uint256 internal constant FLOAT = 0.02 ether;
    uint256 internal constant MAX_GAS = 700_000;
    uint256 internal constant MAX_FEE = 2 gwei;
    uint256 internal constant MAX_COST = MAX_GAS * MAX_FEE;
    uint256 internal constant CAP = 5e6;
    uint256 internal constant MIN_SETTLE_GAS = 200_000;
    uint256 internal constant MIN_SETTLE_STATE = 50_000;
    uint256 internal constant MIN_SETTLE_PERMIT_STATE = 300_000;
    uint256 internal constant MIN_APPROVE_GAS = 30_000;
    uint256 internal constant MIN_APPROVE_STATE = 97_920;
    uint256 internal constant MAX_TX_COST = 0.005 ether;
    uint256 internal constant REFUND_ESTIMATE = 250_000;
    uint160 internal constant SQRT_PRICE = 3870497721706919791279764;
    uint256 internal constant MAX_S = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    uint256 internal constant SECP_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    uint256 internal constant USER_KEY = 0xA11CE;

    uint256 internal constant VERIFY_FRAME = 1;
    uint256 internal constant SETTLE_FRAME = 2;
    uint256 internal constant USER_FRAME = 3;
    uint256 internal constant REFUND_FRAME = 4;

    // Frame parameter ids.
    uint256 internal constant TARGET = 0;
    uint256 internal constant GAS_LIMIT = 1;
    uint256 internal constant MODE = 2;
    uint256 internal constant STATUS = 5;
    uint256 internal constant DATA_LENGTH = 4;
    uint256 internal constant ATOMIC = 7;
    uint256 internal constant VALUE = 8;
    uint256 internal constant STATE_LIMIT = 9;
    uint256 internal constant GAS_USED = 10;
    uint256 internal constant STATE_USED = 11;

    address internal user;
    IPoolManager internal manager;
    FgUSD internal token;
    MockRegistry internal registry;
    PoolKey internal key;
    PoolSwapTest internal swapper;
    FrameGasPaymaster internal paymaster;
    MockTxParam internal txp;
    MockFrameParam internal fp;
    MockFrameDataLoad internal data;

    /// @dev The liquidity and swap routers refund unused ETH to this contract.
    receive() external payable {}

    function setUp() public {
        user = vm.addr(USER_KEY);
        manager = IPoolManager(deployCode("PoolManager.sol:PoolManager", abi.encode(address(this))));
        token = new FgUSD(1_000_000e6);
        registry = new MockRegistry();
        key = PoolKey(Currency.wrap(address(0)), Currency.wrap(address(token)), FEE, SPACING, IHooks(address(0)));
        manager.initialize(key, SQRT_PRICE);

        PoolModifyLiquidityTest lp = new PoolModifyLiquidityTest(manager);
        swapper = new PoolSwapTest(manager);
        token.approve(address(lp), type(uint256).max);
        token.approve(address(swapper), type(uint256).max);
        lp.modifyLiquidity{value: 100 ether}(key, ModifyLiquidityParams(-204600, -192600, 5e13, 0), "");

        paymaster = _deploy(STAKE, REFUND_ESTIMATE);
        (txp, fp, data) = etchFrameMocks(address(paymaster));
        token.transfer(user, 100e6);
        vm.prank(user);
        token.approve(address(paymaster), CAP);
        _standardTx(_settleData(CAP, 0, 0, 0));
    }

    function _deploy(uint256 stake, uint256 refundEstimate) internal returns (FrameGasPaymaster) {
        return new FrameGasPaymaster{value: stake + FLOAT}(
            FrameGasPaymaster.Config({
                poolManager: manager,
                registry: registry,
                payToken: IERC20(address(token)),
                fee: FEE,
                tickSpacing: SPACING,
                maxDeviation: MAX_DEVIATION,
                bufferBps: BUFFER_BPS,
                stakeAmount: stake,
                unstakeDelaySec: 86400,
                minSettleGas: MIN_SETTLE_GAS,
                minSettleStateGas: MIN_SETTLE_STATE,
                minSettlePermitStateGas: MIN_SETTLE_PERMIT_STATE,
                minApproveGas: MIN_APPROVE_GAS,
                minApproveStateGas: MIN_APPROVE_STATE,
                approveNeedsZero: false,
                maxTxCostWei: MAX_TX_COST,
                refundGasEstimate: refundEstimate
            })
        );
    }

    function _settleData(uint256 cap, uint8 v, bytes32 r, bytes32 s) internal pure returns (bytes memory) {
        return abi.encodeCall(FrameGasPaymaster.settle, (cap, v, r, s));
    }

    /// @dev `[VERIFY sender, VERIFY paymaster, SENDER settle, SENDER user, SENDER refund]`, about to run validation.
    function _standardTx(bytes memory settleData) internal {
        txp.set(0x02, uint256(uint160(user)));
        txp.set(0x04, MAX_FEE);
        txp.set(0x06, MAX_COST);
        txp.set(0x09, 5);
        txp.set(0x0A, VERIFY_FRAME);
        _frame(0, user, 1, 30_000, 0);
        _frame(VERIFY_FRAME, address(paymaster), 1, 60_000, 0);
        _frame(SETTLE_FRAME, address(paymaster), 2, MIN_SETTLE_GAS, MIN_SETTLE_STATE);
        _frame(USER_FRAME, address(0xCAFE), 2, 50_000, 0);
        _frame(REFUND_FRAME, address(paymaster), 2, 250_000, 0);
        _setSettleData(SETTLE_FRAME, settleData);
    }

    function _setSettleData(uint256 frame, bytes memory settleData) internal {
        data.set(frame, settleData);
        fp.set(frame, DATA_LENGTH, settleData.length);
    }

    function _frame(uint256 i, address target, uint256 mode, uint256 gasLimit, uint256 stateLimit) internal {
        fp.set(i, TARGET, uint256(uint160(target)));
        fp.set(i, MODE, mode);
        fp.set(i, GAS_LIMIT, gasLimit);
        fp.set(i, STATE_LIMIT, stateLimit);
        fp.set(i, ATOMIC, 0);
        fp.set(i, VALUE, 0);
    }

    /// @dev What the chain reports once frames before the refund have finished.
    function _finishFramesBeforeRefund(uint256 settleStatus) internal {
        uint256[4] memory used = [uint256(100), 45_000, 150_000, 3_000];
        for (uint256 i = 0; i < 4; i++) {
            fp.set(i, GAS_USED, used[i]);
            fp.set(i, STATE_USED, 0);
            fp.set(i, STATUS, 1);
        }
        fp.set(SETTLE_FRAME, STATUS, settleStatus);
        txp.set(0x0A, REFUND_FRAME);
        data.set(USER_FRAME, "");
    }

    function _settleAsChain() internal {
        // APPROVE collects the maximum cost before any execution frame runs.
        vm.deal(address(paymaster), address(paymaster).balance - MAX_COST);
        txp.set(0x0A, SETTLE_FRAME);
        vm.prank(user);
        paymaster.settle(CAP, 0, 0, 0);
    }

    function _permitSig(uint256 signerKey, uint256 value, uint256 nonce, uint256 deadline)
        internal
        view
        returns (uint8, bytes32, bytes32)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                user,
                address(paymaster),
                value,
                nonce,
                deadline
            )
        );
        return vm.sign(signerKey, keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash)));
    }

    function _moveTickTo(int24 target) internal {
        (, int24 tick,,) = manager.getSlot0(key.toId());
        bool zeroForOne = target < tick;
        swapper.swap{value: zeroForOne ? 50 ether : 0}(
            key,
            SwapParams(zeroForOne, -int256(1e30), TickMath.getSqrtPriceAtTick(target)),
            PoolSwapTest.TestSettings(false, false),
            ""
        );
    }

    function _expectApprove() internal {
        vm.expectEmit(address(paymaster));
        emit Approved(1);
    }
}
