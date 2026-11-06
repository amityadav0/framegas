import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { budgetTool, describeError, quoteTool, sendTool, type ToolContext } from "./tools.js";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "a 0x-prefixed 20-byte address");
const call = z.object({
  to: address.describe("Contract or account to call, 0x-prefixed 20-byte address"),
  data: z
    .string()
    .regex(/^0x([0-9a-fA-F]{2})*$/, "0x-prefixed hex with whole bytes")
    .optional()
    .describe("ABI-encoded calldata, 0x-prefixed. Omit for a call with no data. Calls cannot carry ETH"),
});
const calls = z.array(call).min(1).max(8).describe("Calls run in order, each in its own frame, after gas is paid");
const payToken = z.string().min(1).describe('Token to pay gas in, by symbol (such as "fgUSD") or address. Must have a FrameGas paymaster');
const tokenAmount = z.string().regex(/^\d+(\.\d+)?$/, 'a decimal amount in token units, such as "2.5"');

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });

/** Wraps a tool so a failure comes back as a readable result the agent can act on, not a protocol error. */
const guarded =
  <A>(run: (args: A) => Promise<unknown>) =>
  async (args: A) => {
    try {
      return json(await run(args));
    } catch (e) {
      return { ...json({ error: describeError(e) }), isError: true };
    }
  };

export function createServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: "framegas", version: "0.1.0" });

  server.registerTool(
    "framegas_quote",
    {
      title: "Quote a gas-in-token transaction",
      description:
        "Works out what a transaction would cost in a token, by simulating it. Sends nothing. Returns requiredTokens, the smallest maxTokenCost the paymaster accepts, and whether this is the user's first transaction with that token.",
      inputSchema: { payToken, calls },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded((args: { payToken: string; calls: { to: string; data?: string }[] }) => quoteTool(ctx, args)),
  );

  server.registerTool(
    "framegas_send",
    {
      title: "Send a transaction, paying gas in a token",
      description:
        "Sends the calls as one EIP-8141 frame transaction, paying gas in the token, from an account that holds no ETH. The user never pays more than maxTokenCost. Simulates first and sends nothing if a call would revert. Quote first to choose maxTokenCost.",
      inputSchema: {
        payToken,
        maxTokenCost: tokenAmount.describe('Most the user pays, in token units, such as "2.5". At least requiredTokens from framegas_quote, at most the balance and any quota remaining'),
        calls,
        compareMempools: z.boolean().optional().describe("Also submit to the canonical mempool first, to show it refuses"),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    guarded((args: { payToken: string; maxTokenCost: string; calls: { to: string; data?: string }[]; compareMempools?: boolean }) => sendTool(ctx, args)),
  );

  server.registerTool(
    "framegas_budget",
    {
      title: "Check what the account can pay for",
      description:
        "Shows the account's token balance, its allowance to the paymaster and its opt-in spending quota (limit, spent and remaining this epoch, and the block it can reset from). Given calls, also whether the next one can be sent now and how many like it the balance covers.",
      inputSchema: { payToken, calls: calls.optional() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded((args: { payToken: string; calls?: { to: string; data?: string }[] }) => budgetTool(ctx, args)),
  );

  return server;
}
