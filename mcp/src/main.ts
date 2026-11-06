#!/usr/bin/env node
/**
 * Runs the MCP server over stdio.
 *   FRAMEGAS_PRIVATE_KEY   devnet key the tools sign with
 *   FRAMEGAS_DEPLOYMENTS   path to a deployments JSON (defaults to the one shipped in @framegas/sdk)
 *   FRAMEGAS_GATEWAY       alt-mempool node to submit to (defaults to the miner's sidecar, DEFAULT_NODE_URL)
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import { createFrameGas, DEFAULT_NODE_URL } from "@framegas/sdk";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Address, Hex } from "viem";
import { createServer } from "./server.js";
import type { TokenInfo } from "./tools.js";

const usage = `framegas-mcp: MCP server (stdio) with the tools framegas_quote, framegas_budget and framegas_send.

Environment:
  FRAMEGAS_PRIVATE_KEY   devnet key the tools sign with (required)
  FRAMEGAS_DEPLOYMENTS   path to a deployments JSON (default: @framegas/sdk/deployments/devnet.json)
  FRAMEGAS_GATEWAY       alt-mempool node to submit to (default: the miner's sidecar, ${DEFAULT_NODE_URL})`;
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(usage);
  process.exit(0);
}

const key = process.env.FRAMEGAS_PRIVATE_KEY as Hex | undefined;
if (!key) {
  console.error(`FRAMEGAS_PRIVATE_KEY is not set\n\n${usage}`);
  process.exit(1);
}
const path = process.env.FRAMEGAS_DEPLOYMENTS ?? createRequire(import.meta.url).resolve("@framegas/sdk/deployments/devnet.json");
const deployment = JSON.parse(fs.readFileSync(path, "utf8")) as {
  paymasters?: Record<string, Address>;
  tokens?: Record<string, { address: Address; decimals: number; paymaster: Address }>;
};
const entries = Object.entries(deployment.tokens ?? {});
if (entries.length === 0) {
  console.error(`${path} lists no tokens. Set FRAMEGAS_DEPLOYMENTS to a deployment that lists tokens`);
  process.exit(1);
}
const tokens: TokenInfo[] = entries.map(([symbol, t]) => ({ symbol, address: t.address, decimals: t.decimals }));
const framegas = createFrameGas({ privateKey: key, gatewayUrl: process.env.FRAMEGAS_GATEWAY || undefined, paymasters: Object.fromEntries(entries.map(([, t]) => [t.address, t.paymaster])) });

await createServer({ framegas, tokens }).connect(new StdioServerTransport());
console.error(`framegas MCP server ready, sender ${framegas.sender}, tokens ${tokens.map((t) => t.symbol).join(", ")}`);
