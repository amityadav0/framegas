# Evidence

The devnet can be reset and its explorer keeps history in memory, so the links below may stop resolving. These files are the record.

## Current deployment (2026-11-06)

Deployed by `scripts/redeploy.sh --fresh --seed-eth 0.3` on the chain reset on 2026-11-06 (genesis `0x2ad3f67b…`). Addresses are in [`deployments/devnet.json`](../../deployments/devnet.json): token `0x1f9a…b908`, paymaster `0xf1c8…946f` (built with the quota code), pool tick −199248 at deployment, 5.47e13 active liquidity from 0.3 ETH.

### SDK end to end, both mempools

`scripts/08-sdk-live.ts`: one new user, zero ETH, two transactions with two `transfer` calls each, sent through `@framegas/sdk` with `compareMempools: true`. The same signed bytes went to the canonical mempool first, then the alt-mempool.

| Mode | Transaction | Block | Admission | Canonical mempool | Paid / refunded (fgUSD) |
| --- | --- | --- | --- | --- | --- |
| Bootstrap | [`0x45fc…1dd3`](https://explorer.altmempool.wtf/tx/0x45fcd889938d04890cedf379a8bd83e3e34b818a71ac7975b65c742eaa4e1dd3) | 1213 | 24 / 24 | Rejected: `StorageReadNonSender` | 2.643216 / 0.310746 |
| Normal | [`0x08c4…b6b7`](https://explorer.altmempool.wtf/tx/0x08c4836702188f61108cb21f7e0067ef07f2a47e7bc123ceda62cdcf1835b6b7) | 1221 | 24 / 24 | Rejected: `StorageReadNonSender` | 1.581221 / 0.196025 |

Files: `sdk-live-<mode>-<hash>.json` (admission report, receipt, canonical answer), `-summary.jpg` and `-frames.jpg` (explorer), and [`sdk-live.json`](./sdk-live.json) (the script's output). Every frame succeeded in both.

| Frame | Bootstrap gas used / limit | Normal gas used / limit |
| --- | --- | --- |
| sender verify | 100 / 200 | 100 / 200 |
| paymaster validate | 56,399 / 60,000 | 51,679 / 55,000 |
| approve | 14,472 / 30,000, +97,920 state | — |
| settle | 105,426 / 150,000 | 115,390 / 150,000 |
| call 0 (transfer) | 15,074 / 18,016 | 15,074 / 18,016 |
| call 1 (transfer to a new holder) | 15,074 / 18,016, +97,920 state | 15,074 / 18,016 |
| refund | 83,524 / 96,000 | 77,827 / 90,500 |

The bootstrap transaction's explorer page shows a "Revert reason: revalidation failed as of block 1212: Nonce mismatch: expected 1, got 0", and its timeline lists "Dropped, Cancelled" at 14:00:16.018, then "Included in a block, On chain" at 14:00:16.768. The receipt is in block 1213 with status 1. The mempool revalidated the transaction against a state where its own nonce was already used, and marked it dropped 0.75 s before reporting it included.

The first-ever tick crossing case was skipped: its thin-pool paymaster from `scripts/07-thin-pool.ts` does not exist on the reset chain.

Smoke tests from the redeploy, same deployment: [`0x7d59…c4ec`](https://explorer.altmempool.wtf/tx/0x7d597a50b7731a50bdf497196bbacc0b4b049e09339048a4ab5a78ae6ce9c4ec) (bootstrap, 3.104546 fgUSD net) and [`0xf46c…87c8`](https://explorer.altmempool.wtf/tx/0xf46c46ce7784c714c09e92e86b39593e67098564da2c15085da84160967587c8) (normal, 1.285609 fgUSD net).

### Video and clips

[`video/framegas-demo.mp4`](./video/framegas-demo.mp4): the submission video, 3:06, 1920×1080, recorded from the demo and a terminal following [`video/SHOTLIST.md`](./video/SHOTLIST.md). [`video/`](./video/README.md) also holds an 89 s Replay walkthrough of these two transactions and a 30 s terminal clip of the script's saved output.

### Console screenshots

The demo console at 3200×1800, in Replay mode on these two transactions:

| File | Shows |
| --- | --- |
| [`demo/console-signed-light.jpg`](./demo/console-signed-light.jpg) | Tx 2 (normal, `0x08c4…b6b7`) signed, not sent: frames pending, both mempool cards "Not sent", light theme |
| [`demo/console-bootstrap-light.jpg`](./demo/console-bootstrap-light.jpg) | Tx 1 (bootstrap, `0x45fc…1dd3`) mined: 10/10, every frame succeeded, canonical rejection and 24/24 admission, light theme |
| [`demo/console-normal-light.jpg`](./demo/console-normal-light.jpg) | Tx 2 (normal, `0x08c4…b6b7`), light theme |
| [`demo/console-normal-dark.jpg`](./demo/console-normal-dark.jpg) | Tx 2, dark theme |

### Quota

[`quota-live.json`](./quota-live.json): validation and settle gas with and without a quota, on the paymaster deployed before this redeploy (`0x2fc9…f8`), same chain.

## Earlier chain (2026-11-05)

The chain these were captured on was reset on 2026-11-06, so the explorer links no longer resolve.

### End-to-end transactions

Sender holds zero ETH. Each pair is one user's first transaction (bootstrap) and second (normal).

| Mode | Transaction | Files |
| --- | --- | --- |
| Bootstrap | `0x08a9…9bf7` | `bootstrap-0x08a9…-summary.jpg`, `-frames.jpg`, `.json` |
| Normal | `0xbd24…88e7` | `normal-0xbd24…-summary.jpg`, `-frames.jpg`, `.json` |

The explorer showed "Every rule passed" and 7 of 7 for each validation frame. The `.json` files hold the sidecar's full admission report, 24 of 24 checks for both, with the receipt.

### The same signed transaction in both mempools

These two transactions sent identical signed bytes to each mempool: the canonical one first, then the alternative one. The `signedRawTx` field holds the bytes.

| Mode | Transaction | Canonical mempool | Alt-mempool |
| --- | --- | --- | --- |
| Bootstrap | `0x2b73…a331` | Rejected: `StorageReadNonSender` | Admitted and mined |
| Normal | `0x6e76…4ff7` | Rejected: `StorageReadNonSender` | Admitted and mined |

Files: `mempool-comparison-<mode>-<hash>.json`, holding both responses and the receipt, and `-summary.jpg`. Their admission reports were not saved in time: the gateway restarted on 2026-11-06 and its explorer lost them. The explorer only records what reaches the sidecar, so the canonical rejection appears in the JSON and not on the page.

Repro: `scripts/04-end-to-end.ts`, `scripts/08-sdk-live.ts`.
