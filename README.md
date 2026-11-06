# FrameGas

**The permissionless gas-payment layer for Ethereum.** Pay gas in any ERC-20 — natively, with no relayer, no sponsor treasury and no off-chain price signer.

FrameGas is a paymaster built on [EIP-8141](https://eips.ethereum.org/EIPS/eip-8141) frame transactions. Its validation frame reads the token's price from a Uniswap v4 pool, its execution frame pulls the token, swaps it on the same pool and pays gas — all in one atomic transaction admitted through the [ERC-8421 alternative mempool](https://docs.altmempool.wtf/).

> Built at ETHGlobal Mumbai, 5–7 Nov 2026. Status: running on the alt-mempool devnet (chain 1337). EIP-8141 is scheduled for the Hegotá fork, so it cannot run on mainnet until then.

## What it does

```ts
const framegas = createFrameGas({ privateKey, paymasters: { [fgUSD]: paymaster } });
const { requiredTokens } = await framegas.quote({ payToken: fgUSD, calls });
await framegas.send({ payToken: fgUSD, maxTokenCost: requiredTokens, calls });
```

One signature, one transaction. The user holds zero ETH, including on their first transaction. If gas would cost more than `maxTokenCost`, validation fails and nothing moves.

On the devnet a typical transaction cost 1.38 fgUSD, about 1.04x its gas fee at the pool's price, and the user had to hold 1.63 fgUSD. A user's first transaction cost about 0.56 fgUSD more.

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
| `contracts/` | Foundry: `FrameGasPaymaster`, `FgUSD` (6 decimals, EIP-2612), unit tests and a whole-transaction fuzz suite |
| `sdk/` | `@framegas/sdk`: simulates to find frame limits, then quotes, builds, signs and broadcasts |
| `mcp/` | `@framegas/mcp`: `framegas_quote`, `framegas_send` and `framegas_budget` tools over the SDK |
| `demo/` | Demo page, with a replay mode that runs from `docs/evidence/` when the devnet is down |
| `scripts/` | `redeploy.sh` rebuilds the whole deployment, and the numbered scripts reproduce each finding |
| `docs/` | [`findings.md`](./docs/findings.md) on the alt-mempool rules, and [`evidence/`](./docs/evidence/) |

## Uniswap integration (for reviewers)

| What | Where |
| --- | --- |
| Pool price read during validation (`StateLibrary.getSlot0` on the v4 PoolManager) | [`FrameGasPaymaster.sol:254`](./contracts/src/FrameGasPaymaster.sol#L254) |
| Price to token cost, from `sqrtPriceX96` | [`FrameGasPaymaster.sol:512-516`](./contracts/src/FrameGasPaymaster.sol#L512-L516) |
| Manipulation check against the reference tick | [`FrameGasPaymaster.sol:255-256`](./contracts/src/FrameGasPaymaster.sol#L255-L256) |
| Minimum active liquidity (`getLiquidity`) | [`FrameGasPaymaster.sol:257-258`](./contracts/src/FrameGasPaymaster.sol#L257-L258) |
| Settlement: `PoolManager.unlock` | [`FrameGasPaymaster.sol:293`](./contracts/src/FrameGasPaymaster.sol#L293) |
| Exact-output swap, tokens for the ETH `APPROVE` collected | [`FrameGasPaymaster.sol:418-439`](./contracts/src/FrameGasPaymaster.sol#L418-L439) |
| Paying the pool and taking ETH (`sync`, `transferFrom`, `settle`, `take`) | [`FrameGasPaymaster.sol:431-436`](./contracts/src/FrameGasPaymaster.sol#L431-L436) |
| Refund: exact-input swap of surplus ETH back to tokens | [`FrameGasPaymaster.sol:441-458`](./contracts/src/FrameGasPaymaster.sol#L441-L458) |
| Unlock callback | [`FrameGasPaymaster.sol:339-346`](./contracts/src/FrameGasPaymaster.sol#L339-L346) |
| Reference tick, moved at most `maxDeviation` per block | [`FrameGasPaymaster.sol:352-355`](./contracts/src/FrameGasPaymaster.sol#L352-L355), [`FrameGasPaymaster.sol:481-492`](./contracts/src/FrameGasPaymaster.sol#L481-L492) |

The pool is native ETH against the token, as mainnet's deepest v4 pools are, so there is no WETH wrapping. See [`FEEDBACK.md`](./FEEDBACK.md) for Uniswap developer feedback.

## Alt-mempool integration (for reviewers)

| What | Where |
| --- | --- |
| Validation entry point | [`FrameGasPaymaster.sol:242-278`](./contracts/src/FrameGasPaymaster.sol#L242-L278) |
| The settle frame must follow validation, run unbatched, carry no ETH, have exact calldata and enough gas | [`FrameGasPaymaster.sol:365-382`](./contracts/src/FrameGasPaymaster.sol#L365-L382) |
| Bootstrap check: the frame before settlement may only be `approve(paymaster, n)`, with `n` at least the cap | [`FrameGasPaymaster.sol:385-400`](./contracts/src/FrameGasPaymaster.sol#L385-L400) |
| Per-transaction cost limit | [`FrameGasPaymaster.sol:250-251`](./contracts/src/FrameGasPaymaster.sol#L250-L251) |
| Permit check, the path that needs `ecrecover` | [`FrameGasPaymaster.sol:403-415`](./contracts/src/FrameGasPaymaster.sol#L403-L415) |
| Staking from the constructor, as the contract itself | [`FrameGasPaymaster.sol:232`](./contracts/src/FrameGasPaymaster.sol#L232) |
| Refund, reading earlier frames' gas from `FRAMEPARAM` | [`FrameGasPaymaster.sol:301-336`](./contracts/src/FrameGasPaymaster.sol#L301-L336), [`FrameGasPaymaster.sol:461-478`](./contracts/src/FrameGasPaymaster.sol#L461-L478) |

- The same signed transaction, refused by the canonical mempool and admitted by the alt-mempool: [`docs/evidence/`](./docs/evidence/README.md#the-same-signed-transaction-in-both-mempools)
- Rule findings against the pinned draft and ERC-8421, griefing economics and worst-case loss: [`docs/findings.md`](./docs/findings.md)

## Limitations

- **Devnet only, until Hegotá.** EIP-8141 is not live on mainnet, so FrameGas cannot run there. The contracts target mainnet's native-ETH pools and real token behaviour so that only addresses change.
- **The devnet's liquidity threshold is a demo value.** It accepts pools far thinner than production should: griefing stops being profitable at about 4 ETH of depth.
- **Permits cannot run on the devnet.** Its sidecar rejects precompile calls in validation. Bootstrap mode covers the same case with an approve frame.
- **Gas permits must not expire**, because validation cannot read the time.
- **Tokens without EIP-2612 use bootstrap mode.** Permit2 is not supported yet.
- **A first-ever tick crossing needs more state gas** than the floors validation enforces. The SDK finds it by simulating, but a client that declares only the floors will fail settlement, and the paymaster pays that transaction's gas.
- **Stake cannot be withdrawn**, because the paymaster has no owner.
- **The devnet is not dependable.** It stopped producing blocks on 2026-11-06, and some admitted transactions are never included. The demo can replay recorded evidence instead.

## Run it

```sh
pnpm install
forge test --root contracts          # 73 tests, including the fuzz suite
pnpm --filter @framegas/sdk test     # SDK unit tests against a fake chain
scripts/redeploy.sh --fresh          # new token, pool, staked paymaster and smoke test on the devnet
pnpm exec tsx scripts/08-sdk-live.ts # the SDK end to end on the devnet
```

Deployment needs about 0.085 ETH of devnet ETH, which it cannot recover. The deployer key is generated into the git-ignored `.env` on first use.

**Demo page.** `pnpm --filter @framegas/demo dev`, then open <http://localhost:3000>. Replay mode needs nothing else: it plays the transactions recorded in `docs/evidence/`. Live mode turns on when the devnet is producing blocks and the server has `FRAMEGAS_DEMO_KEY`, a devnet key holding the token and no ETH.

**MCP server.** Add it to an MCP client:

```json
{
  "mcpServers": {
    "framegas": {
      "command": "pnpm",
      "args": ["--dir", "/path/to/framegas/mcp", "start"],
      "env": { "FRAMEGAS_PRIVATE_KEY": "0x… devnet key" }
    }
  }
}
```

It offers `framegas_quote`, `framegas_send` and `framegas_budget`. Amounts are in token units, and a failure comes back as a readable error with the amount needed where that applies.

## AI usage disclosure

Parts of this codebase were written with AI coding assistants (Claude). All architecture decisions, contract logic, security review and integration work were done by the team; AI output was reviewed and tested before inclusion.

## License

MIT
