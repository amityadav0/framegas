import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { budgetTool, describeError, quoteTool, sendTool, type ToolContext } from "./tools.js";

const call = z.object({
  to: z.string().describe("Contract or account to call"),
  data: z.string().optional().describe("Calldata, 0x-prefixed. Omit for a plain call"),
});
const payToken = z.string().describe('Token to pay gas in, by symbol (such as "fgUSD") or address');

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
      inputSchema: { payToken, calls: z.array(call).min(1) },
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
        maxTokenCost: z.string().describe('Most to pay, in token units, such as "2.5"'),
        calls: z.array(call).min(1),
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
      description: "Shows the account's token balance and allowance. Given calls, also how many transactions like them it can afford.",
      inputSchema: { payToken, calls: z.array(call).optional() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded((args: { payToken: string; calls?: { to: string; data?: string }[] }) => budgetTool(ctx, args)),
  );

  return server;
}
