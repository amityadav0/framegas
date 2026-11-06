#!/usr/bin/env -S npx tsx
/**
 * Runs the MCP server over stdio.
 *   FRAMEGAS_PRIVATE_KEY   devnet key the tools sign with
 *   FRAMEGAS_DEPLOYMENTS   path to deployments/devnet.json (defaults to the repo's)
 */
import fs from "node:fs";
import { createFrameGas } from "@framegas/sdk";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Address, Hex } from "viem";
import { createServer } from "./server.js";
import type { TokenInfo } from "./tools.js";

const key = process.env.FRAMEGAS_PRIVATE_KEY as Hex | undefined;
if (!key) {
  console.error("FRAMEGAS_PRIVATE_KEY is not set");
  process.exit(1);
}
const path = process.env.FRAMEGAS_DEPLOYMENTS ?? new URL("../../deployments/devnet.json", import.meta.url).pathname;
const deployment = JSON.parse(fs.readFileSync(path, "utf8")) as {
  paymasters?: Record<string, Address>;
  tokens?: Record<string, { address: Address; decimals: number; paymaster: Address }>;
};
const entries = Object.entries(deployment.tokens ?? {});
if (entries.length === 0) {
  console.error(`${path} lists no tokens. Run scripts/redeploy.sh`);
  process.exit(1);
}
const tokens: TokenInfo[] = entries.map(([symbol, t]) => ({ symbol, address: t.address, decimals: t.decimals }));
const framegas = createFrameGas({ privateKey: key, paymasters: Object.fromEntries(entries.map(([, t]) => [t.address, t.paymaster])) });

await createServer({ framegas, tokens }).connect(new StdioServerTransport());
console.error(`framegas MCP server ready, sender ${framegas.sender}, tokens ${tokens.map((t) => t.symbol).join(", ")}`);
