// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {FgUSD} from "../src/FgUSD.sol";
import {FrameGasPaymaster} from "../src/FrameGasPaymaster.sol";
import {MockFrameDataLoad, MockFrameParam, MockTxParam} from "./FrameMocks.sol";
import {PaymasterBase} from "./PaymasterBase.sol";

contract FrameGasPaymasterTest is PaymasterBase {
    using StateLibrary for IPoolManager;

    // ---- deployment ------------------------------------------------------------------------------------------

    function test_constructorStakesAsTheContract() public view {
        (uint256 stake, uint32 delay, uint64 withdrawTime) = registry.getDepositInfo(address(paymaster));
        assertEq(stake, STAKE);
        assertEq(delay, 86400);
        assertEq(withdrawTime, 0);
        assertEq(address(paymaster).balance, FLOAT);
    }

    function test_constructorRejectsUninitializedPool() public {
        FgUSD other = new FgUSD(1);
        FrameGasPaymaster.Config memory config = FrameGasPaymaster.Config({
            poolManager: manager,
            registry: registry,
            payToken: IERC20(address(other)),
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
            maxTxCostWei: 0,
            refundGasEstimate: 0
        });
        vm.expectRevert(FrameGasPaymaster.PoolNotInitialized.selector);
        new FrameGasPaymaster(config);
    }

    // ---- validation: the settlement is bound -----------------------------------------------------------------

    function test_validateApprovesABoundSettlement() public {
        _expectApprove();
        paymaster.validate();
    }

    function test_validateRevertsWithNoFrameAfterIt() public {
        txp.set(0x0A, REFUND_FRAME); // the frame after this one does not exist, so FRAMEPARAM halts
        vm.expectRevert();
        paymaster.validate();
    }

    function test_validateRevertsWhenNextFrameTargetsAnotherContract() public {
        _frame(SETTLE_FRAME, address(0xBAD), 2, MIN_SETTLE_GAS, MIN_SETTLE_STATE);
        vm.expectRevert(FrameGasPaymaster.SettleNotBound.selector);
        paymaster.validate();
    }

    function test_validateRevertsWhenNextFrameIsNotSenderMode() public {
        _frame(SETTLE_FRAME, address(paymaster), 0, MIN_SETTLE_GAS, MIN_SETTLE_STATE);
        vm.expectRevert(FrameGasPaymaster.SettleNotBound.selector);
        paymaster.validate();
    }

    function test_validateRevertsWhenNextFrameCallsAnotherFunction() public {
        _setSettleData(SETTLE_FRAME, abi.encodeCall(FrameGasPaymaster.syncReference, ()));
        vm.expectRevert(FrameGasPaymaster.SettleNotBound.selector);
        paymaster.validate();
    }

    /// @dev Otherwise a reverting user call would undo the payment after the paymaster paid.
    function test_validateRevertsWhenSettleIsInAnAtomicBatch() public {
        fp.set(SETTLE_FRAME, ATOMIC, 1);
        vm.expectRevert(FrameGasPaymaster.SettleInAtomicBatch.selector);
        paymaster.validate();
    }

    /// @dev Otherwise a user could starve settlement of gas, and the next frame would still run for free.
    function test_validateRevertsWhenSettleGasIsTooLow() public {
        fp.set(SETTLE_FRAME, GAS_LIMIT, MIN_SETTLE_GAS - 1);
        vm.expectRevert(
            abi.encodeWithSelector(FrameGasPaymaster.SettleGasTooLow.selector, MIN_SETTLE_GAS - 1, MIN_SETTLE_STATE)
        );
        paymaster.validate();
    }

    function test_validateRevertsWhenSettleStateGasIsTooLow() public {
        fp.set(SETTLE_FRAME, STATE_LIMIT, MIN_SETTLE_STATE - 1);
        vm.expectRevert(
            abi.encodeWithSelector(FrameGasPaymaster.SettleGasTooLow.selector, MIN_SETTLE_GAS, MIN_SETTLE_STATE - 1)
        );
        paymaster.validate();
    }

    /// @dev A frame sending ETH the user lacks reverts, and later frames still run.
    function test_validateRevertsWhenSettleSendsValue() public {
        fp.set(SETTLE_FRAME, VALUE, 1);
        vm.expectRevert(FrameGasPaymaster.SettleMalformed.selector);
        paymaster.validate();
    }

    /// @dev Missing words read as zero in validation, but Solidity's decoder reverts in `settle`.
    function test_validateRevertsWhenSettleDataIsShort() public {
        _setSettleData(SETTLE_FRAME, abi.encodePacked(FrameGasPaymaster.settle.selector, CAP));
        vm.expectRevert(FrameGasPaymaster.SettleMalformed.selector);
        paymaster.validate();
    }

    /// @dev Bounds what one transaction can cost, whatever gas limits a user declares.
    function test_validateRevertsAboveTheMaximumTransactionCost() public {
        txp.set(0x06, MAX_TX_COST + 1);
        vm.expectRevert(
            abi.encodeWithSelector(FrameGasPaymaster.MaxCostTooHigh.selector, MAX_TX_COST + 1, MAX_TX_COST)
        );
        paymaster.validate();
    }

    // ---- validation: bootstrap mode ------------------------------------------------------------------------------

    /// @dev `[VERIFY sender, VERIFY paymaster, SENDER approve, SENDER settle, SENDER user, SENDER refund]`.
    function _bootstrapTx(bytes memory approveData) internal {
        vm.prank(user);
        token.approve(address(paymaster), 0);
        txp.set(0x09, 6);
        _frame(2, address(token), 2, MIN_APPROVE_GAS, MIN_APPROVE_STATE);
        _setSettleData(2, approveData);
        _frame(3, address(paymaster), 2, MIN_SETTLE_GAS, MIN_SETTLE_STATE);
        _setSettleData(3, _settleData(CAP, 0, 0, 0));
        _frame(4, address(0xCAFE), 2, 50_000, 0);
        _frame(5, address(paymaster), 2, 250_000, 0);
    }

    function _approveData() internal view returns (bytes memory) {
        return abi.encodeCall(IERC20.approve, (address(paymaster), CAP));
    }

    function test_bootstrapApproves() public {
        _bootstrapTx(_approveData());
        _expectApprove();
        paymaster.validate();
    }

    function test_bootstrapAcceptsMoreThanTheCap() public {
        _bootstrapTx(abi.encodeCall(IERC20.approve, (address(paymaster), type(uint256).max)));
        _expectApprove();
        paymaster.validate();
    }

    function test_bootstrapRejectsAmountBelowCap() public {
        _bootstrapTx(abi.encodeCall(IERC20.approve, (address(paymaster), CAP - 1)));
        vm.expectRevert(FrameGasPaymaster.ApproveNotBound.selector);
        paymaster.validate();
    }

    function test_bootstrapRejectsAnotherSpender() public {
        _bootstrapTx(abi.encodeCall(IERC20.approve, (address(0xBAD), CAP)));
        vm.expectRevert(FrameGasPaymaster.ApproveNotBound.selector);
        paymaster.validate();
    }

    function test_bootstrapRejectsAnotherFunction() public {
        _bootstrapTx(abi.encodeCall(IERC20.transfer, (address(paymaster), CAP)));
        vm.expectRevert(FrameGasPaymaster.ApproveNotBound.selector);
        paymaster.validate();
    }

    /// @dev Dirty upper bits pass a truncating read, but the token's decoder would revert.
    function test_bootstrapRejectsDirtySpenderWord() public {
        uint256 dirty = uint256(uint160(address(paymaster))) | (1 << 200);
        _bootstrapTx(abi.encodeWithSelector(IERC20.approve.selector, dirty, CAP));
        vm.expectRevert(FrameGasPaymaster.ApproveNotBound.selector);
        paymaster.validate();
    }

    function test_bootstrapRejectsTrailingData() public {
        _bootstrapTx(abi.encodePacked(_approveData(), uint256(1)));
        vm.expectRevert(FrameGasPaymaster.ApproveNotBound.selector);
        paymaster.validate();
    }

    function test_bootstrapRejectsValue() public {
        _bootstrapTx(_approveData());
        fp.set(2, VALUE, 1);
        vm.expectRevert(FrameGasPaymaster.ApproveNotBound.selector);
        paymaster.validate();
    }

    function test_bootstrapRejectsAtomicBatch() public {
        _bootstrapTx(_approveData());
        fp.set(2, ATOMIC, 1);
        vm.expectRevert(FrameGasPaymaster.ApproveNotBound.selector);
        paymaster.validate();
    }

    function test_bootstrapRejectsSenderlessMode() public {
        _bootstrapTx(_approveData());
        fp.set(2, MODE, 0);
        vm.expectRevert(FrameGasPaymaster.ApproveNotBound.selector);
        paymaster.validate();
    }

    function test_bootstrapRejectsLowGas() public {
        _bootstrapTx(_approveData());
        fp.set(2, GAS_LIMIT, MIN_APPROVE_GAS - 1);
        vm.expectRevert(
            abi.encodeWithSelector(FrameGasPaymaster.ApproveGasTooLow.selector, MIN_APPROVE_GAS - 1, MIN_APPROVE_STATE)
        );
        paymaster.validate();
    }

    function test_bootstrapRejectsLowStateGas() public {
        _bootstrapTx(_approveData());
        fp.set(2, STATE_LIMIT, MIN_APPROVE_STATE - 1);
        vm.expectRevert(
            abi.encodeWithSelector(FrameGasPaymaster.ApproveGasTooLow.selector, MIN_APPROVE_GAS, MIN_APPROVE_STATE - 1)
        );
        paymaster.validate();
    }

    function test_bootstrapRejectsAPermitToo() public {
        _bootstrapTx(_approveData());
        _setSettleData(3, _settleData(CAP, 27, bytes32(uint256(1)), bytes32(uint256(1))));
        fp.set(3, STATE_LIMIT, MIN_SETTLE_PERMIT_STATE);
        vm.expectRevert(FrameGasPaymaster.PermitWithBootstrap.selector);
        paymaster.validate();
    }

    function test_bootstrapRejectsWhenBalanceBelowCap() public {
        _bootstrapTx(_approveData());
        vm.prank(user);
        token.transfer(address(1), 100e6 - CAP + 1);
        vm.expectRevert(abi.encodeWithSelector(FrameGasPaymaster.InsufficientBalance.selector, CAP - 1, CAP));
        paymaster.validate();
    }

    /// @dev Validation demands the settle frame right after the approve, so it runs before any user call.
    function test_bootstrapRejectsWhenSettleDoesNotFollowApprove() public {
        _bootstrapTx(_approveData());
        _frame(3, address(0xCAFE), 2, MIN_SETTLE_GAS, MIN_SETTLE_STATE);
        vm.expectRevert(FrameGasPaymaster.SettleNotBound.selector);
        paymaster.validate();
    }

    /// @dev The whole first transaction: no allowance, no ETH, then the allowance exists when settlement pulls.
    function test_bootstrapApproveThenSettleThenRefund() public {
        _bootstrapTx(_approveData());
        _expectApprove();
        paymaster.validate();

        uint256 start = address(paymaster).balance;
        vm.deal(address(paymaster), start - MAX_COST);
        vm.startPrank(user);
        token.approve(address(paymaster), CAP);
        txp.set(0x0A, 3);
        paymaster.settle(CAP, 0, 0, 0);
        vm.stopPrank();
        assertEq(address(paymaster).balance, start);

        for (uint256 i = 0; i < 5; i++) {
            fp.set(i, GAS_USED, 1_000);
            fp.set(i, STATE_USED, 0);
            fp.set(i, STATUS, 1);
        }
        txp.set(0x0A, 5);
        vm.txGasPrice(MAX_FEE);
        uint256 tokensBefore = token.balanceOf(user);
        vm.prank(user);
        paymaster.refund(3);
        assertGt(token.balanceOf(user), tokensBefore, "the refund also works across the approve frame");
    }

    function test_refundRejectsWhenTheFrameBeforeSettleIsAnotherContract() public {
        _bootstrapTx(_approveData());
        for (uint256 i = 0; i < 5; i++) {
            fp.set(i, STATUS, 1);
        }
        fp.set(2, TARGET, uint256(uint160(address(0xBAD))));
        txp.set(0x0A, 5);
        vm.prank(user);
        vm.expectRevert(FrameGasPaymaster.RefundNotSettled.selector);
        paymaster.refund(3);
    }

    // ---- validation: the price and the user's funds ------------------------------------------------------------

    function test_quoteMatchesPoolPriceWithBuffer() public view {
        // 0.0014 ETH at about 2,386.57 fgUSD per ETH, plus 5%: about 3.508 fgUSD.
        assertApproxEqAbs(paymaster.quote(MAX_COST), 3_508_260, 500);
    }

    function test_validateRevertsWhenCostExceedsCap() public {
        uint256 quoted = paymaster.quote(MAX_COST);
        _setSettleData(SETTLE_FRAME, _settleData(quoted - 1, 0, 0, 0));
        vm.expectRevert(abi.encodeWithSelector(FrameGasPaymaster.CostAboveCap.selector, quoted, quoted - 1));
        paymaster.validate();
    }

    function test_validateAcceptsCostExactlyAtCap() public {
        _setSettleData(SETTLE_FRAME, _settleData(paymaster.quote(MAX_COST), 0, 0, 0));
        _expectApprove();
        paymaster.validate();
    }

    function test_validateRevertsWhenBalanceBelowCap() public {
        vm.prank(user);
        token.transfer(address(1), 100e6 - CAP + 1);
        vm.expectRevert(abi.encodeWithSelector(FrameGasPaymaster.InsufficientBalance.selector, CAP - 1, CAP));
        paymaster.validate();
    }

    function test_validateRevertsWhenAllowanceBelowCap() public {
        vm.prank(user);
        token.approve(address(paymaster), CAP - 1);
        vm.expectRevert(abi.encodeWithSelector(FrameGasPaymaster.InsufficientAllowance.selector, CAP - 1, CAP));
        paymaster.validate();
    }

    function test_validateRevertsWhenTickDeviatesEitherWay() public {
        int24 ref = paymaster.refTick();
        _moveTickTo(ref + MAX_DEVIATION + 60);
        (, int24 up,,) = manager.getSlot0(key.toId());
        vm.expectRevert(abi.encodeWithSelector(FrameGasPaymaster.TickDeviated.selector, up, ref));
        paymaster.validate();

        _moveTickTo(ref - MAX_DEVIATION - 60);
        (, int24 down,,) = manager.getSlot0(key.toId());
        vm.expectRevert(abi.encodeWithSelector(FrameGasPaymaster.TickDeviated.selector, down, ref));
        paymaster.validate();
    }

    // ---- validation: permits -----------------------------------------------------------------------------------

    function _permitTx(uint256 signerKey, uint256 nonce, uint256 deadline) internal {
        vm.prank(user);
        token.approve(address(paymaster), 0);
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(signerKey, CAP, nonce, deadline);
        _setSettleData(SETTLE_FRAME, _settleData(CAP, v, r, s));
        fp.set(SETTLE_FRAME, STATE_LIMIT, MIN_SETTLE_PERMIT_STATE);
    }

    function test_validateAcceptsAValidPermitWithNoAllowance() public {
        _permitTx(USER_KEY, 0, type(uint256).max);
        _expectApprove();
        paymaster.validate();
    }

    /// @dev A first permit writes new slots, so too little state gas would make settlement run out.
    function test_validateRejectsPermitWithLowStateGas() public {
        _permitTx(USER_KEY, 0, type(uint256).max);
        fp.set(SETTLE_FRAME, STATE_LIMIT, MIN_SETTLE_PERMIT_STATE - 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                FrameGasPaymaster.SettleGasTooLow.selector, MIN_SETTLE_GAS, MIN_SETTLE_PERMIT_STATE - 1
            )
        );
        paymaster.validate();
    }

    function test_validateRejectsPermitFromAnotherSigner() public {
        _permitTx(0xB0B, 0, type(uint256).max);
        vm.expectRevert(FrameGasPaymaster.InvalidPermit.selector);
        paymaster.validate();
    }

    function test_validateRejectsPermitWithStaleNonce() public {
        _permitTx(USER_KEY, 1, type(uint256).max);
        vm.expectRevert(FrameGasPaymaster.InvalidPermit.selector);
        paymaster.validate();
    }

    /// @dev Validation cannot read TIMESTAMP, so only an unexpiring permit can be checked there.
    function test_validateRejectsPermitWithADeadline() public {
        _permitTx(USER_KEY, 0, block.timestamp + 1 hours);
        vm.expectRevert(FrameGasPaymaster.InvalidPermit.selector);
        paymaster.validate();
    }

    /// @dev ecrecover accepts a high `s` but the token rejects it, so this would pass validation and fail settlement.
    function test_validateRejectsMalleablePermit() public {
        vm.prank(user);
        token.approve(address(paymaster), 0);
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(USER_KEY, CAP, 0, type(uint256).max);
        bytes32 highS = bytes32(SECP_N - uint256(s));
        uint8 flippedV = v == 27 ? 28 : 27;
        _setSettleData(SETTLE_FRAME, _settleData(CAP, flippedV, r, highS));
        fp.set(SETTLE_FRAME, STATE_LIMIT, MIN_SETTLE_PERMIT_STATE);
        vm.expectRevert(FrameGasPaymaster.InvalidPermit.selector);
        paymaster.validate();
    }

    // ---- settlement ----------------------------------------------------------------------------------------------

    function test_settleBuysExactlyTheMaximumCost() public {
        uint256 before = address(paymaster).balance;
        uint256 tokensBefore = token.balanceOf(user);
        _settleAsChain();
        assertEq(address(paymaster).balance, before, "the swap restores what APPROVE collected");
        uint256 paid = tokensBefore - token.balanceOf(user);
        assertGt(paid, 0);
        assertLe(paid, CAP);
    }

    function test_settleAppliesAPermit() public {
        _permitTx(USER_KEY, 0, type(uint256).max);
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(USER_KEY, CAP, 0, type(uint256).max);
        vm.deal(address(paymaster), address(paymaster).balance - MAX_COST);
        txp.set(0x0A, SETTLE_FRAME);
        vm.prank(user);
        paymaster.settle(CAP, v, r, s);
        assertEq(token.nonces(user), 1);
        assertEq(address(paymaster).balance, FLOAT);
    }

    /// @dev Someone may submit the user's permit first. Settlement must still succeed.
    function test_settleSurvivesAFrontRunPermit() public {
        _permitTx(USER_KEY, 0, type(uint256).max);
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(USER_KEY, CAP, 0, type(uint256).max);
        token.permit(user, address(paymaster), CAP, type(uint256).max, v, r, s);
        vm.deal(address(paymaster), address(paymaster).balance - MAX_COST);
        txp.set(0x0A, SETTLE_FRAME);
        vm.prank(user);
        paymaster.settle(CAP, v, r, s);
        assertEq(address(paymaster).balance, FLOAT);
    }

    function test_settleRevertsAboveTheCap() public {
        vm.deal(address(paymaster), address(paymaster).balance - MAX_COST);
        txp.set(0x0A, SETTLE_FRAME);
        uint256 quoted = paymaster.quote(MAX_COST);
        vm.prank(user);
        try paymaster.settle(1e6, 0, 0, 0) {
            revert("settle should have reverted");
        } catch (bytes memory reason) {
            // PoolManager wraps nothing here: the callback's own error surfaces.
            assertEq(bytes4(reason), FrameGasPaymaster.CostAboveCap.selector);
        }
        assertGt(quoted, 1e6);
        assertEq(token.balanceOf(user), 100e6);
    }

    function test_settleRejectsAnyoneButTheSender() public {
        txp.set(0x0A, SETTLE_FRAME);
        vm.prank(address(0xBAD));
        vm.expectRevert(FrameGasPaymaster.NotTxSender.selector);
        paymaster.settle(CAP, 0, 0, 0);
    }

    function test_unlockCallbackRejectsAnyoneButThePoolManager() public {
        vm.expectRevert(FrameGasPaymaster.NotPoolManager.selector);
        paymaster.unlockCallback("");
    }

    // ---- refund --------------------------------------------------------------------------------------------------

    /// @dev Runs a whole transaction at `price` and returns the paymaster's ETH after the chain returns the unused gas.
    function _wholeTx(uint256 price, uint256 refundUsed) internal returns (uint256 finalBalance, uint256 refunded) {
        _settleAsChain();
        _finishFramesBeforeRefund(1);
        vm.txGasPrice(price);
        uint256 tokensBefore = token.balanceOf(user);
        vm.prank(user);
        paymaster.refund(SETTLE_FRAME);
        refunded = token.balanceOf(user) - tokensBefore;
        uint256 intrinsic = MAX_GAS - (30_000 + 60_000 + MIN_SETTLE_GAS + MIN_SETTLE_STATE + 50_000 + 250_000);
        uint256 used = intrinsic + 100 + 45_000 + 150_000 + 3_000 + refundUsed;
        uint256 charged = used * price;
        finalBalance = address(paymaster).balance + (MAX_COST - charged);
    }

    function test_refundReturnsTokensAndLeavesThePaymasterWhole() public {
        uint256 start = address(paymaster).balance;
        uint256 tokensBefore = token.balanceOf(user);
        (uint256 finalBalance, uint256 refunded) = _wholeTx(MAX_FEE, REFUND_ESTIMATE);
        assertGt(refunded, 0, "the user gets tokens back");
        assertGe(finalBalance, start, "the paymaster never ends short");
        assertLt(tokensBefore - token.balanceOf(user), CAP);
    }

    function test_refundIsLargerAtALowerGasPrice() public {
        uint256 snapshot = vm.snapshotState();
        (, uint256 atMaxFee) = _wholeTx(MAX_FEE, REFUND_ESTIMATE);
        vm.revertToState(snapshot);
        uint256 start = address(paymaster).balance;
        (uint256 finalBalance, uint256 atLowPrice) = _wholeTx(1 gwei, REFUND_ESTIMATE);
        assertGt(atLowPrice, atMaxFee);
        assertGe(finalBalance, start);
    }

    function test_refundRejectsAnyoneButTheSender() public {
        _settleAsChain();
        _finishFramesBeforeRefund(1);
        vm.prank(address(0xBAD));
        vm.expectRevert(FrameGasPaymaster.NotTxSender.selector);
        paymaster.refund(SETTLE_FRAME);
    }

    /// @dev Being last is what stops a second refund frame selling the same surplus twice.
    function test_refundRevertsWhenNotTheLastFrame() public {
        _settleAsChain();
        _finishFramesBeforeRefund(1);
        txp.set(0x09, 6);
        vm.prank(user);
        vm.expectRevert(FrameGasPaymaster.RefundNotLastFrame.selector);
        paymaster.refund(SETTLE_FRAME);
    }

    /// @dev A wallet's own frame could otherwise call refund several times from inside one frame.
    function test_refundRevertsWhenTheFrameTargetsAnotherContract() public {
        _settleAsChain();
        _finishFramesBeforeRefund(1);
        fp.set(REFUND_FRAME, TARGET, uint256(uint160(user)));
        vm.prank(user);
        vm.expectRevert(FrameGasPaymaster.RefundNotLastFrame.selector);
        paymaster.refund(SETTLE_FRAME);
    }

    function test_refundRevertsWhenSettlementFailed() public {
        _finishFramesBeforeRefund(0);
        vm.prank(user);
        vm.expectRevert(FrameGasPaymaster.RefundNotSettled.selector);
        paymaster.refund(SETTLE_FRAME);
    }

    /// @dev A settle frame paid for by a different payer must not unlock this paymaster's ETH.
    function test_refundRevertsWhenThisPaymasterDidNotValidate() public {
        _finishFramesBeforeRefund(1);
        fp.set(VERIFY_FRAME, TARGET, uint256(uint160(address(0xBAD))));
        vm.prank(user);
        vm.expectRevert(FrameGasPaymaster.RefundNotSettled.selector);
        paymaster.refund(SETTLE_FRAME);
    }

    function test_refundRevertsWhenItOverrunsItsGasEstimate() public {
        FrameGasPaymaster tight = _deploy(0, 1_000);
        (MockTxParam t, MockFrameParam f, MockFrameDataLoad d) = etchFrameMocks(address(tight));
        (txp, fp, data) = (t, f, d);
        paymaster = tight;
        vm.prank(user);
        token.approve(address(tight), CAP);
        _standardTx(_settleData(CAP, 0, 0, 0));
        _settleAsChain();
        _finishFramesBeforeRefund(1);
        vm.txGasPrice(1 gwei);
        vm.prank(user);
        try tight.refund(SETTLE_FRAME) {
            revert("refund should have reverted");
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), FrameGasPaymaster.RefundGasExceeded.selector);
        }
    }

    // ---- the reference tick --------------------------------------------------------------------------------------

    /// @dev A market move past the limit fails every validation. Syncing must recover it with no transaction validating.
    function test_bricked_referenceRecoversThroughSync() public {
        int24 start = paymaster.refTick();
        _moveTickTo(start + 2 * MAX_DEVIATION + 120);
        vm.expectRevert();
        paymaster.validate();

        // Literal block numbers: via_ir caches block.number across vm.roll within one test.
        vm.roll(1000);
        paymaster.syncReference();
        assertEq(paymaster.refTick(), start + MAX_DEVIATION, "moves at most MAX_DEVIATION");
        vm.roll(1001);
        paymaster.syncReference();

        vm.prank(user);
        token.approve(address(paymaster), type(uint256).max);
        _setSettleData(SETTLE_FRAME, _settleData(100e6, 0, 0, 0));
        _expectApprove();
        paymaster.validate();
    }

    function test_syncReferenceNeverPassesTheMarket() public {
        int24 start = paymaster.refTick();
        _moveTickTo(start + 120);
        (, int24 tick,,) = manager.getSlot0(key.toId());
        vm.roll(1000);
        paymaster.syncReference();
        assertEq(paymaster.refTick(), tick);
        vm.roll(1001);
        paymaster.syncReference();
        assertEq(paymaster.refTick(), tick, "a second sync stays on the market");
    }

    function test_syncReferenceRunsOncePerBlock() public {
        vm.roll(1000);
        paymaster.syncReference();
        vm.expectRevert(FrameGasPaymaster.AlreadySynced.selector);
        paymaster.syncReference();
    }

    /// @dev Settlement and sync share one per-block allowance, or a caller could walk the reference twice as fast.
    function test_settleAndSyncShareThePerBlockLimit() public {
        int24 start = paymaster.refTick();
        _moveTickTo(start + 3 * MAX_DEVIATION);
        vm.roll(1000);
        vm.prank(user);
        token.approve(address(paymaster), type(uint256).max);
        vm.deal(address(paymaster), address(paymaster).balance - MAX_COST);
        txp.set(0x0A, SETTLE_FRAME);
        vm.prank(user);
        paymaster.settle(100e6, 0, 0, 0);
        assertEq(paymaster.refTick(), start + MAX_DEVIATION);
        vm.expectRevert(FrameGasPaymaster.AlreadySynced.selector);
        paymaster.syncReference();
        assertEq(paymaster.refTick(), start + MAX_DEVIATION);
    }

    function test_receiveAcceptsTopUpsFromAnyone() public {
        uint256 before = address(paymaster).balance;
        vm.deal(address(1), 1 ether);
        vm.prank(address(1));
        (bool ok,) = address(paymaster).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(address(paymaster).balance, before + 1 ether);
    }

    function testFuzz_quoteIsMonotonicInCost(uint96 a, uint96 b) public view {
        (uint256 low, uint256 high) = a < b ? (uint256(a), uint256(b)) : (uint256(b), uint256(a));
        assertLe(paymaster.quote(low), paymaster.quote(high));
    }
}
