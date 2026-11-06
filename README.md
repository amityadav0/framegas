# FrameGas

**Pay Ethereum gas in an ERC-20, from a wallet holding zero ETH, in one signed transaction.**

- FrameGas is a paymaster contract for [EIP-8141](https://eips.ethereum.org/EIPS/eip-8141) frame transactions. Its validation frame prices gas from a Uniswap v4 pool, and its execution frames buy the gas on that pool with the user's tokens.
- Transactions enter through the [ERC-8421 alternative mempool](https://docs.altmempool.wtf/), which admits validation that reads the PoolManager's storage once the paymaster is staked. The canonical mempool refuses the same bytes.
- No relayer, no sponsor treasury, no off-chain price signer, no owner. Built at ETHGlobal Mumbai, 5–7 Nov 2026, on the alt-mempool devnet (chain 1337). EIP-8141 is scheduled for the Hegotá fork and is not on mainnet.

## Quickstart

```sh
pnpm install
scripts/redeploy.sh --fresh              # token, pool, liquidity, staked paymaster, demo contracts, smoke test
pnpm --filter @framegas/demo dev         # http://localhost:3000, replay mode needs no chain
```

`redeploy.sh` generates a deployer key into the git-ignored `.env` and funds it from the devnet faucet. It locks about 0.085 ETH (0.33 ETH with `--seed-eth 0.3`) and writes [`deployments/devnet.json`](./deployments/devnet.json).

One SDK call, from a key that holds the token and no ETH:

```ts
import { createFrameGas } from "@framegas/sdk";
import deployment from "./deployments/devnet.json";

const framegas = createFrameGas({ privateKey, paymasters: deployment.paymasters });
const { requiredTokens } = await framegas.quote({ payToken: deployment.fgUSD, calls });
const r = await framegas.send({ payToken: deployment.fgUSD, maxTokenCost: (requiredTokens * 102n) / 100n, calls });
// r.hash, r.explorerUrl, r.tokensPaid, r.tokensRefunded, r.frames
```

Tests: `forge test --root contracts` (77, including a whole-transaction fuzz suite), `pnpm --filter @framegas/sdk test`, `pnpm --filter @framegas/demo test`.

## How it works

```text
 one signed frame transaction (type 0x06), sender holds 0 ETH
 ┌────────────┬──────────────────────┬─────────────────────┬──────────────────────┬──────────────┬─────────────────┐
 │ 0 VERIFY   │ 1 VERIFY             │ 2 SENDER            │ 3 SENDER             │ 4 SENDER     │ 5 SENDER        │
 │ sender     │ paymaster.validate() │ token.approve(pm,n) │ paymaster.settle(    │ user call(s) │ paymaster       │
 │ signature  │                      │ bootstrap only      │   maxTokenCost,v,r,s)│              │ .refund(settle) │
 └────────────┴──────────────────────┴─────────────────────┴──────────────────────┴──────────────┴─────────────────┘
   validation prefix (mempool rules, ≤100,000 gas)    │  execution frames
                                                      │
 validate():  getSlot0 + getLiquidity on the v4 pool  │  settle():  PoolManager.unlock → exact-output swap
              tick within maxDeviation of refTick     │             token → ETH equal to APPROVE's max cost,
              quote(max cost) ≤ maxTokenCost          │             sync / transferFrom / settle / take
              balance and allowance ≥ maxTokenCost    │  refund():  exact-input swap of the unused ETH
              frames 2–3 bound exactly                │             back to the user's token
              APPROVE(PAYMENT): paymaster pays max    │  after last frame: chain returns unused max cost
```

`APPROVE` charges the paymaster the transaction's maximum cost before any execution frame runs. `settle` buys back exactly that much ETH from the pool with the user's tokens, never more than `maxTokenCost`. The chain returns the unused part after the last frame, so `refund` sells an estimate of it back to the user. Later frames run even if an earlier one fails, so `validate` rejects every settlement failure the user can cause alone.

| Mode | When | Frames | Difference |
| --- | --- | --- | --- |
| Bootstrap | First transaction for a user and token: no allowance | verify, validate, approve, settle, call(s), refund | `validate` requires frame 2 to be exactly `PAY_TOKEN.approve(paymaster, n)`, `n ≥ maxTokenCost`, followed by settle. The new allowance slot costs 97,920 state gas, about 0.56 fgUSD |
| Normal | Allowance already covers the cap | verify, validate, settle, call(s), refund | `validate` reads the allowance instead |

A permit in the settle frame is a third mode. The contract implements it, but the devnet rejects `ecrecover` in validation ([finding 18](./docs/findings.md#rule-drift)).

## Reviewer pointers

All in [`contracts/src/FrameGasPaymaster.sol`](./contracts/src/FrameGasPaymaster.sol).

| What | Where |
| --- | --- |
| `getSlot0` read in validation | [L254](./contracts/src/FrameGasPaymaster.sol#L254), quote from `sqrtPriceX96` [L260-261](./contracts/src/FrameGasPaymaster.sol#L260-L261), [L512-516](./contracts/src/FrameGasPaymaster.sol#L512-L516) |
| Settle-frame binding check: target, `SENDER` mode, selector, not atomic, no value, 132-byte calldata, gas floors | call [L247-248](./contracts/src/FrameGasPaymaster.sol#L247-L248), check [L365-381](./contracts/src/FrameGasPaymaster.sol#L365-L381) |
| Bootstrap approve-calldata check: `approve(this, n ≥ cap)`, 68 bytes, gas and state gas floors | detection [L244-245](./contracts/src/FrameGasPaymaster.sol#L244-L245), call [L267-269](./contracts/src/FrameGasPaymaster.sol#L267-L269), check [L385-400](./contracts/src/FrameGasPaymaster.sol#L385-L400) |
| Min-liquidity check (`getLiquidity` against `MIN_LIQUIDITY`) | [L257-258](./contracts/src/FrameGasPaymaster.sol#L257-L258) |
| Swap / settle / take | `unlock` [L293](./contracts/src/FrameGasPaymaster.sol#L293), callback [L339-346](./contracts/src/FrameGasPaymaster.sol#L339-L346), exact-output swap [L418-430](./contracts/src/FrameGasPaymaster.sol#L418-L430), `sync`, `transferFrom`, `settle`, `take` [L432-436](./contracts/src/FrameGasPaymaster.sol#L432-L436) |
| Refund frame: last frame only, re-derives settlement from frame statuses, surplus from `FRAMEPARAM` | [L301-336](./contracts/src/FrameGasPaymaster.sol#L301-L336), surplus [L461-478](./contracts/src/FrameGasPaymaster.sol#L461-L478), exact-input swap [L441-457](./contracts/src/FrameGasPaymaster.sol#L441-L457) |
| Reference tick + `syncReference` | state [L138-140](./contracts/src/FrameGasPaymaster.sol#L138-L140), check [L255-256](./contracts/src/FrameGasPaymaster.sol#L255-L256), advanced in settle [L294](./contracts/src/FrameGasPaymaster.sol#L294), `syncReference` [L352-355](./contracts/src/FrameGasPaymaster.sol#L352-L355), `_advanceReference` [L481-491](./contracts/src/FrameGasPaymaster.sol#L481-L491) |
| `MAX_TX_COST_WEI` | declared [L128](./contracts/src/FrameGasPaymaster.sol#L128), check [L250-251](./contracts/src/FrameGasPaymaster.sol#L250-L251) |
| Stake from the constructor, no owner | [L232](./contracts/src/FrameGasPaymaster.sol#L232) |

## Gas per frame

Measured on the devnet on 2026-11-05 at 2 gwei, one user's first and second transaction, each with one `transfer` call. Limit is what the signed transaction declared.

**Bootstrap** — [`0x08a9…9bf7`](https://explorer.altmempool.wtf/tx/0x08a9d9386e14a428a3ba77a01719eec9be6f1fe7731608efa9d7140f974b9bf7), block 405098

| # | Frame | Mode | Gas used / limit | State gas used / limit |
| --- | --- | --- | --- | --- |
| 0 | sender signature | VERIFY | 100 / 200 | 0 |
| 1 | `validate` | VERIFY | 49,835 / 51,000 | 0 |
| 2 | `approve` | SENDER | 14,472 / 30,000 | 97,920 / 97,920 |
| 3 | `settle` | SENDER | 106,254 / 150,000 | 0 |
| 4 | user call | SENDER | 15,074 / 16,000 | 0 |
| 5 | `refund` | SENDER | 78,454 / 90,500 | 0 |
| | Total | | 382,895 | fee 0.000766 ETH, user paid 1.938 fgUSD |

**Normal** — [`0xbd24…88e7`](https://explorer.altmempool.wtf/tx/0xbd24f1a8c1aaa9fe667e5640de154c922ef18e55346808915b14fd0feb3b88e7), block 405103

| # | Frame | Mode | Gas used / limit | State gas used / limit |
| --- | --- | --- | --- | --- |
| 0 | sender signature | VERIFY | 100 / 200 | 0 |
| 1 | `validate` | VERIFY | 45,429 / 46,000 | 0 |
| 2 | `settle` | SENDER | 116,190 / 150,000 | 0 |
| 3 | user call | SENDER | 15,074 / 16,000 | 0 |
| 4 | `refund` | SENDER | 73,946 / 85,000 | 0 |
| | Total | | 270,466 | fee 0.000541 ETH, user paid 1.383 fgUSD |

The validation prefix declares 51,200 (bootstrap) and 46,200 (normal) of the devnet's 100,000 cap, plus 2,800 for the signature. User paid 1.035x (bootstrap) and 1.044x (normal) of the fee; the paymaster ended +0.000024 and +0.000022 ETH. Floors and per-tick costs: [`docs/findings.md`](./docs/findings.md#what-validation-requires-of-a-transaction).

## Evidence

The devnet was reset on 2026-11-06, and its explorer keeps history in memory, so explorer links from 2026-11-05 no longer resolve. The JSON files in [`docs/evidence/`](./docs/evidence/README.md) hold the admission reports and receipts.

| What | Transaction | Files |
| --- | --- | --- |
| Bootstrap, 24/24 checks | `0x08a9…9bf7`, block 405098 | `docs/evidence/bootstrap-0x08a9…{-summary.jpg,-frames.jpg,.json}` |
| Normal, 24/24 checks | `0xbd24…88e7`, block 405103 | `docs/evidence/normal-0xbd24…{-summary.jpg,-frames.jpg,.json}` |
| Same bytes to both mempools, bootstrap | `0x2b73…a331`, block 405263 | `docs/evidence/mempool-comparison-bootstrap-0x2b73…{.json,-summary.jpg}` |
| Same bytes to both mempools, normal | `0x6e76…4ff7`, block 405268 | `docs/evidence/mempool-comparison-normal-0x6e76…{.json,-summary.jpg}` |
| Staked paymaster reading PoolManager storage, 24/24 checks | `0xcafc…06af`, block 402821 | [`docs/findings.md`](./docs/findings.md#a-staked-contract-paymaster-reading-poolmanager-storage) |
| Current chain, redeploy smoke test (bootstrap, all frames succeeded, 3.08 fgUSD) | [`0x4c45…7e4d`](https://explorer.altmempool.wtf/tx/0x4c45be67d7ad7682c1cac67a0f6d615cfb6779137258f048c6171a9fdf687e4d) | — |
| Demo replay screenshots, both modes, light and dark | | [`docs/evidence/demo/`](./docs/evidence/demo/) |

**Canonical rejection.** `eth_sendRawTransaction` with the signed bytes of `0x6e76…4ff7` returned:

```text
Invalid params: Frame transaction validation-prefix simulation failed: StorageReadNonSender
```

`eth_sendFrameTransaction` with the same bytes returned `admitted: true`, and the transaction was mined in block 405268. The `signedRawTx` field in each comparison file holds the bytes.

## Findings index

Full table, rule references and repro scripts: [`docs/findings.md`](./docs/findings.md).

| # | Finding |
| --- | --- |
| 1 | Validation gas cap is a flat 100,000 across the whole prefix, staked entities included; ERC-8421 gives staked entities 1,000,000. 100,000 admitted, 100,001 rejected |
| 2 | The cap counts declared limits, not gas used |
| 3 | 500,000 state gas cap in validation, from the pinned draft only |
| 4 | Admission reports use PR #6 rule names (`OP-*`, `COD-*`), not ERC-8421's |
| 5 | Wider storage access goes to any staked role, not only paymasters and factories |
| 6 | `minUnstakeDelay` is 0 on the devnet; both texts say 86,400 s |
| 7 | `BALANCE` needs `stake > minStake` strictly; other carve-outs accept `>=` |
| 8 | Same-sender pending limit is 4 |
| 9 | `pre_verify` frames are recognised in the sidecar source, ahead of the pin |
| 10 | A banned entity's rejection text does not mention the ban |
| 11 | The v4 predeploys are present at all five documented addresses |
| 12 | The documented WETH9/USDC example pool is not initialised |
| 13 | Workshop docs it links to are missing from the repository |
| 14 | An unstaked paymaster's rejection names its own slot before the PoolManager read |
| 15 | `GAS` is on the banned list, yet Solidity external calls pass |
| 16 | `ethrex_simulateFrameTransaction` returns different fields from its docs |
| 17 | `TXPARAM` 0x06 (max cost) is in EIP-8141 and implemented |
| 18 | All precompiles are rejected in validation (`precompiles: []`), so `ecrecover` and the permit path fail |
| 19 | `FRAMEPARAM` 0x09–0x0B return state gas limit, gas used, state gas used; reading the current frame halts |
| 20 | Transient storage does not survive between frames |
| 21 | 97,920 state gas per new storage slot; execution gas cannot substitute |
| 22 | A failed frame does not stop later frames |
| 23 | The mempool admits transactions whose settlement will fail |
| 24 | Some admitted transactions are never included |
| 25 | Block production halted at block 408262 on 2026-11-06; the chain was later reset |
| 26 | Explorer history was lost when the gateway restarted |
| — | [Griefing economics](./docs/findings.md#griefing-economics): at 5e13 liquidity, moving the price 480 ticks costs 0.35 fgUSD in fees against a 1.11 fgUSD loss; unprofitable from about 7e14 (≈4 ETH depth) |
| — | [First-ever tick crossing](./docs/findings.md#gas-by-ticks-crossed): needs 195,840 state gas; at the 0 floor, settlement failed and the paymaster lost 0.000466 ETH |
| — | [Worst-case loss](./docs/findings.md#worst-case-loss-per-transaction): bounded by `MAX_TX_COST_WEI`, 0.002 ETH on the devnet; fuzzed over 10,000 runs |
| — | [Griefing paths](./docs/findings.md#griefing-paths): 11 malformed transactions each rejected at admission with the exact contract error |

## Limitations

- **Devnet only.** EIP-8141 is not on mainnet until Hegotá. The devnet halts, resets, and leaves some admitted transactions unmined.
- **Locked stake.** The paymaster has no owner, so nothing can call `unlockStake`. A new token needs a new deployment and new stake.
- **Max-uint permit deadline.** Validation cannot read `TIMESTAMP`, so it only accepts permits with `deadline = type(uint256).max`. The permit's value and nonce bound it. Tokens without EIP-2612 use bootstrap mode; Permit2 is not built.
- **Eviction.** A swap that moves the tick past `maxDeviation` (1,000 ticks), or the quote past a user's cap, evicts pending transactions that read that slot.
- **Thin-pool loss bound.** If settlement fails after `APPROVE`, the user's call runs and the paymaster pays the fee, at most `MAX_TX_COST_WEI` per transaction. The devnet's `MIN_LIQUIDITY` is 1e12, a demo value; the production floor where griefing stops paying is about 7e14.
- **Overpayment.** The user pays about 1.04x the fee, because `settle` buys the maximum cost and `refund` returns a conservative estimate.

## Uniswap integration

The pool is native ETH against the token, so there is no WETH wrapping. Validation reads `slot0` and `liquidity` through `StateLibrary` on the PoolManager singleton. Settlement opens `unlock`, swaps exact-output for the ETH `APPROVE` charged, and pays with `sync` / `transferFrom` / `settle` / `take`. The refund swaps exact-input. The demo's swap preset calls v4-core's `PoolSwapTest`. Line references are in [Reviewer pointers](#reviewer-pointers). Developer feedback: [`FEEDBACK.md`](./FEEDBACK.md).

## Alt-mempool integration

The paymaster stakes 0.012 ETH in the ERC-8421 staking registry from its constructor, as itself. The stake makes its validation-time read of the PoolManager's `slot0` admissible (PR #6 STO-033, ERC-8421 STORAGE-032); an unstaked probe doing the same read is rejected. Validation reads only `TXPARAM`, `FRAMEPARAM` and frame data, no environment opcodes, and keeps the prefix under the devnet's 100,000 gas cap. The SDK submits through `eth_sendFrameTransaction` and, with `compareMempools: true`, sends the same bytes to `eth_sendRawTransaction` and records the canonical rejection. Rule drift between the workshop's pinned draft, ERC-8421 and the devnet is in [`docs/findings.md`](./docs/findings.md).

| Path | What |
| --- | --- |
| `contracts/` | Foundry: `FrameGasPaymaster`, `FgUSD`, demo `MockLendingPool`, unit and fuzz tests |
| `sdk/` | `@framegas/sdk`: simulates for frame limits, quotes, builds, signs, submits |
| `mcp/` | `@framegas/mcp`: `framegas_quote`, `framegas_send`, `framegas_budget` |
| `demo/` | Next.js console: replay from `docs/evidence/`, live through the SDK |
| `scripts/` | `redeploy.sh` and the numbered scripts that reproduce each finding |

## AI usage disclosure

Parts of this codebase were written with AI coding assistants (Claude). All architecture decisions, contract logic, security review and integration work were done by the team; AI output was reviewed and tested before inclusion.

## License

MIT
