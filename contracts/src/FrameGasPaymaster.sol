// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HegotaSupport} from "@forshtat/hegota-support/contracts/HegotaSupport.sol";
import {Devnet} from "@forshtat/hegota-support/contracts/Devnet.sol";
import {Scope, TxParam} from "@forshtat/hegota-support/contracts/Params.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {IStakingRegistry} from "./IStakingRegistry.sol";

/// @title FrameGasPaymaster
/// @notice Pays a frame transaction's gas in exchange for one ERC-20, priced on a native-ETH Uniswap v4 pool.
/// @dev One instance serves one token and pool, fixed at deployment. There is no owner.
///
/// Status: validation frame only. Settlement (permit, pull, swap, refill) is not implemented yet, so this version
/// spends its ETH without being repaid. Do not fund it beyond what a test needs.
///
/// `validate` runs in a VERIFY frame under the mempool's rules, so it reads no environment opcode (NUMBER, BLOCKHASH,
/// BASEFEE, GASPRICE, TIMESTAMP are banned). Gas cost comes from the signed transaction through TXPARAM, and
/// manipulation resistance comes from a reference tick in this contract's own storage. Reading the PoolManager's
/// storage requires this contract to be a staked entity.
contract FrameGasPaymaster is HegotaSupport(Devnet.ERC8421_WORKSHOP) {
    using StateLibrary for IPoolManager;

    uint256 private constant BPS = 10_000;
    uint256 private constant Q96 = 2 ** 96;

    /// @notice The Uniswap v4 singleton holding the pool.
    IPoolManager public immutable POOL_MANAGER;
    /// @notice The token users pay gas in.
    IERC20 public immutable PAY_TOKEN;
    /// @notice The native-ETH/PAY_TOKEN pool used for pricing.
    PoolId public immutable POOL_ID;
    /// @notice The largest accepted distance, in ticks, between the pool's tick and `refTick`.
    int24 public immutable MAX_DEVIATION;
    /// @notice Added to the quote to absorb price movement before settlement, in basis points.
    uint256 public immutable BUFFER_BPS;

    /// @notice The tick validation measures manipulation against.
    int24 public refTick;
    /// @notice The block `refTick` last moved in.
    uint64 public lastSyncBlock;

    /// @notice Emitted when `refTick` moves.
    event ReferenceSynced(int24 refTick, int24 poolTick);

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
    /// @dev `syncReference` already ran in this block.
    error AlreadySynced();

    /// @param poolManager The Uniswap v4 PoolManager.
    /// @param registry The ERC-8421 staking registry.
    /// @param payToken The token users pay in. It is currency1 of the pool, native ETH being currency0.
    /// @param fee The pool's fee.
    /// @param tickSpacing The pool's tick spacing.
    /// @param maxDeviation The largest accepted tick distance from `refTick`.
    /// @param bufferBps The quote buffer in basis points.
    /// @param stakeAmount The part of `msg.value` staked. Nothing can withdraw it later, as there is no owner.
    /// @param unstakeDelaySec The unstake delay recorded with the stake.
    constructor(
        IPoolManager poolManager,
        IStakingRegistry registry,
        IERC20 payToken,
        uint24 fee,
        int24 tickSpacing,
        int24 maxDeviation,
        uint256 bufferBps,
        uint256 stakeAmount,
        uint32 unstakeDelaySec
    ) payable {
        if (maxDeviation <= 0) revert InvalidDeviation();
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(payToken)),
            fee: fee,
            tickSpacing: tickSpacing,
            hooks: IHooks(address(0))
        });
        PoolId poolId = PoolIdLibrary.toId(key);
        (uint160 sqrtPriceX96, int24 tick,,) = poolManager.getSlot0(poolId);
        if (sqrtPriceX96 == 0) revert PoolNotInitialized();

        POOL_MANAGER = poolManager;
        PAY_TOKEN = payToken;
        POOL_ID = poolId;
        MAX_DEVIATION = maxDeviation;
        BUFFER_BPS = bufferBps;
        refTick = tick;
        lastSyncBlock = uint64(block.number);

        if (stakeAmount != 0) registry.addStake{value: stakeAmount}(unstakeDelaySec);
    }

    /// @notice Accepts ETH working capital from anyone.
    receive() external payable {}

    /// @notice The VERIFY frame targeting this paymaster calls this. Approves payment when every check passes.
    /// @dev Frame data is covered by the transaction's signature hash, so the user signed `maxTokenCost`.
    /// @param maxTokenCost The most the user agrees to pay, in token base units.
    function validate(uint256 maxTokenCost) external {
        (uint160 sqrtPriceX96, int24 tick,,) = POOL_MANAGER.getSlot0(POOL_ID);
        int24 ref = refTick;
        if (_distance(tick, ref) > uint24(MAX_DEVIATION)) revert TickDeviated(tick, ref);

        uint256 tokenCost = _quote(txparam(TxParam.MAX_COST), sqrtPriceX96);
        if (tokenCost > maxTokenCost) revert CostAboveCap(tokenCost, maxTokenCost);

        address sender = address(uint160(txparam(TxParam.SENDER)));
        uint256 balance = PAY_TOKEN.balanceOf(sender);
        if (balance < maxTokenCost) revert InsufficientBalance(balance, maxTokenCost);
        uint256 allowance = PAY_TOKEN.allowance(sender, address(this));
        if (allowance < maxTokenCost) revert InsufficientAllowance(allowance, maxTokenCost);

        approve(Scope.PAYMENT);
    }

    /// @notice Moves `refTick` toward the pool's tick by at most `MAX_DEVIATION`, once per block. Anyone may call it.
    /// @dev Without this, a market move beyond `MAX_DEVIATION` would fail every validation, and no later transaction
    /// could ever update the reference. The per-block limit makes dragging the reference cost sustained capital.
    function syncReference() external {
        if (block.number <= lastSyncBlock) revert AlreadySynced();
        (, int24 tick,,) = POOL_MANAGER.getSlot0(POOL_ID);
        int24 ref = refTick;
        int24 next = tick;
        if (tick > ref + MAX_DEVIATION) next = ref + MAX_DEVIATION;
        else if (tick < ref - MAX_DEVIATION) next = ref - MAX_DEVIATION;
        refTick = next;
        lastSyncBlock = uint64(block.number);
        emit ReferenceSynced(next, tick);
    }

    /// @notice Prices an amount of wei in the token at the pool's current price, including the buffer.
    /// @param weiCost The amount of ETH to price, in wei.
    /// @return The token cost in base units, rounded up.
    function quote(uint256 weiCost) external view returns (uint256) {
        (uint160 sqrtPriceX96,,,) = POOL_MANAGER.getSlot0(POOL_ID);
        return _quote(weiCost, sqrtPriceX96);
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
