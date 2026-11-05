// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HegotaSupport} from "@forshtat/hegota-support/contracts/HegotaSupport.sol";
import {Devnet} from "@forshtat/hegota-support/contracts/Devnet.sol";
import {FrameMode, FrameParam, Scope, TxParam} from "@forshtat/hegota-support/contracts/Params.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {IStakingRegistry} from "./IStakingRegistry.sol";

/// @title FrameGasPaymaster
/// @notice Pays a frame transaction's gas in exchange for one ERC-20, priced and settled on a native-ETH Uniswap v4
/// pool. One instance serves one token and pool, fixed at deployment. There is no owner.
/// @dev Normal mode: `[VERIFY sender, VERIFY validate(), SENDER settle(...), SENDER user calls..., SENDER refund(...)]`.
/// Bootstrap mode, for a user with no allowance yet, puts `SENDER PAY_TOKEN.approve(this, n)` before the settle frame.
/// A permit in the settle frame is a third option where the mempool allows `ecrecover` in validation.
///
/// `validate` runs under the mempool's validation rules, so it reads no environment opcode. Its job is to make sure
/// settlement cannot fail for a reason the user controls, because later frames still run after a failed frame.
///
/// `APPROVE` collects the maximum cost from this contract before any execution frame runs, and `settle` buys exactly
/// that much ETH back. The chain returns the unused part after the last frame, so that part is surplus, and `refund`
/// sells a conservative estimate of it back to the user. A failed or omitted refund costs the user only the refund.
contract FrameGasPaymaster is HegotaSupport(Devnet.ERC8421_WORKSHOP), IUnlockCallback {
    using StateLibrary for IPoolManager;
    using SafeERC20 for IERC20;

    /// @notice Deployment parameters.
    /// @param poolManager The Uniswap v4 PoolManager.
    /// @param registry The ERC-8421 staking registry.
    /// @param payToken The token users pay in. It is currency1 of the pool, native ETH being currency0.
    /// @param fee The pool's fee.
    /// @param tickSpacing The pool's tick spacing.
    /// @param maxDeviation The largest accepted tick distance from `refTick`.
    /// @param bufferBps The quote buffer in basis points.
    /// @param stakeAmount The part of `msg.value` staked. Nothing can withdraw it later, as there is no owner.
    /// @param unstakeDelaySec The unstake delay recorded with the stake.
    /// @param minSettleGas The execution gas limit a settle frame must declare.
    /// @param minSettleStateGas The state gas limit a settle frame without a permit must declare.
    /// @param minSettlePermitStateGas The state gas limit a settle frame with a permit must declare.
    /// @param minApproveGas The execution gas limit a bootstrap approve frame must declare.
    /// @param minApproveStateGas The state gas limit a bootstrap approve frame must declare.
    /// @param approveNeedsZero Whether the token rejects changing a nonzero allowance, as USDT does.
    /// @param maxTxCostWei The largest maximum cost accepted, which bounds what one transaction can cost this contract.
    /// @param minLiquidity The active liquidity validation requires. Moving a thin pool past the quote buffer costs less
    /// in fees than the gas it can make this contract lose. See docs/findings.md for the depth where that flips.
    /// @param refundGasEstimate The gas charged for a refund frame with no frames before it. It cannot read its own gas
    /// used, and `REFUND_GAS_PER_FRAME` is added for each frame before it.
    struct Config {
        IPoolManager poolManager;
        IStakingRegistry registry;
        IERC20 payToken;
        uint24 fee;
        int24 tickSpacing;
        int24 maxDeviation;
        uint256 bufferBps;
        uint256 stakeAmount;
        uint32 unstakeDelaySec;
        uint256 minSettleGas;
        uint256 minSettleStateGas;
        uint256 minSettlePermitStateGas;
        uint256 minApproveGas;
        uint256 minApproveStateGas;
        bool approveNeedsZero;
        uint256 maxTxCostWei;
        uint128 minLiquidity;
        uint256 refundGasEstimate;
    }

    enum Action {
        Settle,
        Refund
    }

    uint256 private constant BPS = 10_000;
    uint256 private constant Q96 = 2 ** 96;
    /// @dev Half the secp256k1 order. OpenZeppelin's permit rejects a higher `s`, so validation must too.
    uint256 private constant MAX_S = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;
    bytes32 private constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    /// @dev Validation cannot read TIMESTAMP, so it cannot check a deadline. Only an unexpiring permit can be checked.
    uint256 private constant PERMIT_DEADLINE = type(uint256).max;
    uint256 private constant SUCCESS = 1;
    /// @dev `settle(uint256,uint8,bytes32,bytes32)`. Shorter data would pass validation, then revert in the decoder.
    uint256 private constant SETTLE_DATA_LENGTH = 132;
    /// @dev `approve(address,uint256)`, exactly.
    uint256 private constant APPROVE_DATA_LENGTH = 68;
    /// @dev Frame gas `refund` cannot see from inside: the frame's entry charge, and the code around its measurement.
    uint256 private constant REFUND_FRAME_OVERHEAD = 5_000;
    /// @notice The refund reads each earlier frame's gas accounting, so it costs more with more frames.
    uint256 public constant REFUND_GAS_PER_FRAME = 5_500;

    /// @notice The Uniswap v4 singleton holding the pool.
    IPoolManager public immutable POOL_MANAGER;
    /// @notice The token users pay gas in.
    IERC20 public immutable PAY_TOKEN;
    /// @notice The native-ETH/PAY_TOKEN pool used for pricing and settlement.
    PoolId public immutable POOL_ID;
    /// @notice The largest accepted distance, in ticks, between the pool's tick and `refTick`.
    int24 public immutable MAX_DEVIATION;
    /// @notice Added to the quote to absorb the pool fee and price movement before settlement, in basis points.
    uint256 public immutable BUFFER_BPS;
    /// @notice The execution gas limit a settle frame must declare.
    uint256 public immutable MIN_SETTLE_GAS;
    /// @notice The state gas limit a settle frame without a permit must declare.
    uint256 public immutable MIN_SETTLE_STATE_GAS;
    /// @notice The state gas limit a settle frame with a permit must declare.
    uint256 public immutable MIN_SETTLE_PERMIT_STATE_GAS;
    /// @notice The execution gas limit a bootstrap approve frame must declare.
    uint256 public immutable MIN_APPROVE_GAS;
    /// @notice The state gas limit a bootstrap approve frame must declare.
    uint256 public immutable MIN_APPROVE_STATE_GAS;
    /// @notice Whether the token rejects changing a nonzero allowance.
    bool public immutable APPROVE_NEEDS_ZERO;
    /// @notice The largest maximum cost accepted.
    uint256 public immutable MAX_TX_COST_WEI;
    /// @notice The active liquidity validation requires.
    uint128 public immutable MIN_LIQUIDITY;
    /// @notice The gas charged for a refund frame with no frames before it.
    uint256 public immutable REFUND_GAS_ESTIMATE;

    uint24 private immutable FEE;
    int24 private immutable TICK_SPACING;

    /// @notice The tick validation measures manipulation against.
    int24 public refTick;
    /// @notice The block `refTick` last moved in.
    uint64 public lastSyncBlock;

    /// @notice Emitted when `refTick` moves.
    event ReferenceSynced(int24 refTick, int24 poolTick);
    /// @notice Emitted when a user pays for a transaction's maximum gas cost.
    event Settled(address indexed user, uint256 tokensPaid, uint256 ethBought);
    /// @notice Emitted when a user gets back the estimated unused part.
    event Refunded(address indexed user, uint256 tokensReturned, uint256 ethSold);

    /// @dev The pool has not been initialised.
    error PoolNotInitialized();
    /// @dev The maximum deviation is not positive.
    error InvalidDeviation();
    /// @dev The pool's tick is too far from `refTick`.
    error TickDeviated(int24 poolTick, int24 refTick);
    /// @dev The quote for this transaction's maximum gas cost exceeds the user's cap.
    error CostAboveCap(uint256 tokenCost, uint256 maxTokenCost);
    /// @dev The user holds less than the cap, so settlement could fail after the paymaster has paid.
    error InsufficientBalance(uint256 balance, uint256 maxTokenCost);
    /// @dev The user allows less than the cap, so settlement could fail after the paymaster has paid.
    error InsufficientAllowance(uint256 allowance, uint256 maxTokenCost);
    /// @dev The frame after validation is not a SENDER frame calling `settle` on this contract.
    error SettleNotBound();
    /// @dev The settle frame is in an atomic batch, so a reverting user call could undo the payment.
    error SettleInAtomicBatch();
    /// @dev The settle frame declares too little gas, so the user could make settlement run out.
    error SettleGasTooLow(uint256 gasLimit, uint256 stateGasLimit);
    /// @dev The settle frame sends ETH or has the wrong data length, so the frame or its decoder would revert.
    error SettleMalformed();
    /// @dev The frame before settlement is not exactly `PAY_TOKEN.approve(this, n)` with `n` covering the cap.
    error ApproveNotBound();
    /// @dev The approve frame declares too little gas, so the user could make it, and then settlement, fail.
    error ApproveGasTooLow(uint256 gasLimit, uint256 stateGasLimit);
    /// @dev A permit is not accepted alongside a bootstrap approve frame.
    error PermitWithBootstrap();
    /// @dev The pool's active liquidity is below `MIN_LIQUIDITY`, so griefing would cost less than it destroys.
    error PoolTooThin(uint128 liquidity, uint128 minLiquidity);
    /// @dev The transaction's maximum cost is above `MAX_TX_COST_WEI`.
    error MaxCostTooHigh(uint256 maxCost, uint256 limit);
    /// @dev The permit in the settle frame would not succeed on the token.
    error InvalidPermit();
    /// @dev `syncReference` already ran in this block, or `refTick` already moved in it.
    error AlreadySynced();
    /// @dev The caller is not the transaction's sender.
    error NotTxSender();
    /// @dev The pool cannot supply the ETH needed.
    error InsufficientPoolLiquidity();
    /// @dev Only the PoolManager calls back.
    error NotPoolManager();
    /// @dev `refund` must be the last frame, targeting this contract directly.
    error RefundNotLastFrame();
    /// @dev The referenced frames are not a successful validation and settlement by this contract.
    error RefundNotSettled();
    /// @dev The refund would return more than the user agreed to pay.
    error RefundAboveCap(uint256 tokens, uint256 maxTokenCost);
    /// @dev The refund frame used more than `REFUND_GAS_ESTIMATE`, so the paymaster could end short.
    error RefundGasExceeded(uint256 used, uint256 estimate);

    /// @param config The deployment parameters.
    constructor(Config memory config) payable {
        if (config.maxDeviation <= 0) revert InvalidDeviation();
        PoolId poolId = PoolIdLibrary.toId(
            PoolKey({
                currency0: Currency.wrap(address(0)),
                currency1: Currency.wrap(address(config.payToken)),
                fee: config.fee,
                tickSpacing: config.tickSpacing,
                hooks: IHooks(address(0))
            })
        );
        (uint160 sqrtPriceX96, int24 tick,,) = config.poolManager.getSlot0(poolId);
        if (sqrtPriceX96 == 0) revert PoolNotInitialized();

        POOL_MANAGER = config.poolManager;
        PAY_TOKEN = config.payToken;
        POOL_ID = poolId;
        FEE = config.fee;
        TICK_SPACING = config.tickSpacing;
        MAX_DEVIATION = config.maxDeviation;
        BUFFER_BPS = config.bufferBps;
        MIN_SETTLE_GAS = config.minSettleGas;
        MIN_SETTLE_STATE_GAS = config.minSettleStateGas;
        MIN_SETTLE_PERMIT_STATE_GAS = config.minSettlePermitStateGas;
        MIN_APPROVE_GAS = config.minApproveGas;
        MIN_APPROVE_STATE_GAS = config.minApproveStateGas;
        APPROVE_NEEDS_ZERO = config.approveNeedsZero;
        MAX_TX_COST_WEI = config.maxTxCostWei;
        MIN_LIQUIDITY = config.minLiquidity;
        REFUND_GAS_ESTIMATE = config.refundGasEstimate;
        refTick = tick;
        lastSyncBlock = uint64(block.number);

        if (config.stakeAmount != 0) config.registry.addStake{value: config.stakeAmount}(config.unstakeDelaySec);
    }

    /// @notice Accepts ETH working capital from anyone, and ETH from the PoolManager.
    receive() external payable {}

    /// @notice The VERIFY frame targeting this paymaster calls this. Approves payment when every check passes.
    /// @dev The cap and any permit are read from the settle frame, whose data the user signed, so validation and
    /// settlement cannot disagree. Everything that could make settlement fail is checked here. If the next frame targets
    /// the token, it must be a bootstrap approve, followed by the settle frame.
    function validate() external {
        uint256 next = txparam(TxParam.CURRENT_FRAME_INDEX) + 1;
        bool bootstrap = _frameTarget(next) == address(PAY_TOKEN);
        uint256 settleFrame = bootstrap ? next + 1 : next;

        uint256 v = uint256(framedataload(36, settleFrame));
        _requireSettleFrame(settleFrame, v);

        uint256 maxCost = txparam(TxParam.MAX_COST);
        if (maxCost > MAX_TX_COST_WEI) revert MaxCostTooHigh(maxCost, MAX_TX_COST_WEI);

        uint256 maxTokenCost = uint256(framedataload(4, settleFrame));
        (uint160 sqrtPriceX96, int24 tick,,) = POOL_MANAGER.getSlot0(POOL_ID);
        int24 ref = refTick;
        if (_distance(tick, ref) > uint24(MAX_DEVIATION)) revert TickDeviated(tick, ref);
        uint128 liquidity = POOL_MANAGER.getLiquidity(POOL_ID);
        if (liquidity < MIN_LIQUIDITY) revert PoolTooThin(liquidity, MIN_LIQUIDITY);

        uint256 tokenCost = _quote(maxCost, sqrtPriceX96);
        if (tokenCost > maxTokenCost) revert CostAboveCap(tokenCost, maxTokenCost);

        address sender = address(uint160(txparam(TxParam.SENDER)));
        uint256 balance = PAY_TOKEN.balanceOf(sender);
        if (balance < maxTokenCost) revert InsufficientBalance(balance, maxTokenCost);

        if (bootstrap) {
            if (v != 0) revert PermitWithBootstrap();
            _requireApproveFrame(next, sender, maxTokenCost);
        } else if (v == 0) {
            uint256 allowance = PAY_TOKEN.allowance(sender, address(this));
            if (allowance < maxTokenCost) revert InsufficientAllowance(allowance, maxTokenCost);
        } else {
            _requireValidPermit(sender, maxTokenCost, v, framedataload(68, settleFrame), framedataload(100, settleFrame));
        }

        approve(Scope.PAYMENT);
    }

    /// @notice Validation binds this frame: it applies any permit, then pays for the maximum gas cost.
    /// @param maxTokenCost The most the user agrees to pay, in token base units.
    /// @param v Permit signature `v`, or 0 to rely on an existing allowance.
    /// @param r Permit signature `r`.
    /// @param s Permit signature `s`.
    function settle(uint256 maxTokenCost, uint8 v, bytes32 r, bytes32 s) external {
        address user = _txSender();
        if (msg.sender != user) revert NotTxSender();
        // A failed permit is fine when someone already submitted it: the transfer below is what must succeed.
        if (v != 0) {
            try IERC20Permit(address(PAY_TOKEN)).permit(user, address(this), maxTokenCost, PERMIT_DEADLINE, v, r, s) {}
                catch {}
        }
        POOL_MANAGER.unlock(abi.encode(Action.Settle, user, txparam(TxParam.MAX_COST), maxTokenCost));
        _advanceReference();
    }

    /// @notice The last frame calls this: sells the estimated unused ETH back to the user for tokens.
    /// @dev Best effort. This holds no state between frames, because transient storage does not survive them on this
    /// chain. It re-derives the transaction from frame data and statuses instead.
    /// @param settleFrame The index of the settle frame.
    function refund(uint256 settleFrame) external {
        uint256 start = gasleft();
        address user = _txSender();
        if (msg.sender != user) revert NotTxSender();

        // Being the last frame, targeted directly, is what makes this run at most once per transaction.
        uint256 current = txparam(TxParam.CURRENT_FRAME_INDEX);
        if (current + 1 != txparam(TxParam.FRAME_COUNT)) revert RefundNotLastFrame();
        if (_frameTarget(current) != address(this)) revert RefundNotLastFrame();
        if (settleFrame == 0 || settleFrame >= current) revert RefundNotSettled();
        if (
            _frameTarget(settleFrame) != address(this) || frameparam(settleFrame, FrameParam.STATUS) != SUCCESS
                || bytes4(framedataload(0, settleFrame)) != this.settle.selector
        ) revert RefundNotSettled();
        // Validation sits directly before settlement, or before the bootstrap approve frame.
        uint256 validateFrame = settleFrame - 1;
        if (_frameTarget(validateFrame) != address(this)) {
            if (validateFrame == 0 || _frameTarget(validateFrame) != address(PAY_TOKEN)) revert RefundNotSettled();
            validateFrame -= 1;
        }
        if (
            _frameTarget(validateFrame) != address(this)
                || frameparam(validateFrame, FrameParam.MODE) != uint256(FrameMode.VERIFY)
                || frameparam(validateFrame, FrameParam.STATUS) != SUCCESS
        ) revert RefundNotSettled();

        uint256 surplus = _surplus(current);
        if (surplus != 0) {
            uint256 maxTokenCost = uint256(framedataload(4, settleFrame));
            POOL_MANAGER.unlock(abi.encode(Action.Refund, user, surplus, maxTokenCost));
        }

        uint256 used = start - gasleft() + REFUND_FRAME_OVERHEAD;
        uint256 estimate = REFUND_GAS_ESTIMATE + current * REFUND_GAS_PER_FRAME;
        if (used > estimate) revert RefundGasExceeded(used, estimate);
    }

    /// @inheritdoc IUnlockCallback
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(POOL_MANAGER)) revert NotPoolManager();
        (Action action, address user, uint256 amount, uint256 maxTokenCost) =
            abi.decode(data, (Action, address, uint256, uint256));
        if (action == Action.Settle) _swapTokensForEth(user, amount, maxTokenCost);
        else _swapEthForTokens(user, amount, maxTokenCost);
        return "";
    }

    /// @notice Moves `refTick` toward the pool's tick by at most `MAX_DEVIATION`, once per block. Anyone may call it.
    /// @dev Without this, a market move beyond `MAX_DEVIATION` would fail every validation, and no later transaction
    /// could ever update the reference. It shares its per-block limit with settlement and never passes the pool's
    /// tick, so no caller can walk the reference faster than `MAX_DEVIATION` per block or beyond the market.
    function syncReference() external {
        if (block.number <= lastSyncBlock) revert AlreadySynced();
        _advanceReference();
    }

    /// @notice Prices an amount of wei in the token at the pool's current price, including the buffer.
    /// @param weiCost The amount of ETH to price, in wei.
    /// @return The token cost in base units, rounded up.
    function quote(uint256 weiCost) external view returns (uint256) {
        (uint160 sqrtPriceX96,,,) = POOL_MANAGER.getSlot0(POOL_ID);
        return _quote(weiCost, sqrtPriceX96);
    }

    function _requireSettleFrame(uint256 frame, uint256 v) private view {
        if (
            _frameTarget(frame) != address(this) || frameparam(frame, FrameParam.MODE) != uint256(FrameMode.SENDER)
                || bytes4(framedataload(0, frame)) != this.settle.selector
        ) revert SettleNotBound();
        // In an atomic batch with the user's call, a reverting call would undo settlement after the paymaster paid.
        if (frameparam(frame, FrameParam.ATOMIC_BATCH) != 0) revert SettleInAtomicBatch();
        // A frame sending ETH the user lacks reverts, and short calldata reverts in the decoder. Later frames still run.
        if (frameparam(frame, FrameParam.VALUE) != 0 || frameparam(frame, FrameParam.DATA_LENGTH) != SETTLE_DATA_LENGTH) {
            revert SettleMalformed();
        }
        uint256 gasLimit = frameparam(frame, FrameParam.EXECUTION_GAS_LIMIT);
        uint256 stateGasLimit = frameparam(frame, FrameParam.STATE_GAS_LIMIT);
        if (gasLimit < MIN_SETTLE_GAS || stateGasLimit < (v == 0 ? MIN_SETTLE_STATE_GAS : MIN_SETTLE_PERMIT_STATE_GAS)) {
            revert SettleGasTooLow(gasLimit, stateGasLimit);
        }
    }

    /// @dev The frame can only grant the allowance settlement is about to use, and it cannot fail for a reason the user
    /// controls. Its target was already checked to be the token.
    function _requireApproveFrame(uint256 frame, address sender, uint256 maxTokenCost) private view {
        if (
            frameparam(frame, FrameParam.MODE) != uint256(FrameMode.SENDER)
                || frameparam(frame, FrameParam.ATOMIC_BATCH) != 0 || frameparam(frame, FrameParam.VALUE) != 0
                || frameparam(frame, FrameParam.DATA_LENGTH) != APPROVE_DATA_LENGTH
                || bytes4(framedataload(0, frame)) != IERC20.approve.selector
                || uint256(framedataload(4, frame)) != uint256(uint160(address(this)))
                || uint256(framedataload(36, frame)) < maxTokenCost
        ) revert ApproveNotBound();
        uint256 gasLimit = frameparam(frame, FrameParam.EXECUTION_GAS_LIMIT);
        uint256 stateGasLimit = frameparam(frame, FrameParam.STATE_GAS_LIMIT);
        if (gasLimit < MIN_APPROVE_GAS || stateGasLimit < MIN_APPROVE_STATE_GAS) {
            revert ApproveGasTooLow(gasLimit, stateGasLimit);
        }
        if (APPROVE_NEEDS_ZERO && PAY_TOKEN.allowance(sender, address(this)) != 0) revert ApproveNotBound();
    }

    /// @dev Reproduces the token's own checks, so a permit that passes here cannot fail in `settle` by itself.
    function _requireValidPermit(address owner, uint256 value, uint256 v, bytes32 r, bytes32 s) private view {
        if ((v != 27 && v != 28) || uint256(s) > MAX_S) revert InvalidPermit();
        IERC20Permit token = IERC20Permit(address(PAY_TOKEN));
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                token.DOMAIN_SEPARATOR(),
                keccak256(abi.encode(PERMIT_TYPEHASH, owner, address(this), value, token.nonces(owner), PERMIT_DEADLINE))
            )
        );
        address signer = ecrecover(digest, uint8(v), r, s);
        if (signer == address(0) || signer != owner) revert InvalidPermit();
    }

    /// @dev Exact-output: buys exactly the ETH `APPROVE` collected, charging the user no more than the signed cap.
    function _swapTokensForEth(address user, uint256 ethWanted, uint256 maxTokenCost) private {
        BalanceDelta delta = POOL_MANAGER.swap(
            _poolKey(),
            SwapParams({
                zeroForOne: false,
                amountSpecified: int256(ethWanted),
                sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        if (uint256(int256(delta.amount0())) != ethWanted) revert InsufficientPoolLiquidity();
        uint256 tokensOwed = uint256(-int256(delta.amount1()));
        if (tokensOwed > maxTokenCost) revert CostAboveCap(tokensOwed, maxTokenCost);

        Currency token = Currency.wrap(address(PAY_TOKEN));
        POOL_MANAGER.sync(token);
        PAY_TOKEN.safeTransferFrom(user, address(POOL_MANAGER), tokensOwed);
        POOL_MANAGER.settle();
        POOL_MANAGER.take(Currency.wrap(address(0)), address(this), ethWanted);
        emit Settled(user, tokensOwed, ethWanted);
    }

    /// @dev Exact-input: sells only the surplus, so the paymaster's ETH is unaffected by the price it gets.
    function _swapEthForTokens(address user, uint256 ethToSell, uint256 maxTokenCost) private {
        BalanceDelta delta = POOL_MANAGER.swap(
            _poolKey(),
            SwapParams({
                zeroForOne: true,
                amountSpecified: -int256(ethToSell),
                sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            ""
        );
        uint256 tokensOut = uint256(int256(delta.amount1()));
        if (tokensOut > maxTokenCost) revert RefundAboveCap(tokensOut, maxTokenCost);
        uint256 ethIn = uint256(-int256(delta.amount0()));
        POOL_MANAGER.settle{value: ethIn}();
        POOL_MANAGER.take(Currency.wrap(address(PAY_TOKEN)), user, tokensOut);
        emit Refunded(user, tokensOut, ethIn);
    }

    /// @dev An upper bound on the fee, from the frames' own accounting, turned into the ETH the chain will return.
    /// Only gas that frames demonstrably did not use is credited, so the result can only err in the paymaster's favour.
    function _surplus(uint256 current) private view returns (uint256) {
        uint256 maxCost = txparam(TxParam.MAX_COST);
        uint256 maxFee = txparam(TxParam.MAX_FEE);
        uint256 unused;
        for (uint256 i = 0; i < current; i++) {
            unused += frameparam(i, FrameParam.EXECUTION_GAS_LIMIT) - frameparam(i, FrameParam.EXECUTION_GAS_USED);
            uint256 stateLimit = frameparam(i, FrameParam.STATE_GAS_LIMIT);
            if (stateLimit != 0) unused += stateLimit - frameparam(i, FrameParam.STATE_GAS_USED);
        }
        uint256 estimate = REFUND_GAS_ESTIMATE + current * REFUND_GAS_PER_FRAME;
        uint256 ownLimit = frameparam(current, FrameParam.EXECUTION_GAS_LIMIT);
        if (ownLimit > estimate) unused += ownLimit - estimate;

        uint256 price = tx.gasprice < maxFee ? tx.gasprice : maxFee;
        uint256 maxGas = maxCost / maxFee;
        uint256 feeBound = (maxGas > unused ? maxGas - unused : 0) * price;
        return maxCost > feeBound ? maxCost - feeBound : 0;
    }

    /// @dev Moves `refTick` toward the pool's tick. Does nothing when it already moved in this block.
    function _advanceReference() private {
        if (block.number <= lastSyncBlock) return;
        (, int24 tick,,) = POOL_MANAGER.getSlot0(POOL_ID);
        int24 ref = refTick;
        int24 next = tick;
        if (tick > ref + MAX_DEVIATION) next = ref + MAX_DEVIATION;
        else if (tick < ref - MAX_DEVIATION) next = ref - MAX_DEVIATION;
        refTick = next;
        lastSyncBlock = uint64(block.number);
        emit ReferenceSynced(next, tick);
    }

    function _poolKey() private view returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(PAY_TOKEN)),
            fee: FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(0))
        });
    }

    function _txSender() private view returns (address) {
        return address(uint160(txparam(TxParam.SENDER)));
    }

    function _frameTarget(uint256 frame) private view returns (address) {
        return address(uint160(frameparam(frame, FrameParam.RESOLVED_TARGET)));
    }

    /// @dev Native ETH is currency0, so the raw price of one wei in token base units is (sqrtPriceX96 / 2^96)^2.
    function _quote(uint256 weiCost, uint160 sqrtPriceX96) private view returns (uint256) {
        uint256 tokenCost =
            FullMath.mulDivRoundingUp(FullMath.mulDivRoundingUp(weiCost, sqrtPriceX96, Q96), sqrtPriceX96, Q96);
        return FullMath.mulDivRoundingUp(tokenCost, BPS + BUFFER_BPS, BPS);
    }

    function _distance(int24 a, int24 b) private pure returns (uint24) {
        return a > b ? uint24(a - b) : uint24(b - a);
    }
}
