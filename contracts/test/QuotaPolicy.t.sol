// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {FrameGasPaymaster} from "../src/FrameGasPaymaster.sol";
import {PaymasterBase} from "./PaymasterBase.sol";

/// @dev The opt-in daily quota: validation checks it, settlement records it, epochs reset it.
contract QuotaPolicyTest is PaymasterBase {
    uint256 internal epochBlocks;

    function _setUpQuota() internal {
        epochBlocks = paymaster.EPOCH_BLOCKS();
    }

    function _spent() internal view returns (uint256 spent) {
        (, spent,) = paymaster.quotas(user);
    }

    /// @dev Settles one transaction at the full cap's worth of ETH, then rewinds the mocks to validation.
    function _settleOnce() internal returns (uint256 paid) {
        vm.prank(user);
        token.approve(address(paymaster), type(uint256).max);
        uint256 before = token.balanceOf(user);
        _settleAsChain();
        paid = before - token.balanceOf(user);
        txp.set(0x0A, VERIFY_FRAME);
    }

    function _quotaExceeded(uint256 spent, uint256 limit) internal {
        vm.expectRevert(abi.encodeWithSelector(FrameGasPaymaster.QuotaExceeded.selector, spent, CAP, limit));
    }

    // ---- default -------------------------------------------------------------------------------------------------

    function test_noQuotaByDefault() public {
        (uint256 limit, uint256 spent, uint256 remaining) = paymaster.quotaOf(user);
        assertEq(limit, 0);
        assertEq(spent, 0);
        assertEq(remaining, type(uint256).max);
        _expectApprove();
        paymaster.validate();
    }

    function test_settleRecordsNothingWithoutAQuota() public {
        _settleOnce();
        (uint96 limit, uint96 spent, uint32 e) = paymaster.quotas(user);
        assertEq(limit, 0);
        assertEq(spent, 0);
        assertEq(e, 0);
    }

    // ---- cap enforced --------------------------------------------------------------------------------------------

    function test_quotaExactlyAtTheCapPasses() public {
        vm.prank(user);
        paymaster.setQuota(CAP);
        _expectApprove();
        paymaster.validate();
    }

    function test_quotaBelowTheCapRejects() public {
        vm.prank(user);
        paymaster.setQuota(CAP - 1);
        _quotaExceeded(0, CAP - 1);
        paymaster.validate();
    }

    function test_settleRecordsWhatWasPulledNotTheCap() public {
        vm.prank(user);
        paymaster.setQuota(100e6);
        uint256 paid = _settleOnce();
        assertGt(paid, 0);
        assertLt(paid, CAP);
        assertEq(_spent(), paid);
    }

    function test_capEnforcedAfterSpending() public {
        vm.prank(user);
        paymaster.setQuota(2 * CAP);
        uint256 paid = _settleOnce();
        // 2*CAP remains enough for one more cap only while spent stays at or below CAP.
        _expectApprove();
        paymaster.validate();

        uint256 paid2 = _settleOnce();
        _quotaExceeded(paid + paid2, 2 * CAP);
        paymaster.validate();
    }

    function test_quotaOfMatchesValidation() public {
        vm.prank(user);
        paymaster.setQuota(7e6);
        uint256 paid = _settleOnce();
        (uint256 limit, uint256 spent, uint256 remaining) = paymaster.quotaOf(user);
        assertEq(limit, 7e6);
        assertEq(spent, paid);
        assertEq(remaining, 7e6 - paid);
    }

    /// @dev However many transactions settle in an epoch, what validation let through stays within the limit.
    function testFuzz_spentNeverExceedsTheLimit(uint64 limitSeed, uint8 attempts) public {
        uint256 limit = bound(limitSeed, 1, 30e6);
        vm.prank(user);
        paymaster.setQuota(limit);
        token.transfer(user, 1_000e6);
        for (uint256 i = 0; i < bound(attempts, 1, 12); i++) {
            (,, uint256 remaining) = paymaster.quotaOf(user);
            if (remaining < CAP) {
                vm.expectRevert();
                paymaster.validate();
                break;
            }
            paymaster.validate();
            _settleOnce();
            assertLe(_spent(), limit);
        }
    }

    // ---- epochs ----------------------------------------------------------------------------------------------------

    function test_resetsOnEpochRoll() public {
        _setUpQuota();
        vm.prank(user);
        paymaster.setQuota(CAP);
        uint256 paid = _settleOnce();
        _quotaExceeded(paid, CAP);
        paymaster.validate();

        vm.roll(block.number + epochBlocks);
        // Validation reads the stored epoch, which has not moved yet.
        _quotaExceeded(paid, CAP);
        paymaster.validate();

        paymaster.rollEpoch();
        assertEq(paymaster.epoch(), 1);
        _expectApprove();
        paymaster.validate();
    }

    function test_noRollBeforeTheBoundary() public {
        _setUpQuota();
        uint256 start = paymaster.epochStartBlock();
        vm.roll(start + epochBlocks - 1);
        paymaster.rollEpoch();
        assertEq(paymaster.epoch(), 0);
        vm.roll(start + epochBlocks);
        paymaster.rollEpoch();
        assertEq(paymaster.epoch(), 1);
        assertEq(paymaster.epochStartBlock(), start + epochBlocks);
    }

    function test_settlementRollsTheEpoch() public {
        _setUpQuota();
        vm.prank(user);
        paymaster.setQuota(CAP);
        _settleOnce();
        vm.roll(block.number + epochBlocks);
        _settleOnce();
        assertEq(paymaster.epoch(), 1);
        (,, uint32 e) = paymaster.quotas(user);
        assertEq(e, 1, "spent was reset, then charged in the new epoch");
    }

    function test_rollSkipsQuietEpochsInOneStep() public {
        _setUpQuota();
        uint256 start = paymaster.epochStartBlock();
        vm.roll(start + 5 * epochBlocks + 17);
        paymaster.rollEpoch();
        assertEq(paymaster.epoch(), 5);
        assertEq(paymaster.epochStartBlock(), start + 5 * epochBlocks);
    }

    // ---- changing the quota ----------------------------------------------------------------------------------------

    function test_loweringAppliesAtOnce() public {
        vm.startPrank(user);
        paymaster.setQuota(100e6);
        paymaster.setQuota(CAP - 1);
        vm.stopPrank();
        _quotaExceeded(0, CAP - 1);
        paymaster.validate();
    }

    function test_raisingAppliesFromTheNextEpoch() public {
        _setUpQuota();
        vm.startPrank(user);
        paymaster.setQuota(CAP - 1);
        paymaster.setQuota(100e6);
        vm.stopPrank();
        (, uint256 spent, uint256 remaining) = paymaster.quotaOf(user);
        assertEq(remaining, CAP - 1, "what remains today is unchanged");
        _quotaExceeded(spent, 100e6);
        paymaster.validate();

        vm.roll(block.number + epochBlocks);
        paymaster.rollEpoch();
        _expectApprove();
        paymaster.validate();
    }

    function test_removingAppliesFromTheNextEpoch() public {
        _setUpQuota();
        vm.startPrank(user);
        paymaster.setQuota(CAP - 1);
        paymaster.setQuota(0);
        vm.stopPrank();
        (uint256 limit,, uint256 remaining) = paymaster.quotaOf(user);
        assertEq(limit, type(uint96).max);
        assertEq(remaining, CAP - 1);
        vm.expectRevert();
        paymaster.validate();

        vm.roll(block.number + epochBlocks);
        paymaster.rollEpoch();
        _expectApprove();
        paymaster.validate();
    }

    function test_setQuotaZeroWithoutAQuotaDoesNothing() public {
        vm.prank(user);
        paymaster.setQuota(0);
        (uint96 limit,,) = paymaster.quotas(user);
        assertEq(limit, 0);
    }

    function test_setQuotaRejectsAbove96Bits() public {
        vm.prank(user);
        vm.expectRevert(FrameGasPaymaster.QuotaTooLarge.selector);
        paymaster.setQuota(uint256(type(uint96).max) + 1);
    }

    // ---- bootstrap -------------------------------------------------------------------------------------------------

    function _bootstrapTx() internal {
        vm.prank(user);
        token.approve(address(paymaster), 0);
        txp.set(0x09, 6);
        _frame(2, address(token), 2, MIN_APPROVE_GAS, MIN_APPROVE_STATE);
        _setSettleData(2, abi.encodeCall(IERC20.approve, (address(paymaster), CAP)));
        _frame(3, address(paymaster), 2, MIN_SETTLE_GAS, MIN_SETTLE_STATE);
        _setSettleData(3, _settleData(CAP, 0, 0, 0));
        _frame(4, address(paymaster), 2, 120_000, 97_920); // the user call: setQuota
        _frame(5, address(paymaster), 2, 250_000, 0);
    }

    function test_notBypassableViaBootstrapMode() public {
        vm.prank(user);
        paymaster.setQuota(CAP);
        _settleOnce();
        _bootstrapTx();
        _quotaExceeded(_spent(), CAP);
        paymaster.validate();
    }

    function test_bootstrapRejectsAQuotaBelowTheCap() public {
        vm.prank(user);
        paymaster.setQuota(CAP - 1);
        _bootstrapTx();
        _quotaExceeded(0, CAP - 1);
        paymaster.validate();
    }

    /// @dev The opt-in itself: a zero-ETH user's first transaction approves, settles, then calls setQuota.
    function test_optInInsideABootstrapTransaction() public {
        _bootstrapTx();
        _expectApprove();
        paymaster.validate();

        vm.deal(address(paymaster), address(paymaster).balance - MAX_COST);
        vm.startPrank(user);
        token.approve(address(paymaster), CAP); // frame 2
        txp.set(0x0A, 3);
        paymaster.settle(CAP, 0, 0, 0); // frame 3
        txp.set(0x0A, 4);
        paymaster.setQuota(20e6); // frame 4
        vm.stopPrank();

        (uint256 limit, uint256 spent, uint256 remaining) = paymaster.quotaOf(user);
        assertEq(limit, 20e6);
        assertEq(spent, 0, "the opt-in transaction's own payment predates the quota");
        assertEq(remaining, 20e6);
    }
}
