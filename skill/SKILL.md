---
name: framegas-pay-gas-in-token
description: >
  Send Ethereum transactions from an account that holds no ETH, paying gas in an
  ERC-20 through a FrameGas paymaster that prices and settles on a Uniswap v4
  pool. Uses EIP-8141 frame transactions admitted by the ERC-8421 alternative
  mempool. Use when the user wants to "pay gas in USDC/a token", has "no ETH for
  gas", mentions "FrameGas", "frame transaction", "EIP-8141", "alt mempool",
  "gasless", "paymaster", "pay gas with fgUSD", or wants a daily spending cap on
  gas ("quota").
allowed-tools: Read, Glob, Grep, Bash(pnpm:*), Bash(cast:*), AskUserQuestion, mcp__framegas__framegas_quote, mcp__framegas__framegas_budget, mcp__framegas__framegas_send
license: MIT
metadata:
  author: amityadav0
  version: '0.1.0'
---

# Pay Gas in a Token with FrameGas

FrameGas sends the user's calls as one EIP-8141 frame transaction. A paymaster
contract pays the ETH gas, and in the same transaction it pulls the user's
token, swaps it on a Uniswap v4 pool for exactly the ETH it paid, and refunds
the unused part. The user signs once, holds no ETH, and never pays more than the
`maxTokenCost` they signed.

It runs on the ERC-8421 alt-mempool devnet (chain 1337) only. EIP-8141 is not on
mainnet until the Hegotá fork. **Never use a mainnet key or a key holding real
funds.**

## When to use

- The user wants to run contract calls and has the token but no ETH.
- The user asks what a transaction would cost in a token, or how many they can
  afford.
- The user wants to cap how much gas they spend per day (an opt-in quota).

Do not use it for mainnet or any chain other than the devnet, for calls that
send ETH (`value` is not supported: the sender has none), or to move the user's
funds anywhere they did not ask.

## Prerequisites

1. A **devnet-only** private key holding the pay token (`fgUSD`). It needs no
   ETH. Never ask the user to paste a key in chat; it goes in an environment
   variable.
2. The paymaster address for the token, from `deployments/devnet.json`
   (`paymasters` maps token to paymaster).
3. One of:
   - **MCP**: the `framegas` MCP server running with `FRAMEGAS_PRIVATE_KEY` set
     (tools `framegas_quote`, `framegas_budget`, `framegas_send`), or
   - **SDK**: `@framegas/sdk` in a TypeScript project (`viem` peer).

## Steps

Follow them in order. Step 4 sends a transaction: get the user's explicit
confirmation of the calls, token and cap first.

**1. Check the account** (read only).

```ts
import { createFrameGas } from "@framegas/sdk";
import deployment from "./deployments/devnet.json";

const framegas = createFrameGas({ privateKey: process.env.FRAMEGAS_PRIVATE_KEY as `0x${string}`, paymasters: deployment.paymasters });
const account = await framegas.account(deployment.fgUSD); // { sender, paymaster, balance, allowance }
const quota = await framegas.quoteRemaining();            // { active, limit, spent, remaining, epoch, resetsAtBlock }
```

MCP: `framegas_budget({ payToken: "fgUSD" })`.

**2. Build the calls.** Each call is `{ to, data }` with ABI-encoded calldata
(`viem`'s `encodeFunctionData`). No `value`.

**3. Quote** (simulates, sends nothing).

```ts
const q = await framegas.quote({ payToken: deployment.fgUSD, calls });
// q.mode: "bootstrap" (first transaction, no allowance yet) or "normal"
// q.requiredTokens: the smallest maxTokenCost validation accepts now
// q.estimatedTokens: expected cost after the refund
```

MCP: `framegas_quote({ payToken: "fgUSD", calls })`, amounts come back as
decimal strings in token units.

**4. Choose the cap and confirm.** Use `requiredTokens × 1.02` so a small price
or base-fee move between quote and inclusion does not fail validation. The user
must hold at least the cap, and it must fit in any quota's `remaining`. Show the
user the calls, the cap and the expected cost, and wait for a yes.

**5. Send.**

```ts
const r = await framegas.send({ payToken: deployment.fgUSD, maxTokenCost: (q.requiredTokens * 102n) / 100n, calls });
// r.hash, r.explorerUrl, r.success, r.tokensPaid, r.tokensRefunded, r.frames
```

MCP: `framegas_send({ payToken: "fgUSD", maxTokenCost: "2.04", calls })`.

**6. Report** the explorer link, the net cost (`tokensPaid − tokensRefunded`),
and whether every frame succeeded. A failed user call still costs gas: say so.

## Examples

### Bootstrap: the user's first transaction

No allowance to the paymaster yet, so the SDK puts `approve(paymaster, n)` in
its own frame before settlement. Same signature, still no ETH. The new
allowance slot costs 97,920 state gas, about 0.56 fgUSD more than later
transactions.

```ts
const calls = [{ to: fgUSD, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [recipient, 1n] }) }];
const q = await framegas.quote({ payToken: fgUSD, calls }); // q.mode === "bootstrap"
const r = await framegas.send({ payToken: fgUSD, maxTokenCost: (q.requiredTokens * 102n) / 100n, calls });
// frames: sender verify, paymaster validate, approve, settle, call 0, refund
```

By default the approve covers 20 caps, so the next transactions are normal.
Pass `approveAmount` to change that.

### Normal: later transactions

```ts
const q = await framegas.quote({ payToken: fgUSD, calls }); // q.mode === "normal"
const r = await framegas.send({ payToken: fgUSD, maxTokenCost: (q.requiredTokens * 102n) / 100n, calls });
// frames: sender verify, paymaster validate, settle, call 0, refund
// measured: about 1.38 fgUSD for one transfer at 2 gwei
```

### Opting in to a daily quota

Add `setQuota(amount)` on the paymaster as one of the calls; it works in a
bootstrap transaction too. Lowering applies at once; raising or removing (`0`)
applies from the next epoch (7,200 blocks).

```ts
const optIn = { to: paymaster, data: encodeFunctionData({ abi: paymasterAbi, functionName: "setQuota", args: [parseUnits("10", 6)] }) };
await framegas.send({ payToken: fgUSD, maxTokenCost: cap, calls: [optIn] });
```

## Failure modes

The SDK raises `FrameGasError` with a `code` before sending whenever simulation
predicts a failure; MCP tools return the same as `{ error: { code, message, details } }`.

| SDK code | Meaning | What to do |
| --- | --- | --- |
| `INSUFFICIENT_BALANCE` | The account holds less than the cap, or none of the token | Lower the cap to at most the balance, or fund the account with the token |
| `CAP_TOO_LOW` | `maxTokenCost` is below what validation needs; `details.requiredTokens` says how much | Re-quote and use the new figure × 1.02 |
| `QUOTA_EXCEEDED` | The cap is above what the user's quota leaves this epoch; `details.resetsAtBlock` | Wait for the reset, lower the cap, or (from the next epoch) raise the quota |
| `UNKNOWN_TOKEN` | No paymaster registered for that token | Use a token from `deployments/devnet.json` |
| `VALUE_NOT_SUPPORTED`, `NO_CALLS` | A call carries ETH, or there are no calls / malformed calls | Remove `value`; pass at least one valid call |
| `CALL_WILL_REVERT` | A user call reverts in simulation at every gas limit; nothing was sent | Fix the call (allowance, arguments, target) |
| `SETTLEMENT_WILL_FAIL` | The swap cannot settle, usually a pool too thin | Do not retry; report it |
| `VALIDATION_FAILED` | The paymaster would refuse; the message holds the reason | See the paymaster errors below |
| `REJECTED` | The alt-mempool refused at admission; `details.decoded.name` is the paymaster error | See below |
| `NOT_MINED` | Admitted but not included within 10 minutes. The devnet sometimes never includes one | Report the hash as pending; do not resend with the same nonce without checking the receipt |

Paymaster errors raised in validation (the transaction is rejected, nothing is paid):

| Error | Meaning |
| --- | --- |
| `CostAboveCap(tokenCost, maxTokenCost)` | Gas at the pool's price plus the 5% buffer exceeds the cap. Re-quote |
| `InsufficientBalance(balance, maxTokenCost)` | The sender holds less than the cap |
| `InsufficientAllowance(allowance, maxTokenCost)` | Normal mode, but the allowance no longer covers the cap. The SDK switches to bootstrap when it sees this |
| `QuotaExceeded(spent, maxTokenCost, limit)` | The opt-in quota for this epoch does not cover the cap |
| `TickDeviated(poolTick, refTick)` | The pool price moved more than about 10.5% from the paymaster's reference. Anyone can call `syncReference()`, which moves it at most that far per block |
| `PoolTooThin(liquidity, minLiquidity)` | The pool's active liquidity is below the paymaster's minimum |
| `MaxCostTooHigh(maxCost, limit)` | The transaction's maximum gas cost is above the paymaster's per-transaction limit. Fewer or cheaper calls |
| `SettleNotBound`, `SettleInAtomicBatch`, `SettleMalformed`, `SettleGasTooLow` | The settle frame is missing, batched, malformed or short of gas. Only a hand-built transaction hits these; use the SDK |
| `ApproveNotBound`, `ApproveGasTooLow`, `PermitWithBootstrap` | The bootstrap approve frame is not exactly `approve(paymaster, n ≥ cap)` with enough gas. Use the SDK |
| `InvalidPermit` | A permit in the settle frame would fail. Permits cannot run on the devnet (it rejects `ecrecover` in validation) |

Errors in execution frames (the transaction is included, gas is spent):

| Error | Meaning |
| --- | --- |
| `RefundGasExceeded`, `RefundNotLastFrame`, `RefundNotSettled`, `RefundAboveCap` | The refund frame failed. The user keeps paying only what settle pulled, at most the cap, and forfeits the refund |
| `InsufficientPoolLiquidity` | The pool could not supply the ETH in settle. The user's call still ran; the paymaster absorbed the gas |
| `NotTxSender`, `NotPoolManager`, `AlreadySynced`, `QuotaTooLarge` | Direct calls made wrongly: settle/refund from someone other than the sender, a fake callback, a second `syncReference` in one block, a quota over 96 bits |
| `PoolNotInitialized`, `InvalidDeviation` | Deployment only: the pool does not exist, or `maxDeviation` is not positive |

## Rules

- Devnet keys only. Never request, print or store a private key in chat or in a file other than a git-ignored `.env`.
- Always quote before sending, and confirm the calls, token and cap with the user before `send`.
- Never set `maxTokenCost` above the balance or the quota's `remaining`; the SDK refuses it anyway.
- Report costs in token units with the explorer link. Do not claim success unless `r.success` is true.
