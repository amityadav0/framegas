// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {FgUSD} from "../src/FgUSD.sol";
import {FrameGasPaymaster} from "../src/FrameGasPaymaster.sol";
import {PaymasterBase} from "./PaymasterBase.sol";

/// @notice Runs whole transactions the way the chain would: `APPROVE` collects the maximum cost, every frame runs whatever
/// the one before it did, and the unused part comes back after the last frame. Anything may happen to the pool between
/// admission and settlement, and inside the user's own frame.
contract FrameGasPaymasterFuzz is PaymasterBase {
    using StateLibrary for IPoolManager;

    /// @dev Intrinsic gas in the test transaction: its total less the frame limits.
    uint256 internal constant INTRINSIC = MAX_GAS - (30_000 + 60_000 + MIN_SETTLE_GAS + MIN_SETTLE_STATE + 50_000 + 250_000);
    uint256 internal constant VALIDATE_USED = 45_000;
    uint256 internal constant SENDER_USED = 100;
    /// @dev The frame's entry charge, which a measurement from inside the test cannot see.
    uint256 internal constant ENTRY = 3_000;

    /// @dev A move to apply right after admission, in ticks.
    int24 internal tickMoveAfterAdmission;

    struct Result {
        bool settled;
        bool refunded;
        uint256 start;
        uint256 finalBalance;
        uint256 tokensPaid;
        uint256 fee;
    }

    /// @dev `amount` is ETH-sized. A token swap uses the same value in tokens. A swap the pool refuses changes nothing.
    function _swapEither(uint256 amount, bool zeroForOne) internal {
        if (amount == 0) return;
        vm.deal(address(this), address(this).balance + amount);
        uint256 specified = zeroForOne ? amount : (amount * 2386) / 1e12;
        if (specified == 0) return;
        try swapper.swap{value: zeroForOne ? amount : 0}(
            key,
            SwapParams(zeroForOne, -int256(specified), zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1),
            PoolSwapTest.TestSettings(false, false),
            ""
        ) {} catch {}
    }

    /// @dev `beforeSettle` and `inUserFrame` are ETH-sized swaps, positive for ETH into the pool.
    function _runTx(uint256 cap, int256[3] memory beforeSettle, int256 inUserFrame, uint256 userBurn, uint256 drain, uint256 price)
        internal
        returns (Result memory r)
    {
        r.start = address(paymaster).balance;
        uint256 userTokensBefore = token.balanceOf(user);

        // Admission. A transaction that fails here costs the paymaster nothing.
        txp.set(0x0A, VERIFY_FRAME);
        _setSettleData(SETTLE_FRAME, _settleData(cap, 0, 0, 0));
        paymaster.validate();

        // Between admission and settlement.
        if (tickMoveAfterAdmission != 0) {
            (, int24 tick,,) = manager.getSlot0(key.toId());
            _moveTickTo(tick + tickMoveAfterAdmission);
        }
        for (uint256 i = 0; i < 3; i++) {
            int256 move = beforeSettle[i];
            if (move != 0) _swapEither(uint256(move > 0 ? move : -move), move > 0);
        }
        if (drain != 0) {
            vm.prank(user);
            token.transfer(address(0xD12A), drain);
        }
        userTokensBefore -= drain;

        vm.deal(address(paymaster), r.start - MAX_COST);

        // The settle frame, at exactly the gas it declared.
        txp.set(0x0A, SETTLE_FRAME);
        uint256 gasBefore = gasleft();
        vm.prank(user);
        try paymaster.settle{gas: MIN_SETTLE_GAS}(cap, 0, 0, 0) {
            r.settled = true;
        } catch {}
        uint256 settleUsed = (r.settled ? gasBefore - gasleft() : MIN_SETTLE_GAS) + ENTRY;
        if (settleUsed > MIN_SETTLE_GAS + MIN_SETTLE_STATE) settleUsed = MIN_SETTLE_GAS + MIN_SETTLE_STATE;

        // The user's frame runs regardless, and may move the pool too.
        if (inUserFrame != 0) _swapEither(uint256(inUserFrame > 0 ? inUserFrame : -inUserFrame), inUserFrame > 0);

        // What the chain reports for finished frames.
        uint256[4] memory used = [SENDER_USED, VALIDATE_USED, settleUsed, userBurn];
        for (uint256 i = 0; i < 4; i++) {
            fp.set(i, GAS_USED, used[i]);
            fp.set(i, STATE_USED, 0);
            fp.set(i, STATUS, 1);
        }
        fp.set(SETTLE_FRAME, STATUS, r.settled ? 1 : 0);

        // The refund frame.
        txp.set(0x0A, REFUND_FRAME);
        vm.txGasPrice(price);
        gasBefore = gasleft();
        vm.prank(user);
        try paymaster.refund{gas: 250_000}(SETTLE_FRAME) {
            r.refunded = true;
        } catch {}
        uint256 refundUsed = gasBefore - gasleft() + ENTRY;
        if (refundUsed > 250_000) refundUsed = 250_000;

        r.fee = (INTRINSIC + SENDER_USED + VALIDATE_USED + settleUsed + userBurn + refundUsed) * price;
        r.finalBalance = address(paymaster).balance + MAX_COST - r.fee;
        uint256 userTokensAfter = token.balanceOf(user);
        r.tokensPaid = userTokensBefore > userTokensAfter ? userTokensBefore - userTokensAfter : 0;
    }

    function _boundMove(uint96 raw, bool intoPool) internal pure returns (int256) {
        int256 amount = int256(uint256(raw % 0.05 ether));
        return intoPool ? amount : -amount;
    }

    /// @notice No path through the pool makes the user pay above the cap, and a settled transaction never costs the
    /// paymaster ETH. If settlement fails, the user pays nothing and the paymaster's loss is the fee, within the limit.
    function testFuzz_wholeTransaction(
        uint64 capRaw,
        uint96[3] memory moves,
        bool[3] memory directions,
        uint96 userMove,
        bool userDirection,
        uint32 burnRaw,
        uint64 drainRaw,
        uint64 priceRaw
    ) public {
        vm.prank(user);
        token.approve(address(paymaster), type(uint256).max);
        uint256 quoted = paymaster.quote(MAX_COST);
        uint256 cap = bound(uint256(capRaw), quoted, 50e6);
        uint256 burn = bound(uint256(burnRaw), 0, 50_000);
        uint256 drain = bound(uint256(drainRaw), 0, 100e6);
        uint256 price = bound(uint256(priceRaw), 7, MAX_FEE);

        int256[3] memory beforeSettle =
            [_boundMove(moves[0], directions[0]), _boundMove(moves[1], directions[1]), _boundMove(moves[2], directions[2])];
        Result memory r = _runTx(cap, beforeSettle, _boundMove(userMove, userDirection), burn, drain, price);

        assertLe(r.tokensPaid, cap, "the user never pays above the signed cap");
        if (r.settled) {
            assertGe(r.finalBalance, r.start, "a settled transaction never costs the paymaster ETH");
        } else {
            assertEq(r.tokensPaid, 0, "the user pays nothing when settlement fails");
            assertFalse(r.refunded, "no refund without settlement");
            assertEq(r.start - r.finalBalance, r.fee, "the loss is exactly the fee");
            assertLe(r.fee, MAX_COST, "the loss never exceeds the reserve");
            assertLe(MAX_COST, MAX_TX_COST, "the reserve never exceeds the limit");
        }
    }

    /// @dev The tightest cap a user can sign, then the price moved against them before settlement.
    function test_worstCase_bufferBreachFreeGas() public {
        vm.prank(user);
        token.approve(address(paymaster), type(uint256).max);
        uint256 cap = paymaster.quote(MAX_COST);

        uint256 snapshot = vm.snapshotState();
        uint256 firstFailing;
        for (uint256 ticks = 60; ticks <= 900; ticks += 60) {
            vm.revertToState(snapshot);
            snapshot = vm.snapshotState();
            tickMoveAfterAdmission = int24(int256(ticks));
            Result memory r = _runTx(cap, [int256(0), 0, 0], 0, 3_000, 0, MAX_FEE);
            if (!r.settled) {
                firstFailing = ticks;
                console2.log("settlement first fails after the price moves, in ticks:", ticks);
                console2.log("  user pays:", r.tokensPaid);
                console2.log("  paymaster loses, wei:", r.start - r.finalBalance);
                break;
            }
        }
        assertGt(firstFailing, 0, "a move past the buffer must fail settlement");
        assertGt(firstFailing, 300, "ordinary moves stay inside the 5% buffer");
    }

    /// @dev What it costs someone to cause that: a swap that moves the pool past the buffer, then back.
    function test_worstCase_costOfBreachingTheBuffer() public {
        (, int24 start,,) = manager.getSlot0(key.toId());
        int256 tokensBefore = int256(token.balanceOf(address(this)));
        int256 ethBefore = int256(address(this).balance);
        _moveTickTo(start + 480);
        int256 tokensIn = tokensBefore - int256(token.balanceOf(address(this)));
        _moveTickTo(start);
        int256 tokensNet = int256(token.balanceOf(address(this))) - tokensBefore;
        int256 ethNet = int256(address(this).balance) - ethBefore;
        // Value both legs at the pool's price: about 2,386 fgUSD per ETH, with fgUSD at 6 decimals.
        int256 cost = -(tokensNet + (ethNet * 2386) / 1e12);
        console2.log("capital to move 480 ticks, in fgUSD base units:", uint256(tokensIn));
        console2.log("cost of moving there and back, in fgUSD base units:", uint256(cost));
        assertGt(cost, 0);
    }

    /// @dev Drains the user after admission with the worst possible user frame, which burns its whole limit.
    function test_worstCase_drainedBalance() public {
        vm.prank(user);
        token.approve(address(paymaster), type(uint256).max);
        uint256 cap = paymaster.quote(MAX_COST);
        Result memory r = _runTx(cap, [int256(0), 0, 0], 0, 50_000, 100e6, MAX_FEE);
        assertFalse(r.settled);
        assertEq(r.tokensPaid, 0);
        uint256 loss = r.start - r.finalBalance;
        console2.log("drained after admission, paymaster loses, wei:", loss);
        console2.log("  which is this share of the reserve, bps:", (loss * 10_000) / MAX_COST);
        assertLe(loss, MAX_COST);
    }

    // ---- ticks crossed ---------------------------------------------------------------------------------------------

    /// @dev A thin pool where buying `MAX_COST` of ETH crosses exactly `crossings` tick boundaries.
    function _thinPool(uint256 crossings) internal returns (FrameGasPaymaster thin, FgUSD thinToken) {
        thinToken = new FgUSD(1_000_000e6);
        PoolKey memory thinKey =
            PoolKey(Currency.wrap(address(0)), Currency.wrap(address(thinToken)), FEE, SPACING, IHooks(address(0)));
        int24 base = -198540; // aligned with the tick spacing
        manager.initialize(thinKey, TickMath.getSqrtPriceAtTick(base));
        PoolModifyLiquidityTest lp = new PoolModifyLiquidityTest(manager);
        thinToken.approve(address(lp), type(uint256).max);
        thinToken.approve(address(swapper), type(uint256).max);

        // Single-sided ETH above the price, in one position per spacing. Each holds a share of the ETH wanted.
        uint256 segments = crossings + 1;
        uint256 ethPerSegment = (MAX_COST * 11) / (10 * segments - 5);
        for (uint256 i = 0; i < segments + 1; i++) {
            int24 lower = base + int24(int256(i)) * SPACING;
            int24 upper = lower + SPACING;
            uint256 sqrtA = TickMath.getSqrtPriceAtTick(lower);
            uint256 sqrtB = TickMath.getSqrtPriceAtTick(upper);
            uint256 liquidity = (((ethPerSegment * sqrtA) / (1 << 96)) * sqrtB) / (sqrtB - sqrtA);
            lp.modifyLiquidity{value: 0.1 ether}(thinKey, ModifyLiquidityParams(lower, upper, int256(liquidity), 0), "");
        }
        thin = new FrameGasPaymaster{value: FLOAT}(
            FrameGasPaymaster.Config({
                poolManager: manager,
                registry: registry,
                payToken: IERC20(address(thinToken)),
                fee: FEE,
                tickSpacing: SPACING,
                maxDeviation: MAX_DEVIATION,
                bufferBps: BUFFER_BPS,
                stakeAmount: 0,
                unstakeDelaySec: 0,
                minSettleGas: 0,
                minSettleStateGas: 0,
                minSettlePermitStateGas: 0,
                minApproveGas: 0,
                minApproveStateGas: 0,
                approveNeedsZero: false,
                maxTxCostWei: MAX_TX_COST,
                refundGasEstimate: 2_000_000
            })
        );
    }

    /// @dev Reports settle and refund gas by ticks crossed, and checks against what a settle frame must declare.
    function test_measure_gasByTicksCrossed() public {
        // The deep pool first: the same swap with no tick crossed.
        txp.set(0x0A, SETTLE_FRAME);
        vm.prank(user);
        token.approve(address(paymaster), type(uint256).max);
        vm.deal(address(paymaster), address(paymaster).balance - MAX_COST);
        uint256 g = gasleft();
        vm.prank(user);
        paymaster.settle(CAP, 0, 0, 0);
        uint256 noCrossing = g - gasleft();
        console2.log("settle gas with no tick crossed:", noCrossing);

        uint256[5] memory cases = [uint256(1), 2, 5, 10, 20];
        console2.log("ticks wanted | settle gas | ticks moved | refund gas");
        uint256 lastSettle = noCrossing;
        for (uint256 c = 0; c < cases.length; c++) {
            (FrameGasPaymaster thin, FgUSD thinToken) = _thinPool(cases[c]);
            (uint256 settleGas, uint256 moved, uint256 refundGas) = _measureOn(thin, thinToken);
            console2.log(cases[c], settleGas, moved, refundGas);
            assertGt(settleGas, lastSettle, "more ticks crossed costs more");
            lastSettle = settleGas;
        }
    }

    function _measureOn(FrameGasPaymaster thin, FgUSD thinToken)
        internal
        returns (uint256 settleGas, uint256 moved, uint256 refundGas)
    {
        _mocksFor(thin);
        thinToken.transfer(user, 100e6);
        vm.prank(user);
        thinToken.approve(address(thin), type(uint256).max);
        uint256 startBalance = address(thin).balance;
        vm.deal(address(thin), startBalance - MAX_COST);

        (, int24 before,,) = manager.getSlot0(thin.POOL_ID());
        txp.set(0x0A, SETTLE_FRAME);
        uint256 g = gasleft();
        vm.prank(user);
        thin.settle(50e6, 0, 0, 0);
        settleGas = g - gasleft();
        (, int24 afterTick,,) = manager.getSlot0(thin.POOL_ID());
        moved = uint256(int256(afterTick - before));

        // Refund as much as possible, which sells the most ETH and crosses the most ticks back.
        uint256[4] memory used = [uint256(100), 45_000, settleGas, 3_000];
        for (uint256 i = 0; i < 4; i++) {
            fp.set(i, GAS_USED, used[i]);
            fp.set(i, STATE_USED, 0);
            fp.set(i, STATUS, 1);
        }
        txp.set(0x0A, REFUND_FRAME);
        vm.txGasPrice(1 wei);
        g = gasleft();
        vm.prank(user);
        thin.refund(SETTLE_FRAME);
        refundGas = g - gasleft();
    }

    function _mocksFor(FrameGasPaymaster thin) internal {
        (txp, fp, data) = etchFrameMocks(address(thin));
        paymaster = thin;
        txp.set(0x02, uint256(uint160(user)));
        txp.set(0x04, MAX_FEE);
        txp.set(0x06, MAX_COST);
        txp.set(0x09, 5);
        _frame(0, user, 1, 30_000, 0);
        _frame(VERIFY_FRAME, address(thin), 1, 60_000, 0);
        _frame(SETTLE_FRAME, address(thin), 2, 5_000_000, 0);
        _frame(USER_FRAME, address(0xCAFE), 2, 50_000, 0);
        _frame(REFUND_FRAME, address(thin), 2, 250_000, 0);
        _setSettleData(SETTLE_FRAME, _settleData(50e6, 0, 0, 0));
    }
}
