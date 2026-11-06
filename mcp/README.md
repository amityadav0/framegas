# @framegas/mcp

An MCP server (stdio) that lets an agent pay Ethereum gas in an ERC-20 through [FrameGas](https://github.com/amityadav0/framegas): EIP-8141 frame transactions, admitted by the ERC-8421 alt-mempool, with gas priced and bought on a Uniswap v4 pool. The signing key holds the token and no ETH. It runs on the alt-mempool devnet (chain 1337) only.

## Tools

| Tool | What it does | Sends? |
| --- | --- | --- |
| `framegas_quote` | Simulates the calls and returns `requiredTokens`, the smallest `maxTokenCost` the paymaster accepts, and whether this is the first transaction with that token (bootstrap, with an `approve` frame inside it) | No |
| `framegas_budget` | Returns the token balance, the allowance to the paymaster, any daily quota (`limit`, `spent`, `remaining`, `resetsAtBlock`), and whether a transaction like the given calls can be sent now | No |
| `framegas_send` | Signs and sends the calls, paying at most `maxTokenCost`; returns the hash, explorer link, net cost and gas per frame. With `compareMempools: true` it first sends the same bytes to the canonical mempool and records the rejection | Yes |

Amounts are decimal strings in token units, such as `"2.5"`. Failures come back as `{ error: { code, message, details } }`, for example `CAP_TOO_LOW` with `requiredTokens`, or `QUOTA_EXCEEDED` with `resetsAtBlock`.

## Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows), then restart Claude Desktop:

```json
{
  "mcpServers": {
    "framegas": {
      "command": "npx",
      "args": ["-y", "@framegas/mcp"],
      "env": {
        "FRAMEGAS_PRIVATE_KEY": "0x… a devnet-only key holding fgUSD and no ETH"
      }
    }
  }
}
```

If Claude Desktop cannot find `npx`, use the full path from `which npx`.

## Environment

| Variable | Required | Meaning |
| --- | --- | --- |
| `FRAMEGAS_PRIVATE_KEY` | Yes | The devnet key the tools sign with. Never use a key that holds real funds |
| `FRAMEGAS_GATEWAY` | No | The alt-mempool node to submit to. Defaults to the miner's own sidecar, <https://altmempool.forshtat.com/rpc>; set `https://altmempoolgateway.forshtat.com/rpc` to use the public gateway |
| `FRAMEGAS_DEPLOYMENTS` | No | Path to a deployments JSON with the token and paymaster addresses. Defaults to `@framegas/sdk/deployments/devnet.json`, the deployment current when the package was published |

By default the tools submit to the miner's sidecar; `FRAMEGAS_GATEWAY` selects the public gateway.

`npx -y @framegas/mcp --help` prints the same.

MIT licensed.
