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
| 1 | Validation gas budget | `MAX_VERIFY_GAS` applies to the whole prefix (FRA-040) | Per entity: 100,000 unstaked, 1,000,000 staked (BUDGET-010) | Flat 100,000 across the prefix, including signature cost (2,800 for SECP256K1). No staked budget in the code, although `devnet-readme.md` describes one | Source | `validationPrefix.ts`, `validateStructuralRules` |
| 2 | The budget counts declared limits | Sum of `limits.execution` | Sum of `limits.execution` per entity | Declared limits are summed, not gas used. Step 8's sender frame declared 70,000 and used 15,805 | Live and source | `yarn step_11_debug <tx>`, `frames[0].limits`, `frameReceipts[0].gasUsed` |
| 3 | State gas cap in validation | `MAX_VERIFY_STATE_GAS` 500,000 | No such constant | 500,000 enforced | Source | `validationPrefix.ts` |
| 4 | Rule identifiers | `OP-*`, `STO-*`, `COD-*`, `GREP-*`, `FRA-*` | `OPCODES-*`, `STORAGE-*`, `REPUTATION-*`, `PREFIX-*` | PR #6 names appear in admission reports (`OP-011`, `OP-061`, `COD-010`) | Live | `yarn step_11_debug <tx>` |
| 5 | Who gets the wider storage access | "paymaster or factory" (STO-031 to STO-033) | Any staked entity (STORAGE-031 to STORAGE-033) | Any staked role. Step 8's entity is a self-paying sender, reported in the role `payer` | Live | Workshop step 8 |
| 6 | Minimum unstake delay | 86,400 s | 86,400 s (STAKING-010) | `skandha_config` reports `minUnstakeDelay: 0`. `minStake` is 0.01 ETH | Live | `skandha_config` |
| 7 | `BALANCE` / `SELFBALANCE` threshold | Staked entity (OP-080) | Staked entity (OPCODES-010) | Requires `stake > minStake`, strictly, while every other staked carve-out accepts `>=` | Source | `frameTx.ts`, `BANNED_OPCODE` check |
| 8 | Same-sender pending limit | 4, marked ERC-4337 only | 64 for unstaked senders, none for active staked senders | `MAX_MEMPOOL_USEROPS_PER_SENDER = 4` | Source | `MempoolService/constants.ts` |
| 9 | `pre_verify` frames (a `DEFAULT` frame before the approving frame, able to write) | Not defined | Defined (PREFIX-110, PREFIX-120) | Recognised by the sidecar source, so the source is ahead of the pin. Not exercised | Source | `validationPrefix.ts` |
| 10 | Banned-entity rejection text | `BANNED` entities are excluded | `BANNED` entities are excluded (REPUTATION-010) | Excluded, but the error reads `unstaked payer accessed …`, with no mention of the ban. Only the explorer's reputation view shows the cause | Live | Workshop steps 9 and 10 |

## Devnet state versus its documentation

| # | Observation | Documented | Actual (devnet) | Evidence | Repro |
| --- | --- | --- | --- | --- | --- |
| 11 | Uniswap v4 stack | PoolManager, StateView, Permit2, WETH9 and Universal Router are predeployed (`deployments/devnet.md`) | Code present at all five addresses | Live | `cast code <addr>` |
| 12 | Example WETH9/USDC pool | "One is live today", pool ID `0x784b…0648` | Not initialised: `getSlot0` and `getLiquidity` return 0 at block 402640. The same file says the 2026-10-08 reset removed this pool | Live | `cast call <StateView> "getSlot0(bytes32)(uint160,int24,uint24,uint24)" <poolId>` |
| 13 | Workshop docs | README links to `docs/findings.md`, `docs/decision-guide.md` and `docs/steps/` | Not in the repository since commit `250b03f`. Still readable from history | Live | `git show 250b03f^:docs/findings.md` |

## Open questions

- **Row 1 needs a live test.** A prefix declaring more than 100,000 gas from a staked entity would settle whether the deployed build matches the source.
- **A staked contract paymaster reading PoolManager storage has not been exercised.** PR #6 STO-033 and ERC-8421 STORAGE-032 both allow it, and step 8 shows the same check passing for a staked self-paying sender. The paymaster transaction shape is still untested.
