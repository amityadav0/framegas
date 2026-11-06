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

Tests: `forge test --root contracts` (97, including a whole-transaction fuzz suite and 20 quota tests), `pnpm --filter @framegas/sdk test`, `pnpm --filter @framegas/demo test`.

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
              balance and allowance ≥ maxTokenCost    │
              opt-in quota: spent + cap ≤ limit       │  refund():  exact-input swap of the unused ETH
              frames 2–3 bound exactly                │             back to the user's token
              APPROVE(PAYMENT): paymaster pays max    │  after last frame: chain returns unused max cost
```

`APPROVE` charges the paymaster the transaction's maximum cost before any execution frame runs. `settle` buys back exactly that much ETH from the pool with the user's tokens, never more than `maxTokenCost`. The chain returns the unused part after the last frame, so `refund` sells an estimate of it back to the user. Later frames run even if an earlier one fails, so `validate` rejects every settlement failure the user can cause alone.

| Mode | When | Frames | Difference |
| --- | --- | --- | --- |
| Bootstrap | First transaction for a user and token: no allowance | verify, validate, approve, settle, call(s), refund | `validate` requires frame 2 to be exactly `PAY_TOKEN.approve(paymaster, n)`, `n ≥ maxTokenCost`, followed by settle. The new allowance slot costs 97,920 state gas, about 0.56 fgUSD |
| Normal | Allowance already covers the cap | verify, validate, settle, call(s), refund | `validate` reads the allowance instead |

A permit in the settle frame is a third mode. The contract implements it, but the devnet rejects `ecrecover` in validation ([finding 18](./docs/findings.md#rule-drift)).

## Two EF named examples in one paymaster

The EF alt-mempool prize names "ERC-20 paymasters or daily quota paymasters" as examples of state access only an alt mempool admits. `FrameGasPaymaster` is both, in one contract and one stake.

| | ERC-20 paymaster | Daily quota paymaster |
| --- | --- | --- |
| Storage validation reads that the canonical mempool forbids | PoolManager `slot0` and `liquidity` (another contract's storage) | `quotas[sender]` and `epoch` in the paymaster's own storage |
| What validation rejects | quote above `maxTokenCost`, tick past `maxDeviation`, thin pool, low balance or allowance | `spent + maxTokenCost > limit` (`QuotaExceeded`) |
| Who writes the state | swaps, `settle`, `syncReference` | `settle` records what it pulled; `setQuota` sets the limit |
| Opt-in | any token holder | `setQuota(amount)` once, as a user call in any FrameGas transaction, bootstrap included. Default: no quota |

**The day without a clock.** `TIMESTAMP` and `NUMBER` are banned in validation, so the day is a counter, `epoch`, in paymaster storage. `settle` (an execution frame, where `block.number` is allowed) advances it when `block.number` reaches `epochStartBlock + 7200`, skipping quiet epochs in one write. `rollEpoch()` does the same for anyone. `epoch` shares a slot with `refTick`, which validation already loads, so reading it costs a warm `SLOAD`.

**Rules.**
- `spent` counts what `settle` pulled, at most the cap; refunds are not credited back.
- Lowering a quota applies at once. Raising or removing it applies from the next epoch: the increase is added to this epoch's `spent`, so a key cannot raise today's limit.
- Validation runs on chain at inclusion, in order, so two pending transactions from one user cannot both pass against the same `spent`.
- A user whose quota is used up cannot get a transaction validated, so cannot roll the epoch themselves. Any other user's settlement, or anyone calling `rollEpoch()`, does.
- The SDK reads the quota before simulating: `framegas.quoteRemaining(user)` returns `{ active, limit, spent, remaining, epoch, resetsAtBlock }`, and `quote`/`send` raise `QUOTA_EXCEEDED` instead of sending a transaction validation would reject.

The use-cases guide suggests a `pre_verify` frame for paymaster state; the devnet does not implement it ([finding 9](./docs/findings.md#rule-drift)), so the quota is updated in `settle` instead.

## Reviewer pointers

All in [`contracts/src/FrameGasPaymaster.sol`](./contracts/src/FrameGasPaymaster.sol).

| What | Where |
| --- | --- |
| `getSlot0` read in validation | [L284](./contracts/src/FrameGasPaymaster.sol#L284), quote from `sqrtPriceX96` [L290-291](./contracts/src/FrameGasPaymaster.sol#L290-L291), [L614-618](./contracts/src/FrameGasPaymaster.sol#L614-L618) |
| Settle-frame binding check: target, `SENDER` mode, selector, not atomic, no value, 132-byte calldata, gas floors | call [L277-278](./contracts/src/FrameGasPaymaster.sol#L277-L278), check [L436-452](./contracts/src/FrameGasPaymaster.sol#L436-L452) |
| Bootstrap approve-calldata check: `approve(this, n ≥ cap)`, 68 bytes, gas and state gas floors | detection [L274-275](./contracts/src/FrameGasPaymaster.sol#L274-L275), call [L299-301](./contracts/src/FrameGasPaymaster.sol#L299-L301), check [L456-471](./contracts/src/FrameGasPaymaster.sol#L456-L471) |
| Min-liquidity check (`getLiquidity` against `MIN_LIQUIDITY`) | [L287-288](./contracts/src/FrameGasPaymaster.sol#L287-L288) |
| Swap / settle / take | `unlock` [L326](./contracts/src/FrameGasPaymaster.sol#L326), callback [L410-417](./contracts/src/FrameGasPaymaster.sol#L410-L417), exact-output swap [L489-501](./contracts/src/FrameGasPaymaster.sol#L489-L501), `sync`, `transferFrom`, `settle`, `take` [L503-507](./contracts/src/FrameGasPaymaster.sol#L503-L507) |
| Refund frame: last frame only, re-derives settlement from frame statuses, surplus from `FRAMEPARAM` | [L372-407](./contracts/src/FrameGasPaymaster.sol#L372-L407), surplus [L563-580](./contracts/src/FrameGasPaymaster.sol#L563-L580), exact-input swap [L543-559](./contracts/src/FrameGasPaymaster.sol#L543-L559) |
| Reference tick + `syncReference` | state [L141-143](./contracts/src/FrameGasPaymaster.sol#L141-L143), check [L285-286](./contracts/src/FrameGasPaymaster.sol#L285-L286), advanced in settle [L327](./contracts/src/FrameGasPaymaster.sol#L327), `syncReference` [L423-426](./contracts/src/FrameGasPaymaster.sol#L423-L426), `_advanceReference` [L583-593](./contracts/src/FrameGasPaymaster.sol#L583-L593) |
| `MAX_TX_COST_WEI` | declared [L128](./contracts/src/FrameGasPaymaster.sol#L128), check [L280-281](./contracts/src/FrameGasPaymaster.sol#L280-L281) |
| Quota check in validation (before the mode branch, so bootstrap is held to it) | call [L296-297](./contracts/src/FrameGasPaymaster.sol#L296-L297), check [L523-528](./contracts/src/FrameGasPaymaster.sol#L523-L528) |
| Quota storage: `epoch` packed with `refTick`, one slot per user | [L138-161](./contracts/src/FrameGasPaymaster.sol#L138-L161) |
| Quota recorded in settle, epoch rolled in settle | [L508](./contracts/src/FrameGasPaymaster.sol#L508), [L513-520](./contracts/src/FrameGasPaymaster.sol#L513-L520), [L325](./contracts/src/FrameGasPaymaster.sol#L325), [L531-540](./contracts/src/FrameGasPaymaster.sol#L531-L540) |
| `setQuota`, `rollEpoch`, `quotaOf` | [L330-351](./contracts/src/FrameGasPaymaster.sol#L330-L351), [L355-357](./contracts/src/FrameGasPaymaster.sol#L355-L357), [L361-366](./contracts/src/FrameGasPaymaster.sol#L361-L366) |
| Stake from the constructor, no owner | [L262](./contracts/src/FrameGasPaymaster.sol#L262) |

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

**Quota cost**, measured on the devnet on 2026-11-06 on the same pool, block 1018 to 1038 ([`docs/evidence/quota-live.json`](./docs/evidence/quota-live.json)). The pre-quota rows ran on paymaster `0x7503…9996`, the others on `0x2fc9…f8`, both built from the same source apart from the quota.

| `validate` gas used | Pre-quota paymaster | No quota set | Quota active |
| --- | --- | --- | --- |
| Bootstrap | 52,986 | 56,399 (+3,413) | 56,658 (+3,672) |
| Normal | 48,594 | 51,679 (+3,085) | 51,938 (+3,344) |

| `settle` gas used | Pre-quota paymaster | No quota set | Quota active |
| --- | --- | --- | --- |
| Bootstrap | 104,457 | 105,422 | 116,345 |
| Normal | 114,453 | 115,426 | 126,313 |

The SDK declares 60,000 (bootstrap) and 55,000 (normal) for `validate`. With the 200-gas sender frame and 2,800 for the signature, the bootstrap prefix declares 63,000 of the 100,000 cap, leaving 37,000. `setQuota` as a user call used 14,109 gas plus 97,920 state gas for the new slot. The 5 Nov figures above predate the 2026-11-06 devnet reset; the same pre-quota code uses about 3,150 more validation gas on the reset chain ([finding 27](./docs/findings.md#rule-drift)).

## Evidence

The devnet was reset on 2026-11-06, and its explorer keeps history in memory, so explorer links from 2026-11-05 no longer resolve. The JSON files in [`docs/evidence/`](./docs/evidence/README.md) hold the admission reports and receipts.

| What | Transaction | Files |
| --- | --- | --- |
| Bootstrap, 24/24 checks | `0x08a9…9bf7`, block 405098 | `docs/evidence/bootstrap-0x08a9…{-summary.jpg,-frames.jpg,.json}` |
| Normal, 24/24 checks | `0xbd24…88e7`, block 405103 | `docs/evidence/normal-0xbd24…{-summary.jpg,-frames.jpg,.json}` |
| Same bytes to both mempools, bootstrap | `0x2b73…a331`, block 405263 | `docs/evidence/mempool-comparison-bootstrap-0x2b73…{.json,-summary.jpg}` |
| Same bytes to both mempools, normal | `0x6e76…4ff7`, block 405268 | `docs/evidence/mempool-comparison-normal-0x6e76…{.json,-summary.jpg}` |
| Staked paymaster reading PoolManager storage, 24/24 checks | `0xcafc…06af`, block 402821 | [`docs/findings.md`](./docs/findings.md#a-staked-contract-paymaster-reading-poolmanager-storage) |
| Current deployment, SDK end to end, bootstrap, canonical rejected, 24/24 | [`0x45fc…1dd3`](https://explorer.altmempool.wtf/tx/0x45fcd889938d04890cedf379a8bd83e3e34b818a71ac7975b65c742eaa4e1dd3), block 1213 | `docs/evidence/sdk-live-bootstrap-0x45fc…{.json,-summary.jpg,-frames.jpg}` |
| Current deployment, SDK end to end, normal, canonical rejected, 24/24 | [`0x08c4…b6b7`](https://explorer.altmempool.wtf/tx/0x08c4836702188f61108cb21f7e0067ef07f2a47e7bc123ceda62cdcf1835b6b7), block 1221 | `docs/evidence/sdk-live-normal-0x08c4…{.json,-summary.jpg,-frames.jpg}` |
| Quota: opt-in inside a bootstrap transaction | [`0xb3e5…b7f7`](https://explorer.altmempool.wtf/tx/0xb3e53ed4816645021f579fe68605982015573466b5a1bc5f43f612a9ca86b7f7), block 1026 | `docs/evidence/quota-live.json` |
| Quota: bootstrap and normal transactions under a 10 fgUSD quota | [`0x83a3…1e46`](https://explorer.altmempool.wtf/tx/0x83a3f639c235f97b94bf729a01d868a0c97feb7cc50c1d7bb8674cb3847a1e46) (normal), block 1038 | `docs/evidence/quota-live.json` |
| Demo replay screenshots, both modes, light and dark | | [`docs/evidence/demo/`](./docs/evidence/demo/) |
| Demo clip (Replay, 89 s) and terminal clip of `08-sdk-live.ts` output (30 s) | | [`docs/evidence/video/`](./docs/evidence/video/README.md) |

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
| 27 | After the reset, the same paymaster code uses about 3,150 more validation gas (48,594 vs 45,429 normal) |
| 28 | Admitted transactions the gateway relays to the miner an hour late, or drops: of four in a row, two swaps were mined after 61–72 minutes and two were dropped |
| 29 | A mined transaction is first reported "Dropped, Cancelled" with a nonce-mismatch reason, 0.75 s before inclusion |
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
- **Quota liveness.** An exhausted user's epoch rolls only when another user settles or someone calls `rollEpoch()`. Refunds do not reduce `spent`. An active quota adds about 10,900 gas to `settle`.
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
| `scripts/` | `redeploy.sh` and the numbered scripts that reproduce each finding; `10-quota-live.ts` measures the quota |
| `cre/` | Chainlink CRE workflow: mainnet vs devnet price divergence, see below |
| `skill/` | Agent skill in the Uniswap AI format, with two eval cases |

## MCP server and agent skill

[`mcp/`](./mcp/src/server.ts) is a stdio MCP server over the SDK with three tools. Amounts are decimal strings in token units; addresses and calldata are checked against hex patterns in the schema.

| Tool | Inputs | Returns | Sends? |
| --- | --- | --- | --- |
| `framegas_quote` | `payToken`, `calls[{to, data?}]` | `mode`, `requiredTokens`, `estimatedTokens`, `maxCostEth` | No |
| `framegas_budget` | `payToken`, `calls?` | `balance`, `allowance`, `quota {active, limit, spent, remaining, resetsAtBlock}`, `canSendNow`, `transactionsLikeThisAffordable` | No |
| `framegas_send` | `payToken`, `maxTokenCost`, `calls`, `compareMempools?` | `hash`, `explorerUrl`, `netCost`, per-frame gas, canonical mempool answer | Yes |

Failures come back as `{ error: { code, message, details } }` with the SDK's codes (`CAP_TOO_LOW` carries `requiredTokens`, `QUOTA_EXCEEDED` carries `resetsAtBlock`).

**Claude Desktop.** Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows), then restart Claude Desktop:

```json
{
  "mcpServers": {
    "framegas": {
      "command": "/absolute/path/to/pnpm",
      "args": ["--dir", "/absolute/path/to/framegas/mcp", "start"],
      "env": {
        "FRAMEGAS_PRIVATE_KEY": "0x… a devnet-only key holding fgUSD and no ETH"
      }
    }
  }
}
```

Claude Desktop does not inherit your shell's `PATH`, so use the output of `which pnpm`. `FRAMEGAS_DEPLOYMENTS` overrides the path to `deployments/devnet.json`. Never put a key that holds real funds here.

**Skill.** [`skill/SKILL.md`](./skill/SKILL.md) follows the [Uniswap AI skills](https://github.com/Uniswap/uniswap-ai) format: when to use, prerequisites, step-by-step SDK and MCP calls, bootstrap and normal examples, and every SDK code and paymaster error with what it means. Two eval cases with expected behaviours are in [`skill/evals/`](./skill/evals/).

## Chainlink CRE workflow

[`cre/divergence/main.ts`](./cre/divergence/main.ts) runs on a cron trigger every 5 minutes:

1. EVM read on Ethereum mainnet: `StateView.getSlot0` of the native ETH/USDC 0.3% v4 pool, at the last finalized block.
2. HTTP read of the devnet fgUSD pool's `slot0` through the alt-mempool gateway (`eth_getBlockByNumber`, `eth_call`), agreed with identical-value consensus. If the gateway fails, the pool is gone, or the latest block is older than 300 s, it uses the snapshot [`cre/sync-config.ts`](./cre/sync-config.ts) took from `deployments/devnet.json`.
3. Divergence between the two ETH prices. Above 3% it logs an alert and prepares the paymaster's `syncReference()` calldata with a tick bound of mainnet ± 300 ticks. The write is mocked: the payload is logged, nothing is sent. The paymaster has no on-chain setter for the bound.

```sh
cd cre/divergence && bun install && bun run ../sync-config.ts
cre login                                    # the CLI requires a CRE account, even to simulate
cre workflow simulate ./divergence -R .. -T staging-settings --non-interactive --trigger-index 0 | tee ../simulation.log
```

The simulation log goes to `cre/simulation.log`. It has not been recorded yet: CRE CLI v1.39.0 refuses `simulate` without a login.

## AI usage disclosure

Parts of this codebase were written with AI coding assistants (Claude). All architecture decisions, contract logic, security review and integration work were done by the team; AI output was reviewed and tested before inclusion.

## License

MIT
