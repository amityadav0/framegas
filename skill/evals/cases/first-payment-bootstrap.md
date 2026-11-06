# First Payment From a Zero-ETH Account

I have a fresh devnet account that holds 100 fgUSD and no ETH. It has never used
FrameGas. I want to send 5 fgUSD to `0x8943545177806ED17B9F23F0a21ee5948eCaa776`
and pay the gas in fgUSD.

## Context

- Devnet chain 1337, alt-mempool gateway `https://altmempoolgateway.forshtat.com/rpc`
- fgUSD and its paymaster are listed in `deployments/devnet.json`
- My key is in the `FRAMEGAS_PRIVATE_KEY` environment variable
- I use TypeScript with `@framegas/sdk` and viem

## Requirements

1. Plan every step, with the SDK calls I would make, from checking the account
   to reporting the result.
2. Explain what is different about this being my first transaction.
3. Do not execute anything; explain what I would run.
