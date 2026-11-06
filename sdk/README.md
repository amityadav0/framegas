# @framegas/sdk

Pay gas in any ERC-20 with EIP-8141 frame transactions. The sender needs no ETH. Runs on the ERC-8421 alt-mempool devnet (chain 1337). Source and docs: <https://github.com/amityadav0/framegas>.

```sh
pnpm add @framegas/sdk
```

The deployment current at publish time ships with the package: `import deployment from "@framegas/sdk/deployments/devnet.json" with { type: "json" }`.

```ts
import { createFrameGas } from "@framegas/sdk";

const framegas = createFrameGas({
  privateKey,                                  // devnet key
  paymasters: { [fgUSD]: paymasterAddress },   // from deployments/devnet.json
});

const quote = await framegas.quote({ payToken: fgUSD, calls });
const result = await framegas.send({ payToken: fgUSD, maxTokenCost: quote.requiredTokens, calls });
console.log(result.explorerUrl, result.tokensPaid - result.tokensRefunded);
```

## What `send` does

1. **Picks the mode.** If the sender's allowance to the paymaster covers `maxTokenCost`, the transaction is `validate`, `settle`, your calls, `refund`. Otherwise it adds `approve(paymaster, amount)` before `settle`, still in one transaction. `amount` defaults to 20 times the cap, so the next transactions need no approve frame.
2. **Simulates until every frame succeeds.** Frame limits cannot be known in advance: a swap can cross a tick, and a first-ever crossing writes new storage slots that cost state gas. The SDK starts from the paymaster's floors and raises state gas, then execution gas, until settlement succeeds. It finds what your calls need in the same way, then tightens each frame to what it used, and simulates the result as a whole.
3. **Checks the cap.** It prices the transaction's maximum cost with the paymaster's own `quote`, and refuses a cap below that, with the amount needed in `error.details.requiredTokens`.
4. **Signs and broadcasts** to the alt-mempool, waits for the receipt, and reads what was paid and refunded from the paymaster's events.

Nothing is sent when simulation says settlement or a call would fail.

## Submit now, collect later

`send` is `collect(await submit(req))`. Call the two halves yourself when the process that sends cannot wait for a block, such as a serverless function with a 10-second limit:

```ts
const submitted = await framegas.submit({ payToken: fgUSD, maxTokenCost, calls });
// submitted.hash, submitted.explorerUrl, submitted.canonicalMempool, submitted.frameNames, submitted.frameLimits

const result = await framegas.collect(submitted, { timeoutMs: 3_000 }); // a SendResult, or NOT_MINED after 3 s
```

- **`submit(req)`** takes the same request as `send` and does steps 1–4 up to the broadcast. It returns a `Submitted` as soon as the alt-mempool admits the transaction, with the hash, both mempools' answers, the mode, and each frame's name and limits. Errors are the same as for `send`, apart from `NOT_MINED`.
- **`collect(submitted, { timeoutMs })`** waits for the receipt and reads the settlement from the paymaster's events. `timeoutMs` defaults to the client's `mineTimeoutMs`. On `NOT_MINED` the transaction may still be mined, so call `collect` again with the same `Submitted`.

`collect` needs only the `Submitted` and a client for the same chain, so it can run in a different process from `submit`. `Submitted` holds bigints: encode them when you send it as JSON (the demo writes them as `"123n"` strings and decodes them on the way back).

## Errors

Every failure is a `FrameGasError` with a `code`:

| Code | Meaning |
| --- | --- |
| `UNKNOWN_TOKEN` | No paymaster is configured for the token |
| `INSUFFICIENT_BALANCE` | The sender holds less than the cap |
| `CAP_TOO_LOW` | The cap is below what this transaction needs. `details.requiredTokens` says how much |
| `VALUE_NOT_SUPPORTED` | A call carries ETH, which a sender with none cannot send |
| `NO_CALLS` | There is nothing to do |
| `VALIDATION_FAILED` | The paymaster would refuse the transaction |
| `SETTLEMENT_WILL_FAIL` | Settlement fails in simulation at every limit, usually because the pool is too thin |
| `CALL_WILL_REVERT` | A call reverts in simulation at every limit. `details.callIndex` says which |
| `REJECTED` | The alt-mempool refused it. The paymaster's error is decoded when there is one |
| `NOT_MINED` | Admitted, but not mined within `mineTimeoutMs` (default 10 minutes) or `collect`'s `timeoutMs`. It may still be mined: `details.hash` |

## Options

- `compareMempools: true` submits the same signed bytes to the canonical mempool first and returns its answer in `result.canonicalMempool`. It is expected to refuse them.
- `sender` sends from a contract wallet the key owns.
- `maxFeePerGas` and `maxPriorityFeePerGas` default to 2 gwei, as the devnet workshop uses.

## Tests

`pnpm --filter @framegas/sdk test` runs the unit tests against a fake chain. `scripts/08-sdk-live.ts` runs it on the devnet.
