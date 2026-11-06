# Uniswap Developer Feedback — FrameGas

_Required for the Uniswap Foundation prize. Submitted through https://developers.uniswap.org/hackathon-feedback with a link to this file._

## What I used
- `@uniswap/v4-core` directly, no periphery: `IPoolManager`, `IUnlockCallback`, `StateLibrary.getSlot0` / `getLiquidity`, `TickMath`, `FullMath`, `PoolKey` / `PoolId`, `SwapParams`, `BalanceDelta`, `Currency`.
- The predeployed devnet stack from the EF alt-mempool devnet (`PoolManager`, `StateView`, `Permit2`, `WETH9`, Universal Router). I only needed `PoolManager`.
- A native-ETH / ERC20 pool (currency0 = address(0)) with no hook, initialised and seeded by my own deploy script.
- Three uses inside one EIP-8141 frame transaction: a `getSlot0` price read in the paymaster's validation frame (under the alt mempool's 100k gas cap and banned-opcode rules), a swap through `unlock` → `unlockCallback` → `swap` → `take` / `settle` in the settle frame, and a reverse swap in the refund frame.

## Time to first success
- About 4 hours from empty repo to a Forge test that swapped on a v4 pool from inside a paymaster via the unlock callback, including writing my own pool initialisation and liquidity-add helpers because no periphery was available on the devnet.
- About 8 more hours to get the same path admitted by the alt mempool. That time went to alt-mempool rules (banned opcodes, the shared gas cap, stake requirements), not to v4 itself.

## Friction
- Settling native ETH in the callback: the `settle` / `take` / `sync` ordering for `Currency.wrap(address(0))` with `msg.value` is only clear from reading `PoolManager.sol` and `CurrencySettler` in the test utils; the docs describe the ERC20 path.
- `getSlot0` through `StateLibrary` is an `extsload` of `keccak256(poolId, 6)`. I had to know that to explain the alt mempool's rejection message, which names the raw slot. A one-line "this is the storage slot you are reading" note next to `StateLibrary` would have saved time.
- Tick-crossing gas: each tick crossed adds about 24.5k gas to a swap, and a first-ever crossing writes new storage (my 97,920 state-gas budget failed; 195,840 passed). Nothing in the docs says how to bound a swap's gas for a fixed-gas context like a validation or settle frame.
- Price-manipulation economics: a paymaster that prices from `slot0` at admission can be griefed by moving the pool. I measured the cost at 5e13 active liquidity (about 59 fgUSD to move 480 ticks against a 0.002 ETH bounded loss) and derived a minimum-liquidity rule. This is a general problem for anything that reads a v4 price in a pre-execution context and I could not find guidance on it.
- `v4-core` pulls `solmate` through its own `lib`; the remapping in a fresh Foundry project is not documented and fails silently with a confusing import error until added.

## Missing capability or documentation
- A documented pattern for "read the price now, swap later in the same transaction with a signed cap", with the manipulation analysis. Paymasters, intent settlers and agent wallets all need it.
- A gas-cost table for `swap` by ticks crossed and by first-use vs warm slots, so fixed-gas callers can declare budgets.
- A minimal "native ETH pool from scratch, no periphery" example: initialise, add liquidity, swap, with the exact settle ordering for `address(0)`.
- A short note on `StateLibrary` slot layout for people who have to reason about storage reads (alt mempool / ERC-7562 style validation rules).

## One improvement with the greatest impact
- Publish a reference "quote-and-settle in one transaction" contract in `v4-periphery` (or the docs): read `slot0`, enforce a caller-signed `maxIn`, swap in the callback, refund the surplus, with the gas and liquidity bounds written down. FrameGas is that pattern; every alt-mempool or account-abstraction paymaster that wants to be priced by Uniswap instead of an off-chain quote will rebuild it otherwise.
