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
import {FrameMocks} from "./FrameMocks.sol";

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

contract FrameGasPaymasterTest is FrameMocks {
    using StateLibrary for IPoolManager;

    event Approved(uint256 scope);

    uint24 internal constant FEE = 3000;
    int24 internal constant SPACING = 60;
    int24 internal constant MAX_DEVIATION = 1000;
    uint256 internal constant BUFFER_BPS = 500;
    uint256 internal constant STAKE = 0.012 ether;
    uint256 internal constant MAX_COST = 0.0003 ether;
    uint256 internal constant CAP = 2e6;
    // 1 ETH is about 2,386 fgUSD: the price the devnet pool was seeded at.
    uint160 internal constant SQRT_PRICE = 3870497721706919791279764;

    address internal constant USER = address(0xA11CE);

    IPoolManager internal manager;
    FgUSD internal token;
    MockRegistry internal registry;
    PoolKey internal key;
    PoolSwapTest internal swapper;
    FrameGasPaymaster internal paymaster;

    /// @dev The liquidity and swap routers refund unused ETH to this contract.
    receive() external payable {}

    function setUp() public {
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

        paymaster = _deploy(STAKE);
        token.transfer(USER, 100e6);
        vm.prank(USER);
        token.approve(address(paymaster), CAP);
        mockFrame(address(paymaster), USER, MAX_COST);
    }

    function _deploy(uint256 stake) internal returns (FrameGasPaymaster) {
        return new FrameGasPaymaster{value: stake + 0.02 ether}(
            manager, registry, IERC20(address(token)), FEE, SPACING, MAX_DEVIATION, BUFFER_BPS, stake, 86400
        );
    }

    /// @dev Moves the pool until its tick reaches `target`.
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

    function test_constructorStakesAsTheContract() public view {
        (uint256 stake, uint32 delay, uint64 withdrawTime) = registry.getDepositInfo(address(paymaster));
        assertEq(stake, STAKE);
        assertEq(delay, 86400);
        assertEq(withdrawTime, 0);
        assertEq(address(paymaster).balance, 0.02 ether);
    }

    function test_constructorWithZeroStakeDoesNotStake() public {
        FrameGasPaymaster unstaked = _deploy(0);
        (uint256 stake,,) = registry.getDepositInfo(address(unstaked));
        assertEq(stake, 0);
    }

    function test_constructorRejectsUninitializedPool() public {
        FgUSD other = new FgUSD(1);
        vm.expectRevert(FrameGasPaymaster.PoolNotInitialized.selector);
        new FrameGasPaymaster(manager, registry, IERC20(address(other)), FEE, SPACING, MAX_DEVIATION, BUFFER_BPS, 0, 0);
    }

    function test_validateApprovesPaymentScope() public {
        vm.expectEmit(address(paymaster));
        emit Approved(1);
        paymaster.validate(CAP);
    }

    function test_quoteMatchesPoolPriceWithBuffer() public view {
        // 0.0003 ETH at about 2,386.57 fgUSD per ETH, plus 5%: about 0.7518 fgUSD.
        uint256 quoted = paymaster.quote(MAX_COST);
        assertApproxEqAbs(quoted, 751_770, 100);
    }

    function test_validateRevertsWhenCostExceedsCap() public {
        uint256 quoted = paymaster.quote(MAX_COST);
        vm.expectRevert(abi.encodeWithSelector(FrameGasPaymaster.CostAboveCap.selector, quoted, quoted - 1));
        paymaster.validate(quoted - 1);
    }

    function test_validateAcceptsCostExactlyAtCap() public {
        uint256 quoted = paymaster.quote(MAX_COST);
        vm.expectEmit(address(paymaster));
        emit Approved(1);
        paymaster.validate(quoted);
    }

    function test_validateRevertsWhenBalanceBelowCap() public {
        vm.startPrank(USER);
        token.transfer(address(1), 100e6 - CAP + 1);
        vm.stopPrank();
        vm.expectRevert(abi.encodeWithSelector(FrameGasPaymaster.InsufficientBalance.selector, CAP - 1, CAP));
        paymaster.validate(CAP);
    }

    function test_validateRevertsWhenAllowanceBelowCap() public {
        vm.prank(USER);
        token.approve(address(paymaster), CAP - 1);
        vm.expectRevert(abi.encodeWithSelector(FrameGasPaymaster.InsufficientAllowance.selector, CAP - 1, CAP));
        paymaster.validate(CAP);
    }

    function test_validateRevertsWhenTickDeviatesEitherWay() public {
        int24 ref = paymaster.refTick();
        _moveTickTo(ref + MAX_DEVIATION + 60);
        (, int24 up,,) = manager.getSlot0(key.toId());
        vm.expectRevert(abi.encodeWithSelector(FrameGasPaymaster.TickDeviated.selector, up, ref));
        paymaster.validate(100e6);

        _moveTickTo(ref - MAX_DEVIATION - 60);
        (, int24 down,,) = manager.getSlot0(key.toId());
        vm.expectRevert(abi.encodeWithSelector(FrameGasPaymaster.TickDeviated.selector, down, ref));
        paymaster.validate(100e6);
    }

    function test_validateAcceptsMovesWithinDeviation() public {
        _moveTickTo(paymaster.refTick() - MAX_DEVIATION + 60);
        vm.prank(USER);
        token.approve(address(paymaster), 100e6);
        vm.expectEmit(address(paymaster));
        emit Approved(1);
        paymaster.validate(100e6);
    }

    /// @dev A move past the limit must not brick the paymaster: syncing recovers it without any transaction validating.
    function test_syncReferenceRecoversAfterLargeMove() public {
        int24 start = paymaster.refTick();
        _moveTickTo(start + 2 * MAX_DEVIATION + 120);
        vm.prank(USER);
        token.approve(address(paymaster), 100e6);
        vm.expectRevert();
        paymaster.validate(100e6);

        // Literal block numbers: via_ir caches block.number across vm.roll within one test.
        vm.roll(1000);
        paymaster.syncReference();
        assertEq(paymaster.refTick(), start + MAX_DEVIATION, "moves at most MAX_DEVIATION");
        vm.roll(1001);
        paymaster.syncReference();

        vm.expectEmit(address(paymaster));
        emit Approved(1);
        paymaster.validate(100e6);
    }

    function test_syncReferenceRunsOncePerBlock() public {
        vm.roll(block.number + 1);
        paymaster.syncReference();
        vm.expectRevert(FrameGasPaymaster.AlreadySynced.selector);
        paymaster.syncReference();
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

    /// @dev Whatever the cost, validation only approves when the quote fits under the signed cap.
    function testFuzz_validateNeverApprovesAboveCap(uint96 maxCost, uint64 cap) public {
        vm.prank(USER);
        token.approve(address(paymaster), type(uint256).max);
        mockFrame(address(paymaster), USER, maxCost);
        uint256 quoted = paymaster.quote(maxCost);
        uint256 capped = bound(uint256(cap), 0, 100e6);
        if (quoted > capped) {
            vm.expectRevert(abi.encodeWithSelector(FrameGasPaymaster.CostAboveCap.selector, quoted, capped));
        } else {
            vm.expectEmit(address(paymaster));
            emit Approved(1);
        }
        paymaster.validate(capped);
    }
}
