# FrameGas

**The permissionless gas-payment layer for Ethereum.** Pay gas in any ERC-20 — natively, with no relayer, no sponsor treasury and no off-chain price signer.

FrameGas is a paymaster built on [EIP-8141](https://eips.ethereum.org/EIPS/eip-8141) frame transactions. Its validation frame reads the token's price from a Uniswap v4 pool, its execution frame pulls the token, swaps it on the same pool and pays gas — all in one atomic transaction admitted through the [ERC-8421 alternative mempool](https://docs.altmempool.wtf/).

> Built at ETHGlobal Mumbai, 5–7 Nov 2026. Status: hackathon prototype on the alt-mempool devnet (chain 1337). EIP-8141 targets the Hegotá fork.

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
