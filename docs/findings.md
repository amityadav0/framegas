# Findings: alt-mempool rules on the devnet

**Summary, 29 findings by category:** rule caps (flat 100,000 validation gas for staked entities too, rows 1–3, 27) · banned opcodes (`GAS` banned yet compiled calls pass, row 15; `TIMESTAMP` banned, so permits must not expire, see [Limitations](#limitations-from-the-validation-rules)) · missing precompiles (all rejected in validation, so no `ecrecover`, row 18) · gateway relay and liveness (chain halt, admitted transactions relayed an hour late or dropped, dropped-then-mined, rows 24, 25, 28, 29) · explorer memory (history lost on restart, rows 26, 29) · rule-text drift and devnet docs (rows 4–14, 16, 17, 19–23).

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
| 18 | Precompiles in validation | Core precompiles allowed (OP-062) | Core precompiles allowed (CALLING-040) | **All rejected.** `skandha_config` reports `precompiles: []`, so `ecrecover` in a validation frame fails with `payer accesses un-deployed contract address 0x…0001 with opcode STATICCALL`. ethrex's own simulation of the same transaction executes successfully. This is a config value, not a rule | Live | `scripts/04-end-to-end.ts --permit-in-frame` |
| 19 | `FRAMEPARAM` ids 0x09 to 0x0B | Not in the pinned EIP-8141 table, which stops at 0x08 | Not specified | The devnet returns state gas limit, gas used and state gas used. Gas used matches the receipt for finished frames. Reading the current frame halts | Live | `scripts/06-frame-probe.ts` |
| 20 | Transient storage across frames | Treated like persistent storage (OP-070) | Treated like persistent storage | Does not survive from one frame to the next: a value written in one `SENDER` frame reads as 0 in the following one. Settlement therefore passes nothing to the refund this way | Live | `scripts/06-frame-probe.ts` |
| 21 | State gas per new storage slot | Not specified | Not specified | 97,920 state gas per zero-to-nonzero slot, on top of execution gas, and it counts toward the fee. Execution gas cannot substitute for it: a settle frame short of state gas fails even with 1,500,000 execution gas | Live | Receipts of the first end-to-end transaction below |
| 22 | Frame failure and later frames | Later frames still run (EIP-8141) | Later frames still run | Confirmed: in simulation a failed settle frame was followed by a successful user call. Validation has to rule out any settlement failure the user controls | Live | `ethrex_simulateFrameTransaction` |
| 23 | Admitting a transaction whose settlement will fail | Rules cover the validation prefix only | Rules cover the validation prefix only | Admitted. The admission record even lists the frame statuses it simulated, such as `success, success, reverted, success`. The mempool is no backstop for failures after the prefix | Live | `scripts/07-thin-pool.ts` |
| 24 | Inclusion of admitted transactions | Not specified | Not specified | Some admitted transactions wait minutes, and some never leave `New`. Two of ours have been pending for over 10 hours, alongside 12 from other teams, while later ones mined. Another of ours took about 10 minutes. The SDK waits up to 10 minutes and then reports the hash as admitted but not mined | Live | `0x4045eaef…abe2`, `0x66be840e…d750`, `0xd9bcfa17…9b46` |
| 25 | Block production | Not specified | Not specified | **Halted.** The last block is 408262, timestamped 2026-11-06 04:28:46 IST (Unix 1793919526). It had not advanced by 08:55 IST, more than four hours later. Before that, blocks came about every 6 seconds: block 402591 at 19:01 and 405103 at 23:12 on 2026-11-05. By 12:57 IST on 2026-11-06 the chain had been reset: new genesis `0x2ad3f67b…`, block 584, no deployed contracts or balances left | Live | `eth_getBlockByNumber("latest")` |
| 26 | Explorer history | In memory only, cleared on restart (sidecar docs) | Not specified | Confirmed: the gateway restarted during the halt (`bootId` `bce7267923761e0d` became `342e41cc3af0893a`), and every earlier admission report is gone, though receipts remain. The evidence saved before then is in `docs/evidence/` | Live | `skandha_explorer_info` |
| 27 | Validation gas after the reset | Not specified | Not specified | The same `FrameGasPaymaster` source uses more validation gas on the reset chain: 48,594 normal and 52,986 bootstrap on 2026-11-06 (paymaster `0x7503…9996`, txs `0x0cd83f6a…4051`, `0x715ae84c…54a9`), against 45,429 and 49,835 on 2026-11-05. The SDK's 49,000 normal limit then had 406 gas to spare. The node reports no version change. The SDK now declares 55,000 and 60,000 | Live | `scripts/10-quota-live.ts`, `docs/evidence/quota-live.json` |
| 28 | Admitted, then relayed late or dropped | Not specified | Not specified | On 2026-11-06 from 14:03 IST, four FrameGas transactions in a row passed admission 24/24 on the gateway and stayed `New` while the explorer reported the miner, the only node that builds blocks, "has not seen" them; the four sent at 13:59–14:01 through the same paymaster reached it over P2P within seconds. The two v4 swaps (`0xb795dfdf…437b`, the demo's own Live send, and `0x79e4d690…a99f`) were then mined together in block 1977 at 15:16:36, 72 and 61 minutes after admission, with every frame succeeding. The supply (`0xbd6fdafb…8d3f`) and the plain transfer (`0x50b4fde5…e4bd`) were dropped from the gateway without ever reaching the miner. The miner's reputation for the paymaster stayed OK. The miner rejects `eth_sendFrameTransaction` ("Method not found"), so the gateway is the only way in. This is the mechanism behind row 24 | Live | the four hashes; `docs/evidence/demo-live-swap-0xb795….json` |
| 29 | Dropped, then included | Not specified | Not specified | Bootstrap transaction `0x45fcd889…1dd3` was marked "Dropped, Cancelled: revalidation failed as of block 1212: Nonce mismatch: expected 1, got 0" at 14:00:16.018 and "Included in a block" at 14:00:16.768 (block 1213, status 1). The explorer keeps the revert reason on the page of a mined transaction. A client that trusts the drop event would resend a transaction that is already on chain | Live | `docs/evidence/sdk-live-bootstrap-0x45fc….json`, `-frames.jpg` |

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

## Three ways to get the allowance

| Mode | Frames | Status on the devnet |
| --- | --- | --- |
| Normal | `validate`, `settle`, user calls, `refund` | Live |
| Bootstrap, first transaction per user and token | `validate`, `approve`, `settle`, user calls, `refund` | Live |
| Permit in the settle frame | as normal, with a signature in `settle` | Refused because of row 18. It executes in simulation |

Bootstrap needs no relayer, no precompile and no ETH. Validation requires the frame to be exactly `PAY_TOKEN.approve(paymaster, n)` with `n` at least the cap, 68 bytes of data, no value, no atomic flag and enough gas, followed directly by the settle frame. If the permit path becomes available it removes the separate frame, and bootstrap stays as the path for tokens without EIP-2612.

## End-to-end transactions

The same user, holding zero ETH throughout, at 2 gwei:

| Frame | [Bootstrap](https://explorer.altmempool.wtf/tx/0x08a9d9386e14a428a3ba77a01719eec9be6f1fe7731608efa9d7140f974b9bf7) gas | [Normal](https://explorer.altmempool.wtf/tx/0xbd24f1a8c1aaa9fe667e5640de154c922ef18e55346808915b14fd0feb3b88e7) gas |
| --- | --- | --- |
| Sender `VERIFY` | 100 | 100 |
| Paymaster `validate` | 49,835 | 45,429 |
| `approve` | 14,472, plus 97,920 state gas | none |
| `settle` | 106,254 | 116,190 |
| User call | 15,074 | 15,074 |
| `refund` | 78,454 | 73,946 |
| Total | 382,895 | 270,466 |

| | Bootstrap | Normal |
| --- | --- | --- |
| Fee | 0.000766 ETH | 0.000541 ETH |
| Reserved, as a multiple of the fee | 1.192x | 1.172x |
| User paid, as a multiple of the fee | 1.035x | 1.044x |
| User paid | 1.938 fgUSD | 1.383 fgUSD |
| Tokens the user must hold | 2.344 fgUSD | 1.629 fgUSD |
| Paymaster ETH | +0.000024 | +0.000022 |

**The first transaction costs about 0.56 fgUSD more**, mostly the new allowance slot's state gas, paid in tokens like everything else.

These multiples assume the price paid equals `maxFeePerGas`. A client that sets a higher maximum reserves more, and the refund returns it.

## What validation requires of a transaction

Validation sets floors, so a user cannot starve a frame. A client can always declare more.

| Frame | Execution gas | State gas |
| --- | --- | --- |
| `validate` | 46,000 normal, 51,000 bootstrap (not enforced, but it fails admission below this) | 0 |
| `settle` | 150,000 | 0, or 293,760 with a permit |
| `approve` | 30,000 | 97,920 |
| `refund` | 63,000 + 5,500 per earlier frame | 0 |

The refund's gas limit is also its estimate of its own cost, because `FRAMEPARAM` halts on the current frame. Reading each earlier frame's accounting costs about 5,300 gas, which is why it scales. A frame needs some room above what it uses, because each nested call keeps back 1/64 of the gas: a refund using about 79,400 gas failed at an 83,500 limit.

## Griefing paths

A failed frame does not stop later ones, so a settlement that fails after `APPROVE` gives the user free gas. Each attempt below was rejected at admission, and the script requires the exact contract error:

| Attempt | Error |
| --- | --- |
| No settle frame after validation | `SettleNotBound` |
| Settle frame declares too little execution gas | `SettleGasTooLow` |
| Settle frame in an atomic batch with the user's call | `SettleInAtomicBatch` |
| Settle frame sends ETH a zero-ETH user lacks | `SettleMalformed` |
| Settle calldata too short, which would pass validation and revert in the decoder | `SettleMalformed` |
| Cap below the quote | `CostAboveCap` |
| Cap above the balance | `InsufficientBalance` |
| Maximum cost above the per-transaction limit | `MaxCostTooHigh` |
| No allowance and no approve frame | `InsufficientAllowance` |
| Bootstrap: another function, another spender, amount below the cap, trailing data, value, or atomic flag | `ApproveNotBound` |
| Bootstrap: too little execution or state gas | `ApproveGasTooLow` |

Dirty upper bits in the spender word, and a permit alongside a bootstrap frame, are covered by unit tests.

These were mined, and the paymaster ended ahead in each:

| Scenario | Frame statuses | User paid (cap 5 fgUSD) | Paymaster |
| --- | --- | --- | --- |
| [User call reverts](https://explorer.altmempool.wtf/tx/0x2e5c80a9f56126cbd2ff89f3b527cda6631c63b77f2950d287f8ad755fd978f3) | 1 1 1 0 1 | 1.316 fgUSD | +0.000022 ETH |
| [Refund runs out of gas](https://explorer.altmempool.wtf/tx/0xe97e271cb40c1f70f86fd7ef57dff92d9f8642be9d494db357ad0a438e98fba4) | 1 1 1 1 0 | 1.529 fgUSD | +0.000169 ETH |
| [No refund frame](https://explorer.altmempool.wtf/tx/0x1c9ca78b3072dd3d14cc053f7a577817bd1802d323221d8d45d56a376f4ea9a4) | 1 1 1 1 | 1.380 fgUSD | +0.000169 ETH |

Repro: `scripts/04-end-to-end.ts`, `scripts/05-griefing-proofs.ts`.

## Worst-case loss per transaction

**The paymaster can lose at most `MAX_TX_COST_WEI` per transaction, set to 0.002 ETH (about 4.77 fgUSD) on the devnet.** Validation rejects anything reserving more. A settled transaction costs the paymaster nothing. Loss happens only when settlement fails after `APPROVE`: then the user pays nothing, and the paymaster pays the fee.

The whole-transaction fuzz ran 10,000 runs, with up to four arbitrary pool moves, gas burned in the user's frame, a drained balance and a varying gas price. The user never paid above the cap, a settled transaction never cost the paymaster ETH, and a failed settlement cost exactly the fee. It uses mocked frame opcodes and does not model state gas, which the live runs cover.

Settlement can fail in these ways:

| Cause | What it takes | Measured |
| --- | --- | --- |
| Price moved past the buffer | The user signs a cap equal to the quote, then the price moves 480 ticks (about 4.9%) in the same block, before the transaction | Fuzz model: settlement first fails at 480 ticks |
| Balance drained after admission | Another transaction moves the tokens first | Fuzz model |
| [First-ever tick crossing at the floor](https://explorer.altmempool.wtf/tx/0xf07043e05acd0805b2af5dd2ed089ed61b7ea7f35d1e12732feca5dbee4b2b72) | Settlement needs new slots and declared none | Live: **user call landed free, paymaster lost 0.000466 ETH** (about 1.11 fgUSD) |
| [Pool too thin to supply the reserve](https://explorer.altmempool.wtf/tx/0x458ed9b60820efb820ebcc0bd9d1cf8aa8a2675c23e44fbe477b3195707b7524) | The paymaster was deployed on a thin pool | Live: user call landed free, paymaster lost 0.000466 ETH |

### Griefing economics

A staked paymaster that reads a pool during validation can be griefed by moving the pool. This applies to any alt-mempool paymaster priced from an AMM, and the numbers suggest a design rule: **an entity's validation should require enough active liquidity that moving the price costs more than the gas it can destroy.**

| | Measured at 5e13 active liquidity |
| --- | --- |
| Capital to move the price 480 ticks | about 59 fgUSD |
| Fees to move it there and back (attacker's cost) | about 0.35 fgUSD |
| Paymaster's loss, measured live | about 1.11 fgUSD (0.000466 ETH) |
| Paymaster's loss at the per-transaction limit | about 4.77 fgUSD (0.002 ETH) |
| Loss per unit of attacker cost | 3.2x, up to 13.6x at the limit |

The attacker's cost grows in proportion to active liquidity, while the loss does not:

| Active liquidity | Depth in this range | Attacker cost | Against 1.11 fgUSD loss | Against 4.77 fgUSD limit |
| --- | --- | --- | --- | --- |
| 5e13 | about 0.3 ETH | 0.35 fgUSD | Profitable to grief | Profitable to grief |
| 1.6e14 | about 0.9 ETH | 1.11 fgUSD | Break-even | Profitable to grief |
| 7e14 (14x) | about 4 ETH | 4.9 fgUSD | Unprofitable | Unprofitable |

Only the first row is measured. The others scale it. The attacker also needs both transactions ordered in one block, which needs a builder's cooperation and was not tested, so these figures favour the attacker.

`FrameGasPaymaster` enforces this with `MIN_LIQUIDITY`, set per deployment. **The devnet uses 1e12, a demo threshold. The production floor is about 7e14, roughly 4 ETH of depth.** Validation checks liquidity at admission only, so someone could remove it afterwards, but that is their own capital and hits the same economics. The check adds about 2,500 gas to validation.

### Gas by ticks crossed

Each tick crossed adds about 24,500 gas to settlement, and about 24,800 to a refund that crosses back.

| Ticks crossed | Settle gas in Forge | Refund gas in Forge |
| --- | --- | --- |
| 0 | 94,598 | |
| 1 | 110,243 | 162,192 |
| 2 | 134,658 | 187,036 |
| 5 | 208,059 | 261,604 |
| 10 | 306,039 | 361,012 |
| 20 | 526,190 | 584,384 |

Absolute figures here use mocks, which are heavier than the real opcodes: a live refund uses about 74,000 gas. The increments are what carry over. Live, settlement used 116,190 gas with no crossing, about 149,000 with one, and 189,837 with three.

A first-ever crossing also writes new slots: 97,920 state gas was not enough, and declaring 195,840 [succeeded](https://explorer.altmempool.wtf/tx/0x01a97bc25fd8dbc9109ee27640815e03588ec6aa14f00d3b66b1a04a2be76622). A refund that crosses a tick exceeds its estimate and reverts, so the user forfeits that refund and the paymaster is unaffected.

A swap this small moves a deep pool by a few ticks, against a tick spacing of 60, so it can cross at most one there. Crossing several needs a thin pool.

Repro: `contracts/test/FrameGasPaymaster.fuzz.t.sol`, `scripts/07-thin-pool.ts`.

## Limitations from the validation rules

- **Permits must not expire.** `TIMESTAMP` is banned in validation, so a deadline cannot be checked there, and a permit that passed validation and then expired would fail after the paymaster paid. Gas permits use `deadline = type(uint256).max`. The permit's value (equal to `maxTokenCost`) and its nonce bound it.
- **Tokens without EIP-2612 use bootstrap mode.** Permit2 is the other path for them, and it is not built.
- **Native signatures cannot replace the permit check.** An EIP-8141 signature entry with `msg` set to the permit digest would get the digest verified with no precompile, but `SECP256K1` signature bytes cannot be read back (`SIGDATACOPY` halts for that scheme), so nothing ties that signature to the `r` and `s` the settle frame passes to the token.
