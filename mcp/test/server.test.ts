import { createFrameGas, type Chain, type RawSimulation } from "@framegas/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { encodeErrorResult, parseUnits, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { paymasterAbi } from "@framegas/sdk";
import { createServer } from "../src/server.js";
import { resolveToken, type TokenInfo } from "../src/tools.js";

const KEY: Hex = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const TOKEN: Address = "0x601e8c20e53154778316bf7262b58475d8946680";
const PAYMASTER: Address = "0x031864db72e3343935bc863207db133f940fc4f8";
const TO = "0x8943545177806ED17B9F23F0a21ee5948eCaa776";
const tokens: TokenInfo[] = [{ symbol: "fgUSD", address: TOKEN, decimals: 6 }];

/** A gateway that answers like the devnet, recording what was sent. */
function gateway(opts: { balance?: bigint; allowance?: bigint; reject?: string; quota?: readonly [bigint, bigint, bigint] } = {}) {
  const sent: string[] = [];
  const reads: Record<string, bigint> = {
    MIN_SETTLE_GAS: 150_000n,
    MIN_SETTLE_STATE_GAS: 0n,
    MIN_APPROVE_GAS: 30_000n,
    MIN_APPROVE_STATE_GAS: 97_920n,
    REFUND_GAS_ESTIMATE: 63_000n,
    REFUND_GAS_PER_FRAME: 5_500n,
    balanceOf: opts.balance ?? parseUnits("10", 6),
    allowance: opts.allowance ?? 0n,
    quote: parseUnits("1.6", 6),
    epoch: 2n,
    epochStartBlock: 14_400n,
    EPOCH_BLOCKS: 7_200n,
  };
  const tuples: Record<string, readonly bigint[]> = { quotaOf: opts.quota ?? [0n, 0n, 2n ** 256n - 1n] };
  const simulation = (frames: number): RawSimulation => ({
    canonicalMempoolValid: false,
    canonicalMempoolViolation: "StorageReadNonSender",
    executionStatus: "success",
    executionError: null,
    frames: Array.from({ length: frames }, () => ({ gasUsed: "0x4e20", succeeded: true })),
    gasUsed: "0x41eb0",
    maxCost: "0x24000000000000",
  });
  const chain: Chain = {
    read: async <T,>(_to: Address, _abi: unknown, fn: string) => (tuples[fn] ?? reads[fn]) as T,
    simulate: async () => simulation(reads.allowance! >= parseUnits("2", 6) ? 5 : 6),
    rpc: async (method) => {
      sent.push(method);
      if (method === "eth_getTransactionCount") return "0x0";
      if (method === "eth_getCode") return "0x";
      if (method === "eth_sendFrameTransaction") {
        if (opts.reject) throw new Error(opts.reject);
        return "0xfeed";
      }
      if (method === "eth_sendRawTransaction") throw new Error("Frame transaction validation-prefix simulation failed: StorageReadNonSender");
      if (method === "eth_getTransactionReceipt") return { status: "0x1", blockNumber: "0x20", gasUsed: "0x41eb0", effectiveGasPrice: "0x77359400", frameReceipts: [] };
      throw new Error(`unexpected ${method}`);
    },
  };
  return { chain, sent };
}

async function connect(opts: Parameters<typeof gateway>[0] = {}) {
  const gw = gateway(opts);
  const framegas = createFrameGas({ privateKey: KEY, paymasters: { [TOKEN]: PAYMASTER }, chain: gw.chain, mineTimeoutMs: 1_000 });
  const server = createServer({ framegas, tokens });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { body: JSON.parse(res.content[0]!.text), isError: res.isError ?? false };
  };
  return { client, call, sent: gw.sent };
}

const calls = [{ to: TO, data: "0x" }];

describe("the MCP server", () => {
  it("lists exactly the three tools, marking which ones only read", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["framegas_budget", "framegas_quote", "framegas_send"]);
    expect(tools.find((t) => t.name === "framegas_quote")!.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "framegas_send")!.annotations?.destructiveHint).toBe(true);
  });

  it("quotes in token units and sends nothing", async () => {
    const { call, sent } = await connect();
    const { body, isError } = await call("framegas_quote", { payToken: "fgusd", calls });
    expect(isError).toBe(false);
    expect(body).toMatchObject({ token: "fgUSD", mode: "bootstrap", firstTransaction: true, requiredTokens: "1.6" });
    expect(sent).not.toContain("eth_sendFrameTransaction");
  });

  it("sends with a cap in token units and reports the result", async () => {
    const { call, sent } = await connect({ allowance: parseUnits("5", 6) });
    const { body, isError } = await call("framegas_send", { payToken: TOKEN, maxTokenCost: "2", calls });
    expect(isError).toBe(false);
    expect(body).toMatchObject({ success: true, mode: "normal", hash: "0xfeed" });
    expect(body.explorerUrl).toContain("0xfeed");
    expect(sent).toContain("eth_sendFrameTransaction");
  });

  it("includes the canonical mempool's refusal when asked", async () => {
    const { call } = await connect();
    const { body } = await call("framegas_send", { payToken: "fgUSD", maxTokenCost: "2", calls, compareMempools: true });
    expect(body.canonicalMempool.admitted).toBe(false);
  });

  it("returns a cap that is too low as a tool error carrying the amount needed", async () => {
    const { call, sent } = await connect();
    const { body, isError } = await call("framegas_send", { payToken: "fgUSD", maxTokenCost: "1", calls });
    expect(isError).toBe(true);
    expect(body.error.code).toBe("CAP_TOO_LOW");
    expect(body.error.details.requiredTokens).toBe("1600000");
    expect(sent).not.toContain("eth_sendFrameTransaction");
  });

  it("names the paymaster's error when the alt-mempool rejects", async () => {
    const data = encodeErrorResult({ abi: paymasterAbi, errorName: "PoolTooThin", args: [1n, 2n] });
    const { call } = await connect({ reject: `validation frame 1: reverted with data ${data}` });
    const { body, isError } = await call("framegas_send", { payToken: "fgUSD", maxTokenCost: "2", calls });
    expect(isError).toBe(true);
    expect(body.error).toMatchObject({ code: "REJECTED" });
    expect(body.error.message).toContain("PoolTooThin");
  });

  it("rejects an unknown token by name", async () => {
    const { call } = await connect();
    const { body, isError } = await call("framegas_quote", { payToken: "USDC", calls });
    expect(isError).toBe(true);
    expect(body.error.code).toBe("UNKNOWN_TOKEN");
    expect(body.error.message).toContain("fgUSD");
  });

  it("rejects a malformed address before anything is simulated", async () => {
    const { client, sent } = await connect();
    const res = (await client.callTool({ name: "framegas_quote", arguments: { payToken: "fgUSD", calls: [{ to: "0x123" }] } })) as { content: { text: string }[]; isError?: boolean };
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("20-byte address");
    expect(sent).toHaveLength(0);
  });

  it("reports balance and allowance, and how many transactions it covers", async () => {
    const { call } = await connect({ balance: parseUnits("10", 6) });
    const { body: plain } = await call("framegas_budget", { payToken: "fgUSD" });
    expect(plain).toMatchObject({ balance: "10", allowance: "0" });
    const { body } = await call("framegas_budget", { payToken: "fgUSD", calls });
    expect(body.canSendNow).toBe(true);
    expect(body.transactionsLikeThisAffordable).toBe(6);
  });
});

describe("resolveToken", () => {
  it("finds by symbol in any case, and by address", () => {
    expect(resolveToken(tokens, "FGUSD").address).toBe(TOKEN);
    expect(resolveToken(tokens, TOKEN.toUpperCase().replace("0X", "0x")).symbol).toBe("fgUSD");
  });
});

describe("schemas and quotas", () => {
  it("describes every input and constrains addresses and amounts", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    for (const t of tools) {
      const props = t.inputSchema.properties as Record<string, { description?: string }>;
      for (const [name, prop] of Object.entries(props)) expect(prop.description, `${t.name}.${name}`).toBeTruthy();
    }
    const send = tools.find((t) => t.name === "framegas_send")!;
    expect(send.inputSchema.required).toEqual(expect.arrayContaining(["payToken", "maxTokenCost", "calls"]));
    expect(JSON.stringify(send.inputSchema)).toContain("pattern");
  });

  it("refuses a malformed amount or address at the schema, before the SDK runs", async () => {
    const { client, sent } = await connect();
    const bad = (await client.callTool({ name: "framegas_send", arguments: { payToken: "fgUSD", maxTokenCost: "two", calls } })) as { isError?: boolean };
    expect(bad.isError).toBe(true);
    const badTo = (await client.callTool({ name: "framegas_quote", arguments: { payToken: "fgUSD", calls: [{ to: "0x1234" }] } })) as { isError?: boolean };
    expect(badTo.isError).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it("reports no quota by default", async () => {
    const { call } = await connect();
    const { body } = await call("framegas_budget", { payToken: "fgUSD" });
    expect(body.quota).toEqual({ active: false });
  });

  it("reports an active quota and says the next transaction cannot go when it is used up", async () => {
    const { call } = await connect({ allowance: parseUnits("50", 6), quota: [parseUnits("10", 6), parseUnits("9", 6), parseUnits("1", 6)] });
    const { body } = await call("framegas_budget", { payToken: "fgUSD" });
    expect(body.quota).toEqual({ active: true, limit: "10", spent: "9", remaining: "1", epoch: 2, resetsAtBlock: "21600" });
    const quoted = await call("framegas_quote", { payToken: "fgUSD", calls });
    expect(quoted.isError).toBe(true);
    expect(quoted.body.error.code).toBe("QUOTA_EXCEEDED");
  });
});
