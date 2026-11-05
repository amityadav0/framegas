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
| 1 | Validation gas budget | `MAX_VERIFY_GAS` applies to the whole prefix (FRA-040) | Per entity: 100,000 unstaked, 1,000,000 staked (BUDGET-010) | Flat 100,000 across the prefix, including signature cost (2,800 for SECP256K1), for staked entities too. `devnet-readme.md` describes a staked budget that the node does not apply. See [the cap test](#the-100000-cap-live) | Live and source | `scripts/03-validation-gas.ts` |
| 2 | The budget counts declared limits | Sum of `limits.execution` | Sum of `limits.execution` per entity | Declared limits are summed, not gas used. Step 8's sender frame declared 70,000 and used 15,805 | Live and source | `yarn step_11_debug <tx>`, `frames[0].limits`, `frameReceipts[0].gasUsed` |
| 3 | State gas cap in validation | `MAX_VERIFY_STATE_GAS` 500,000 | No such constant | 500,000 enforced | Source | `validationPrefix.ts` |
| 4 | Rule identifiers | `OP-*`, `STO-*`, `COD-*`, `GREP-*`, `FRA-*` | `OPCODES-*`, `STORAGE-*`, `REPUTATION-*`, `PREFIX-*` | PR #6 names appear in admission reports (`OP-011`, `OP-061`, `COD-010`) | Live | `yarn step_11_debug <tx>` |
| 5 | Who gets the wider storage access | "paymaster or factory" (STO-031 to STO-033) | Any staked entity (STORAGE-031 to STORAGE-033) | Any staked role. Step 8's entity is a self-paying sender, reported in the role `payer` | Live | Workshop step 8 |
| 6 | Minimum unstake delay | 86,400 s | 86,400 s (STAKING-010) | `skandha_config` reports `minUnstakeDelay: 0`. `minStake` is 0.01 ETH | Live | `skandha_config` |
| 7 | `BALANCE` / `SELFBALANCE` threshold | Staked entity (OP-080) | Staked entity (OPCODES-010) | Requires `stake > minStake`, strictly, while every other staked carve-out accepts `>=` | Source | `frameTx.ts`, `BANNED_OPCODE` check |
| 8 | Same-sender pending limit | 4, marked ERC-4337 only | 64 for unstaked senders, none for active staked senders | `MAX_MEMPOOL_USEROPS_PER_SENDER = 4` | Source | `MempoolService/constants.ts` |
| 9 | `pre_verify` frames (a `DEFAULT` frame before the approving frame, able to write) | Not defined | Defined (PREFIX-110, PREFIX-120) | Recognised by the sidecar source, so the source is ahead of the pin. Not exercised | Source | `validationPrefix.ts` |
| 10 | Banned-entity rejection text | `BANNED` entities are excluded | `BANNED` entities are excluded (REPUTATION-010) | Excluded, but the error reads `unstaked payer accessed …`, with no mention of the ban. Only the explorer's reputation view shows the cause | Live | Workshop steps 9 and 10 |

| 14 | Unstaked rejection names the first slot it reaches | Not specified | An unstaked paymaster with its own storage is rejected with `unstaked payer accessed payer slot 0x0`, its own slot, before the PoolManager read is reported. A probe with no storage of its own is rejected naming the PoolManager | Live | `scripts/02-staked-paymaster-proof.ts`, `scripts/03-validation-gas.ts` |
| 15 | `GAS` opcode | Allowed only directly before a `*CALL` (OP-012) | Bound by EIP-8141's banned opcodes | The sidecar's banned list contains `GAS`, yet Solidity's external calls pass. The trace's `usedOpcodes` omits opcode 90 for these calls. Bare `gasleft()` was not tested | Live | `ethrex_simulateFrameTransaction` with `trace: true` |

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

Repro: `scripts/02-staked-paymaster-proof.ts`, `scripts/03-validation-gas.ts`.

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

The paymaster's 29,175 gas covers the `slot0` read, the reference tick, two `TXPARAM` reads, the balance and allowance reads, and `APPROVE`. These figures are for the validation-only contract, and the checks added for settlement will raise them.

Rejected transactions did not cost the paymaster reputation: after these tests the explorer shows `opsSeen` 3, `opsIncluded` 3, status `ok`.
