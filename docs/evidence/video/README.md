# Clips

| File | Length | What it shows |
| --- | --- | --- |
| [`framegas-replay-light.gif`](./framegas-replay-light.gif) | 89 s | The demo in Replay mode, light theme, recorded 2026-11-06. Tx 1, a bootstrap transaction from `scripts/08-sdk-live.ts` on the current deployment (`0x45fc…1dd3`, block 1213), stepped frame by frame from signed to mined; both mempool cards (canonical: `StorageReadNonSender`; alt-mempool: 24/24, block 1,213); then Tx 2, the same user's normal transaction (`0x08c4…b6b7`, block 1221), played through; then its explorer page, which shows it relayed to the miner over P2P and on chain. |
| [`framegas-sdk-live-terminal.gif`](./framegas-sdk-live-terminal.gif) | 30 s | `cat docs/evidence/sdk-live-output.txt`: the saved output of that `scripts/08-sdk-live.ts` run, printed line by line in a terminal-styled page. The script was not re-run for the clip. |

Both were captured from the browser as frames and assembled into GIFs; frame delays were set afterwards so the clips play at the lengths above. A Live-mode clip is pending: since 14:03 IST on 2026-11-06 the gateway admits FrameGas transactions without relaying them to the miner ([finding 28](../../findings.md#rule-drift)).
