# Evidence

The devnet can be reset and its explorer keeps history in memory, so the links below may stop resolving. These files are the record. All captured on 2026-11-05.

## End-to-end transactions

Sender holds zero ETH. Each pair is one user's first transaction (bootstrap) and second (normal).

| Mode | Transaction | Files |
| --- | --- | --- |
| Bootstrap | [`0x08a9…9bf7`](https://explorer.altmempool.wtf/tx/0x08a9d9386e14a428a3ba77a01719eec9be6f1fe7731608efa9d7140f974b9bf7) | `bootstrap-0x08a9…-summary.jpg`, `-frames.jpg`, `.json` |
| Normal | [`0xbd24…88e7`](https://explorer.altmempool.wtf/tx/0xbd24f1a8c1aaa9fe667e5640de154c922ef18e55346808915b14fd0feb3b88e7) | `normal-0xbd24…-summary.jpg`, `-frames.jpg`, `.json` |

The explorer shows "Every rule passed" and 7 of 7 for each validation frame. The `.json` files hold the sidecar's full admission report, 24 of 24 checks for both, with the receipt.

## The same signed transaction in both mempools

These two transactions sent identical signed bytes to each mempool: the canonical one first, then the alternative one. The `signedRawTx` field holds the bytes.

| Mode | Transaction | Canonical mempool | Alt-mempool |
| --- | --- | --- | --- |
| Bootstrap | [`0x2b73…a331`](https://explorer.altmempool.wtf/tx/0x2b733af2c4c763c06d0be508fe90adaf36503255876345c2469fb843baf8a331) | Rejected: `StorageReadNonSender` | Admitted and mined |
| Normal | [`0x6e76…4ff7`](https://explorer.altmempool.wtf/tx/0x6e76710d96c151e022a1807ab3ff6db9700f8fae517b2c7d03e95a2314654ff7) | Rejected: `StorageReadNonSender` | Admitted and mined |

Files: `mempool-comparison-<mode>-<hash>.json`, holding both responses and the receipt, and `-summary.jpg`. Their admission reports were not saved in time: the gateway restarted on 2026-11-06 and its explorer lost them. The screenshots show every rule passing. The explorer only records what reaches the sidecar, so the canonical rejection appears in the JSON and not on the page.

Repro: `scripts/04-end-to-end.ts`.
