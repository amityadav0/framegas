# @framegas/sdk

Pay gas in any ERC-20 with EIP-8141 frame transactions. The sender needs no ETH.

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
| `NOT_MINED` | Admitted, but not mined within 10 minutes. It may still be mined |

## Options

- `compareMempools: true` submits the same signed bytes to the canonical mempool first and returns its answer in `result.canonicalMempool`. It is expected to refuse them.
- `sender` sends from a contract wallet the key owns.
- `maxFeePerGas` and `maxPriorityFeePerGas` default to 2 gwei, as the devnet workshop uses.

## Tests

`pnpm --filter @framegas/sdk test` runs the unit tests against a fake chain. `scripts/08-sdk-live.ts` runs it on the devnet.
