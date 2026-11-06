# Shot list: 3-minute demo

Recorded from the demo in Replay mode (light theme, 1440×760 window) and a terminal. Order: rejection first, frontend flow, SDK and MCP in three lines, findings, limits.

**Before recording**

- `pnpm --filter @framegas/demo build && pnpm --filter @framegas/demo start`, open <http://localhost:3000>, Replay selected, theme Light. The status pill shows the current block if the gateway is up; Replay does not need it.
- Tx 1 (bootstrap, 2026-11-06) selected and reset to `1/10 · Signed, not sent`.
- A second tab on <https://explorer.altmempool.wtf/tx/0x08c4836702188f61108cb21f7e0067ef07f2a47e7bc123ceda62cdcf1835b6b7>.
- A terminal at the repo root, font large enough to read at 1080p, with `docs/evidence/sdk-live-output.txt` ready to `cat`.
- `docs/findings.md` open at the top, rendered (GitHub or a Markdown preview).

**Shots**

| Time | On screen | Action | Voiceover |
| --- | --- | --- | --- |
| 0:00–0:08 | Demo, Tx 1, frame strip all pending. Wallet: fgUSD 100.000000, ETH **0** in red | Hold | "This wallet has 100 fgUSD and zero ETH. It's about to send a transaction anyway." |
| 0:08–0:22 | Mempools column | Press → once (`2/10 · Sent`). Both cards answer | "The same signed bytes go to both mempools. The canonical one rejects them: StorageReadNonSender. The ERC-8421 alt-mempool admits them, 24 of 24 checks." |
| 0:22–0:30 | Canonical card, red error text | Hover the error | "The rejection is the point: validation reads Uniswap v4's pool storage to price gas, and only a staked paymaster in the alt-mempool may do that." |
| 0:30–0:42 | Frame strip, frame 1 `validate` turns current, then done (56,399 / 60,000) | Press → twice | "Frame one is the paymaster's validation: it reads the v4 pool price, checks the cap, and approves paying gas — in 56 thousand gas, under the devnet's 100 thousand cap." |
| 0:42–0:52 | Frame 2 `approve`, +97,920 state | Press → | "First transaction, so the user approves the paymaster inside the same transaction. No relayer, no ETH." |
| 0:52–1:05 | Frame 3 `settle`; cost table fills "Bought max cost at settle 2.643216" | Press → | "Settle swaps the user's fgUSD for exactly the ETH the chain charged the paymaster, on the same v4 pool. Never more than the signed cap, 2.82." |
| 1:05–1:15 | Frames 4–5, the user's two calls | Press → twice | "Then the user's own calls run: two token transfers." |
| 1:15–1:28 | Frame 6 `refund`, then `10/10 · Mined`. Cost table: Paid 2.332470, 82.7% of cap. Paymaster net +0.000024952 ETH in green | Press → twice, hold | "Refund sells the unused gas back. The user paid 2.33 fgUSD, the paymaster ended slightly ahead, mined in block 1,213." |
| 1:28–1:40 | Tx 2 (normal) selected, Play. `approve` shown struck through: "not needed" | Click Tx 2, click Play | "Second transaction: the allowance exists, so there's no approve frame. 1.39 fgUSD." |
| 1:40–1:50 | Explorer tab: Miner view, On chain, P2P relayed, every rule passed | Switch tab | "On the devnet explorer: on chain, relayed to the miner, every rule passed." |
| 1:50–2:02 | Editor or slide with the three SDK lines (README Quickstart) | Static | "For developers it's three lines: create the client, quote, send with a cap." |
| 2:02–2:15 | Terminal: `cat docs/evidence/sdk-live-output.txt`, scrolling to the two `canonical mempool: rejected` lines | Run `cat` | "This is that run from the SDK: both transactions, every frame ok, and the canonical rejection recorded each time." |
| 2:15–2:22 | README "MCP server" table: `framegas_quote`, `framegas_budget`, `framegas_send` | Static | "The same three calls are MCP tools, so an agent can pay gas in a token — with an optional daily quota enforced in validation." |
| 2:22–2:40 | `docs/findings.md` summary line at the top, then row 28 | Scroll slowly | "We logged 29 findings against the rule texts: a flat 100 thousand gas cap even for staked entities, no precompiles in validation, and a gateway that relayed some admitted transactions an hour late or dropped them." |
| 2:40–2:52 | README "Limitations" | Static | "Limits: devnet only until Hegotá, the stake is locked because there is no owner, and a failed settlement costs the paymaster at most 0.002 ETH per transaction." |
| 2:52–3:00 | Demo, Tx 1 mined state, full console | Hold | "FrameGas: gas in any ERC-20, priced and settled on Uniswap v4, admitted by the alt-mempool." |

**Numbers on screen**, for checking the voiceover: Tx 1 `0x45fc…1dd3` quote 2.764176, cap 2.819459, bought 2.643216, refunded 0.310746, paid 2.332470, block 1,213; Tx 2 `0x08c4…b6b7` quote 1.654349, cap 1.687435, paid 1.385196, block 1,221. Both 24/24, both canonical `StorageReadNonSender`.

**Optional swap-ins**

- 0:30–1:28 can be replaced by the first 60 s of [`framegas-replay-light.gif`](./framegas-replay-light.gif).
- 2:02–2:15 can be replaced by [`framegas-sdk-live-terminal.gif`](./framegas-sdk-live-terminal.gif) (30 s; trim to 13 s).
- If Live mode works on the day, replace 1:28–1:40 with a Live send; if the gateway holds it, the header pill reads "Stuck at gateway · admitted, not seen by miner" with the elapsed time.
