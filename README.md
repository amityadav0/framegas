# FrameGas

**The permissionless gas-payment layer for Ethereum.** Pay gas in any ERC-20 — natively, with no relayer, no sponsor treasury and no off-chain price signer.

FrameGas is a paymaster built on [EIP-8141](https://eips.ethereum.org/EIPS/eip-8141) frame transactions. Its validation frame reads the token's price from a Uniswap v4 pool, its execution frame pulls the token, swaps it on the same pool and pays gas — all in one atomic transaction admitted through the [ERC-8421 alternative mempool](https://docs.altmempool.wtf/).

> Built at ETHGlobal Mumbai, 5–7 Nov 2026. Status: running on the alt-mempool devnet (chain 1337). EIP-8141 is scheduled for the Hegotá fork, so it cannot run on mainnet until then.

## What it does

```ts
await framegas.send({
  payToken: UNI,
  maxTokenCost: parseUnits("0.3", 18),
  calls: [{ to: AavePool, data: supply(UNI, amount, me) }],
});
```

One signature. The user holds zero ETH. If gas would exceed `maxTokenCost`, validation fails and nothing moves.

## Design trade-offs

- **Working capital, not a sponsor treasury.** `APPROVE` collects the transaction's maximum cost from the paymaster before any execution frame runs, so it must already hold ETH. Each transaction's swap is designed to refill what that transaction spent. Anyone can top the balance up, and no operator controls it.
- **The stake is locked for good.** The paymaster has no owner, so nothing can call `unlockStake`. Stake is the price of reading pool state during validation.
- **One paymaster per token and pool.** Fixing both at deployment stops anyone pointing the paymaster at a thin pool they control. A new token needs a new deployment and stake.
- **A pool move can evict pending transactions.** Pending transactions that depend on a slot are revalidated when it changes, so a swap that moves the tick past `maxDeviation`, or the quote past a user's `maxTokenCost`, evicts them. `maxDeviation` is set wide (1,000 ticks, about 10.5%) so ordinary swaps do not.
- **The reference tick can be dragged, slowly.** Validation cannot read the block number, so it compares the pool's tick with a tick in the paymaster's own storage. If the market moves past `maxDeviation`, validation fails until the reference catches up, so anyone can call `syncReference()`. It moves at most `maxDeviation` per block, which makes dragging it cost sustained capital.
- **The user overpays slightly.** `APPROVE` reserves the maximum cost, and `settle` buys all of it with tokens. A final frame sells a conservative estimate of the unused ETH back for tokens, because the chain returns that ETH only after the last frame. In the measured transactions the user paid about 1.04x the fee and held 1.17x. Refunding is best effort: if the frame fails or is left out, the user forfeits the refund and the paymaster keeps it. The user never pays more than the signed `maxTokenCost`.
- **The first transaction costs more.** A user with no allowance puts `approve(paymaster, n)` in a frame before settlement, in one transaction, with zero ETH and no relayer. Validation allows nothing else in that frame. The new allowance slot's state gas adds about 0.56 fgUSD, paid in tokens.
- **Permits are supported but cannot run on the devnet yet.** Validation cannot read `TIMESTAMP`, so it can only check a permit with `deadline = type(uint256).max`, which the permit's value and nonce still bound. The devnet's sidecar also rejects every precompile call in validation (`precompiles: []`), against the rule texts, so `ecrecover` cannot run there. The contract implements the check, and it executes in simulation.
- **The paymaster can lose gas when settlement fails.** A failed frame does not stop later ones, so the user's call would land for free. Validation rules out every failure the user controls alone. What remains is the price moving past the 5% buffer in the same block, a balance drained after admission, or a pool too thin for the swap. Each costs at most `MAX_TX_COST_WEI` per transaction, 0.002 ETH on the devnet. The cost of causing it grows with pool depth, so deploy on a deep pool. See [`docs/findings.md`](./docs/findings.md#worst-case-loss-per-transaction).
- **Validation gas is shared.** The devnet caps the whole validation prefix at 100,000 gas, so the paymaster keeps its checks small. See [`docs/findings.md`](./docs/findings.md).

## Layout

| Path | What |
| --- | --- |
| `contracts/` | Foundry: `FrameGasPaymaster`, `FrameGasValidator` (ERC-8286 / ERC-7579 module), `QuotaPolicy`, optional `FrameGasHook` (Uniswap v4) |
| `sdk/` | `@framegas/sdk` — viem client, frame-tx encoder, alt-mempool gateway RPC |
| `mcp/` | `@framegas/mcp` — `framegas_quote`, `framegas_send`, `framegas_budget` tools |
| `skill/` | Agent Skill (Uniswap-AI format) |
| `cre/` | Chainlink CRE workflow: price sanity bound + divergence alert (simulation) |
| `demo/` | Next.js demo |
| `docs/` | Architecture, threat model, findings on alt-mempool rules, CROPS |

## Uniswap integration (for reviewers)

<!-- fill with exact file:line pointers before submission -->
- Pool price read in validation: `contracts/src/FrameGasPaymaster.sol` — `_quote()`
- Swap in execution: `contracts/src/FrameGasPaymaster.sol` — `_settle()`
- Hook: `contracts/src/FrameGasHook.sol`

See [`FEEDBACK.md`](./FEEDBACK.md) for Uniswap developer feedback.

## Alt-mempool integration (for reviewers)

<!-- admitted tx link + findings -->
- Admitted frame tx: _explorer link_
- Rule findings vs ERC-8421: [`docs/findings.md`](./docs/findings.md)

## Run it

_TBD_

## AI usage disclosure

Parts of this codebase were written with AI coding assistants (Claude). All architecture decisions, contract logic, security review and integration work were done by the team; AI output was reviewed and tested before inclusion.

## License

MIT
