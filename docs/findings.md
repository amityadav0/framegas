# Findings: alt-mempool rules on the devnet

Observed behaviour on the devnet compared with the two rule texts it is measured against.

| Reference | Revision |
| --- | --- |
| Pinned draft ("PR #6") | [`forshtat/ERCs@74a868cd`](https://github.com/forshtat/ERCs/commit/74a868cd4fb173c00015235fec69d6d748d781cd), `ERCS/erc-7562.md` |
| ERC-8421 (draft, unmerged) | [`ethereum/ERCs#2028`](https://github.com/ethereum/ERCs/pull/2028) at `493ba8ac` |
| Workshop | [`forshtat/mempool-workshop@bcfe02a`](https://github.com/forshtat/mempool-workshop/commit/bcfe02a) |
| Sidecar source | [`forshtat/mempool-workshop-sidecar@2e22ff0`](https://github.com/forshtat/mempool-workshop-sidecar/commit/2e22ff0) |

**Evidence** says how each row is known. *Live* was observed on the devnet on 2026-11-05. *Source* was read from the sidecar's default branch and not exercised: the gateway reports `v4.1.1` with an empty `commit`, so the deployed build cannot be tied to a source revision.

## Baseline: an admitted transaction

Workshop steps 1 to 10 all reached their expected outcome on the first run. The transaction below reads another contract's storage during validation, so the canonical mempool refuses it and the alt-mempool admits it once the sender is staked.

| | |
| --- | --- |
| Canonical mempool, step 6 | Rejected: `Frame transaction validation-prefix simulation failed: StorageReadNonSender` |
| Alt-mempool, unstaked, step 6 | Rejected: `unstaked payer accessed 0xd25a…0b7b slot 0x0` |
| Alt-mempool, staked, step 8 | Admitted, 17 of 17 checks passed, mined in block 402611 |
| Link | <https://explorer.altmempool.wtf/tx/0xc0eacb0ce4278f607223364589393c7cf1d6f0d9f56a9afa19854c44076ce7a5> |

Explorer history is held in memory and is cleared when the node restarts, so this link may stop resolving after a devnet reset. The block itself is the durable record.

## Rule drift

| # | Observation | Pinned draft (PR #6) | ERC-8421 | Actual (devnet) | Evidence | Repro |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Validation gas budget | `MAX_VERIFY_GAS` applies to the whole prefix (FRA-040) | Per entity: 100,000 unstaked, 1,000,000 staked (BUDGET-010) | Flat 100,000 across the prefix, including signature cost (2,800 for SECP256K1), for staked entities too. `devnet-readme.md` describes a staked budget that the node does not apply. See [the cap test](#the-100000-cap-live) | Live and source | `scripts/03-validation-gas.ts` at `ecf811f` |
| 2 | The budget counts declared limits | Sum of `limits.execution` | Sum of `limits.execution` per entity | Declared limits are summed, not gas used. Step 8's sender frame declared 70,000 and used 15,805 | Live and source | `yarn step_11_debug <tx>`, `frames[0].limits`, `frameReceipts[0].gasUsed` |
| 3 | State gas cap in validation | `MAX_VERIFY_STATE_GAS` 500,000 | No such constant | 500,000 enforced | Source | `validationPrefix.ts` |
| 4 | Rule identifiers | `OP-*`, `STO-*`, `COD-*`, `GREP-*`, `FRA-*` | `OPCODES-*`, `STORAGE-*`, `REPUTATION-*`, `PREFIX-*` | PR #6 names appear in admission reports (`OP-011`, `OP-061`, `COD-010`) | Live | `yarn step_11_debug <tx>` |
| 5 | Who gets the wider storage access | "paymaster or factory" (STO-031 to STO-033) | Any staked entity (STORAGE-031 to STORAGE-033) | Any staked role. Step 8's entity is a self-paying sender, reported in the role `payer` | Live | Workshop step 8 |
| 6 | Minimum unstake delay | 86,400 s | 86,400 s (STAKING-010) | `skandha_config` reports `minUnstakeDelay: 0`. `minStake` is 0.01 ETH | Live | `skandha_config` |
| 7 | `BALANCE` / `SELFBALANCE` threshold | Staked entity (OP-080) | Staked entity (OPCODES-010) | Requires `stake > minStake`, strictly, while every other staked carve-out accepts `>=` | Source | `frameTx.ts`, `BANNED_OPCODE` check |
| 8 | Same-sender pending limit | 4, marked ERC-4337 only | 64 for unstaked senders, none for active staked senders | `MAX_MEMPOOL_USEROPS_PER_SENDER = 4` | Source | `MempoolService/constants.ts` |
| 9 | `pre_verify` frames (a `DEFAULT` frame before the approving frame, able to write) | Not defined | Defined (PREFIX-110, PREFIX-120) | Recognised by the sidecar source, so the source is ahead of the pin. Not exercised | Source | `validationPrefix.ts` |
| 10 | Banned-entity rejection text | `BANNED` entities are excluded | `BANNED` entities are excluded (REPUTATION-010) | Excluded, but the error reads `unstaked payer accessed …`, with no mention of the ban. Only the explorer's reputation view shows the cause | Live | Workshop steps 9 and 10 |

| 14 | Unstaked rejection names the first slot it reaches | Not specified | An unstaked paymaster with its own storage is rejected with `unstaked payer accessed payer slot 0x0`, its own slot, before the PoolManager read is reported. A probe with no storage of its own is rejected naming the PoolManager | Live | `scripts/02-staked-paymaster-proof.ts` at `e93a1db`, `scripts/03-validation-gas.ts` at `ecf811f` |
| 15 | `GAS` opcode | Allowed only directly before a `*CALL` (OP-012) | Bound by EIP-8141's banned opcodes | The sidecar's banned list contains `GAS`, yet Solidity's external calls pass. The trace's `usedOpcodes` omits opcode 90 for these calls. Bare `gasleft()` was not tested | Live | `ethrex_simulateFrameTransaction` with `trace: true` |
| 18 | Precompiles in validation | Core precompiles allowed (OP-062) | Core precompiles allowed (CALLING-040) | **All rejected.** `skandha_config` reports `precompiles: []`, so `ecrecover` in a validation frame fails with `payer accesses un-deployed contract address 0x…0001 with opcode STATICCALL`. ethrex's own simulation of the same transaction executes successfully | Live | `scripts/04-end-to-end.ts --permit-in-frame` |
| 19 | `FRAMEPARAM` ids 0x09 to 0x0B | Not in the pinned EIP-8141 table, which stops at 0x08 | Not specified | The devnet returns state gas limit, gas used and state gas used. Gas used matches the receipt for finished frames. Reading the current frame halts | Live | `scripts/06-frame-probe.ts` |
| 20 | Transient storage across frames | Treated like persistent storage (OP-070) | Treated like persistent storage | Does not survive from one frame to the next: a value written in one `SENDER` frame reads as 0 in the following one. Settlement therefore passes nothing to the refund this way | Live | `scripts/06-frame-probe.ts` |
| 21 | State gas per new storage slot | Not specified | Not specified | 97,920 state gas per zero-to-nonzero slot, on top of execution gas, and it counts toward the fee. Execution gas cannot substitute for it: a settle frame short of state gas fails even with 1,500,000 execution gas | Live | Receipts of the first end-to-end transaction below |
| 22 | Frame failure and later frames | Later frames still run (EIP-8141) | Later frames still run | Confirmed: in simulation a failed settle frame was followed by a successful user call. Validation has to rule out any settlement failure the user controls | Live | `ethrex_simulateFrameTransaction` |

## Devnet state versus its documentation

| # | Observation | Documented | Actual (devnet) | Evidence | Repro |
| --- | --- | --- | --- | --- | --- |
| 11 | Uniswap v4 stack | PoolManager, StateView, Permit2, WETH9 and Universal Router are predeployed (`deployments/devnet.md`) | Code present at all five addresses | Live | `cast code <addr>` |
| 12 | Example WETH9/USDC pool | "One is live today", pool ID `0x784b…0648` | Not initialised: `getSlot0` and `getLiquidity` return 0 at block 402640. The same file says the 2026-10-08 reset removed this pool | Live | `cast call <StateView> "getSlot0(bytes32)(uint160,int24,uint24,uint24)" <poolId>` |
| 16 | `ethrex_simulateFrameTransaction` response | `valid` and `violation` (`devnet-readme.md` section 6.1) | Those fields are absent. It returns `canonicalMempoolValid`, `canonicalMempoolViolation`, `executionStatus`, `failedFrameIndex`, `haltReason` and `haltDetail` | Live | `scripts/lib/frames.ts`, `simulate` |
| 17 | `TXPARAM` 0x06 (max cost) | `hegota-support` marks it "not in the EIP text" | It is in EIP-8141 at the pinned revision, and ethrex implements it. A 140,000 gas sum of frame limits at 2 gwei reports 0.000315 ETH, or 157,500 gas once intrinsic cost is included | Live | Simulation `maxCost` |
| 13 | Workshop docs | README links to `docs/findings.md`, `docs/decision-guide.md` and `docs/steps/` | Not in the repository since commit `250b03f`. Still readable from history | Live | `git show 250b03f^:docs/findings.md` |

## A staked contract paymaster reading PoolManager storage

Admitted and mined: <https://explorer.altmempool.wtf/tx/0xcafcd1666aec43cb979c8dcdf1ecc9d1eb52bfd359063b778a40f27c118206af> (block 402821, 24 of 24 checks passed).

The sender and the payer are separate accounts: an EOA holding 0 wei, and `FrameGasPaymaster` at `0x7503ed4e90b0cab850412fd8bf318b8e269f9996`, which staked 0.012 ETH from its own constructor. The registry accepts a contract staker, and the explorer reports `isStaked: true`.

| Case | Mempool | Result |
| --- | --- | --- |
| Staked paymaster | Alt-mempool | Admitted and mined |
| Same transaction | Canonical | Rejected: `StorageReadNonSender` |
| Unstaked probe that reads only the PoolManager | Alt-mempool | Rejected: `unstaked payer accessed 0x6bf9…9848 slot 0x2b3a…a4d5` |

The trace confirms the read. The paymaster frame makes a `STATICCALL` to the PoolManager and reads `0x2b3af0c4…a4d5`, which equals `keccak256(poolId, 6)`, this pool's `slot0`. The probe's rejection names the same address and slot, so stake is what makes that read admissible. This matches PR #6 STO-033 and ERC-8421 STORAGE-032.

Repro: `scripts/02-staked-paymaster-proof.ts` at commit `e93a1db` and `scripts/03-validation-gas.ts` at commit `ecf811f`. Both target the validation-only contract, so they are not in the current tree.

## The 100,000 cap, live

Sender frame limit 30,000, plus 2,800 signature cost, from a staked paymaster:

| Paymaster limit | Sum | Result |
| --- | --- | --- |
| 67,200 | 100,000 | [Admitted](https://explorer.altmempool.wtf/tx/0x8bb7522dc80d23614456e4355c1f8b38f936bec78889afb2bd17a5fe42e8c1b0) |
| 67,201 | 100,001 | Rejected: `exceeds MAX_VERIFY_GAS 100000` |
| 300,000 (allowed by ERC-8421's staked budget) | 332,800 | Rejected: `exceeds MAX_VERIFY_GAS 100000` |

## Declared and used validation gas

Minimum limits were found by binary search in simulation. The contract wallet's minimums were then [admitted and mined](https://explorer.altmempool.wtf/tx/0x36761a0bca5f09c9c5a9a2e7295f4ea56969f019712d2ebb7f4cb33e9a41f25a) with no margin, so the used gas equals the minimum limit.

| Sender | Sender frame | Paymaster frame | Signature | Total | Room under the cap |
| --- | --- | --- | --- | --- | --- |
| EOA (default code) | 100 | 29,175 | 2,800 | 32,075 | 67,925 |
| `OwnerWallet` contract | 7,067 | 29,175 | 2,800 | 39,042 | 60,958 |

These figures are for the validation-only contract, whose 29,175 gas covered the `slot0` read, the reference tick, two `TXPARAM` reads, the balance and allowance reads, and `APPROVE`. Binding the settle frame raises it, as measured [below](#end-to-end-settlement).

Rejected transactions did not cost the paymaster reputation: after these tests the explorer shows `opsSeen` 3, `opsIncluded` 3, status `ok`.

## End-to-end settlement

[Full transaction](https://explorer.altmempool.wtf/tx/0x4ffbaf0048f2af8ef5eb89785a5204ad21c566a07089257861f55bc966cd9f10), block 404108, 2 gwei. The sender held 0 wei before and after. The call sent 1 fgUSD to another account.

| Frame | Purpose | Execution gas | State gas |
| --- | --- | --- | --- |
| 0 | Sender `VERIFY` (EOA) | 100 | 0 |
| 1 | Paymaster `validate` | 42,616 | 0 |
| 2 | `settle`: pull tokens, swap for ETH | 116,110 | 0 |
| 3 | User call | 15,074 | 0 |
| 4 | `refund`: sell surplus ETH for tokens | 76,473 | 0 |

| | |
| --- | --- |
| Total gas | 270,088, including 19,715 outside the frames |
| Fee | 0.000540176 ETH, or 1,293,493 fgUSD units at the pool price |
| Maximum cost reserved | 0.00175143 ETH, 3.24x the fee |
| User paid | 1,378,742 fgUSD units, 1.066x the fee |
| Paymaster ETH | +0.000027054 ETH |

That transaction does not contain a permit. Because of row 18, the user's signed permit was submitted in a separate transaction first, which anyone can pay for. With a permit in the settle frame, `validate` used 48,625 gas in simulation, and the whole transaction executed successfully there, but the sidecar refuses it.

The 6.6% the user pays above the fee has two sources: the pool fee on both swaps, and the gap between the refund's 90,000 gas estimate and its 76,473 gas used. The refund frame cannot read its own gas used, so that gap goes to the paymaster.

The first transaction through a new pool costs more. [This one](https://explorer.altmempool.wtf/tx/0xe83bef8be298746845d3e69c871207e5aa2b493b3c5650fa6c5a50d0256d0bd2) initialised `feeGrowthGlobal1` in settlement, wrote a new balance slot in the user call and initialised `feeGrowthGlobal0` in the refund, at 97,920 state gas each. The minimum limits validation enforces cover the worst case in settlement: 200,000 execution and 300,000 state.

## Griefing paths

A failed frame does not stop later ones, so a settlement that fails after `APPROVE` would give the user free gas. Each of these was rejected at admission with the intended error:

| Attempt | Error |
| --- | --- |
| No settle frame after validation | `SettleNotBound` |
| Settle frame declares 199,999 execution gas | `SettleGasTooLow` |
| Settle frame declares 299,999 state gas | `SettleGasTooLow` |
| Settle frame in an atomic batch with the user's call | `SettleInAtomicBatch` |
| Cap below the quote | `CostAboveCap` |
| Cap above the balance | `InsufficientBalance` |
| No allowance and no permit | `InsufficientAllowance` |

These were mined, and in each the paymaster ended with more ETH than it started with:

| Scenario | Frame statuses | User paid (cap 8,000,000) | Paymaster |
| --- | --- | --- | --- |
| [User call reverts](https://explorer.altmempool.wtf/tx/0xb9cb5fb418cf29e5d56e481607d357f05a8a371077d1da9850380b8427878c78) | 1 1 1 0 1 | 1,313,984 | +0.000028904 ETH |
| [Refund runs out of gas](https://explorer.altmempool.wtf/tx/0xe6ce193255fec021eccf9cd1ead0f58ce2d91b2791d2cd4c23feb527fc01b8fd) | 1 1 1 1 0 | 3,942,086 | +0.00118434 ETH |
| [No refund frame](https://explorer.altmempool.wtf/tx/0x7077678d6cfd6e5ac1606939d7ec6f2746d9a1b3124f8c68ea739f5aee6aa940) | 1 1 1 1 | 3,804,241 | +0.001185986 ETH |

Repro: `scripts/04-end-to-end.ts`, `scripts/05-griefing-proofs.ts`.

## Limitations from the validation rules

- **Permits must not expire.** `TIMESTAMP` is banned in validation, so a deadline cannot be checked there, and a permit that passed validation and then expired would fail after the paymaster paid. Gas permits use `deadline = type(uint256).max`. The permit's value (equal to `maxTokenCost`) and its nonce bound it.
- **Tokens without EIP-2612 need Permit2 or an existing allowance.** The path through Permit2 is not built yet.
- **Native signatures cannot replace the permit check.** An EIP-8141 signature entry with `msg` set to the permit digest would get the digest verified with no precompile, but `SECP256K1` signature bytes cannot be read back (`SIGDATACOPY` halts for that scheme), so nothing ties that signature to the `r` and `s` the settle frame passes to the token.
