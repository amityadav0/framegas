import { encodeErrorResult, encodeFunctionData, getAddress, parseAbi, parseUnits, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { paymasterAbi } from "../src/abi.js";
import type { Chain, RawSimulation } from "../src/chain.js";
import { createFrameGas } from "../src/client.js";
import { decodePaymasterError, FrameGasError } from "../src/errors.js";

const KEY: Hex = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const TOKEN: Address = "0x601e8c20e53154778316bf7262b58475d8946680";
const PAYMASTER: Address = "0x031864db72e3343935bc863207db133f940fc4f8";
const TO: Address = "0x8943545177806ED17B9F23F0a21ee5948eCaa776";
const CALL = { to: TO, data: encodeFunctionData({ abi: parseAbi(["function ping()"]), functionName: "ping" }) };

interface World {
  balance?: bigint;
  allowance?: bigint;
  quote?: bigint;
  simulate?: (raw: Hex) => RawSimulation;
  reject?: string;
  /** How many frame receipts the mined transaction has. */
  mined?: number;
}

const good = (frameCount: number): RawSimulation => ({
  canonicalMempoolValid: false,
  canonicalMempoolViolation: "StorageReadNonSender",
  executionStatus: "success",
  executionError: null,
  frames: Array.from({ length: frameCount }, () => ({ gasUsed: "0x4e20", succeeded: true })),
  gasUsed: "0x41eb0",
  maxCost: "0x24000000000000",
});

function world(w: World) {
  const sent: string[] = [];
  const reads: Record<string, bigint> = {
    MIN_SETTLE_GAS: 150_000n,
    MIN_SETTLE_STATE_GAS: 0n,
    MIN_APPROVE_GAS: 30_000n,
    MIN_APPROVE_STATE_GAS: 97_920n,
    REFUND_GAS_ESTIMATE: 63_000n,
    REFUND_GAS_PER_FRAME: 5_500n,
    balanceOf: w.balance ?? parseUnits("100", 6),
    allowance: w.allowance ?? 0n,
    quote: w.quote ?? parseUnits("1.6", 6),
  };
  const simulated: Hex[] = [];
  const chain: Chain = {
    read: async <T,>(_to: Address, _abi: unknown, fn: string) => reads[fn] as T,
    simulate: async (raw) => {
      simulated.push(raw);
      return w.simulate ? w.simulate(raw) : good(reads.allowance! >= parseUnits("5", 6) ? 5 : 6);
    },
    rpc: async (method) => {
      sent.push(method);
      if (method === "eth_getTransactionCount") return "0x0";
      if (method === "eth_getCode") return "0x";
      if (method === "eth_sendFrameTransaction") {
        if (w.reject) throw new Error(w.reject);
        return "0xabc";
      }
      if (method === "eth_sendRawTransaction") throw new Error("Frame transaction validation-prefix simulation failed: StorageReadNonSender");
      if (method === "eth_getTransactionReceipt") {
        return { status: "0x1", blockNumber: "0x10", gasUsed: "0x41eb0", effectiveGasPrice: "0x77359400", frameReceipts: Array.from({ length: w.mined ?? 0 }, () => ({ status: "0x1", gasUsed: "0x64", logs: [] })) };
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  const client = createFrameGas({ privateKey: KEY, paymasters: { [TOKEN]: PAYMASTER }, chain, mineTimeoutMs: 1_000 });
  return { client, sent, simulated };
}

const cap = parseUnits("5", 6);
const expectCode = async (p: Promise<unknown>, code: string) => {
  const error = await p.then(() => undefined, (e) => e);
  expect(error).toBeInstanceOf(FrameGasError);
  expect((error as FrameGasError).code).toBe(code);
  return error as FrameGasError;
};

describe("send", () => {
  it("detects a first transaction from the allowance, and sends an approve frame", async () => {
    const { client } = world({ allowance: 0n });
    const out = await client.send({ payToken: TOKEN, maxTokenCost: cap, calls: [CALL] });
    expect(out.mode).toBe("bootstrap");
  });

  it("reports every frame's declared limits next to what it used", async () => {
    const { client } = world({ allowance: 0n, mined: 6 });
    const out = await client.send({ payToken: TOKEN, maxTokenCost: cap, calls: [CALL] });
    expect(out.frames.map((f) => f.name)).toEqual(["sender verify", "paymaster validate", "approve", "settle", "call 0", "refund"]);
    expect(out.frames[0]!.gasLimit).toBe(200n);
    expect(out.frames[1]!.gasLimit).toBe(54_000n);
    expect(out.frames[2]).toMatchObject({ gasLimit: 30_000n, stateGasLimit: 97_920n });
    expect(out.frames.every((f) => f.gasLimit > 0n)).toBe(true);
  });

  it("uses normal mode when the allowance covers the cap", async () => {
    const { client } = world({ allowance: cap });
    const out = await client.send({ payToken: TOKEN, maxTokenCost: cap, calls: [CALL] });
    expect(out.mode).toBe("normal");
  });

  it("uses bootstrap mode when an allowance has run down below the cap", async () => {
    const { client } = world({ allowance: cap - 1n });
    const out = await client.send({ payToken: TOKEN, maxTokenCost: cap, calls: [CALL] });
    expect(out.mode).toBe("bootstrap");
  });

  it("simulates before it broadcasts", async () => {
    const { client, sent, simulated } = world({});
    await client.send({ payToken: TOKEN, maxTokenCost: cap, calls: [CALL] });
    expect(simulated.length).toBeGreaterThan(0);
    expect(sent).toContain("eth_sendFrameTransaction");
  });

  it("does not touch the canonical mempool unless asked", async () => {
    const { client, sent } = world({});
    await client.send({ payToken: TOKEN, maxTokenCost: cap, calls: [CALL] });
    expect(sent).not.toContain("eth_sendRawTransaction");
  });

  it("records the canonical mempool's answer when asked", async () => {
    const { client } = world({});
    const out = await client.send({ payToken: TOKEN, maxTokenCost: cap, calls: [CALL], compareMempools: true });
    expect(out.canonicalMempool).toMatchObject({ admitted: false });
    expect(out.canonicalMempool!.message).toContain("StorageReadNonSender");
  });

  it("refuses a cap below what the transaction needs, and says how much it needs, without sending", async () => {
    const { client, sent } = world({ quote: parseUnits("6", 6), balance: parseUnits("100", 6) });
    const error = await expectCode(client.send({ payToken: TOKEN, maxTokenCost: cap, calls: [CALL] }), "CAP_TOO_LOW");
    expect(error.details.requiredTokens).toBe(parseUnits("6", 6));
    expect(sent).not.toContain("eth_sendFrameTransaction");
  });

  it("refuses a cap above the balance", async () => {
    const { client } = world({ balance: cap - 1n });
    await expectCode(client.send({ payToken: TOKEN, maxTokenCost: cap, calls: [CALL] }), "INSUFFICIENT_BALANCE");
  });

  it("refuses a token with no paymaster", async () => {
    const { client } = world({});
    await expectCode(client.send({ payToken: TO, maxTokenCost: cap, calls: [CALL] }), "UNKNOWN_TOKEN");
  });

  it("refuses a call carrying ETH", async () => {
    const { client } = world({});
    await expectCode(client.send({ payToken: TOKEN, maxTokenCost: cap, calls: [{ ...CALL, value: 1n }] }), "VALUE_NOT_SUPPORTED");
  });

  it("refuses an empty call list", async () => {
    const { client } = world({});
    await expectCode(client.send({ payToken: TOKEN, maxTokenCost: cap, calls: [] }), "NO_CALLS");
  });

  it("does not send a call that reverts at every limit", async () => {
    const reverting = (): RawSimulation => {
      const g = good(6);
      g.frames![4]!.succeeded = false;
      return g;
    };
    const { client, sent } = world({ simulate: reverting });
    await expectCode(client.send({ payToken: TOKEN, maxTokenCost: cap, calls: [CALL] }), "CALL_WILL_REVERT");
    expect(sent).not.toContain("eth_sendFrameTransaction");
  });

  it("does not send when settlement fails at every limit", async () => {
    const failing = (): RawSimulation => {
      const g = good(6);
      g.frames![3]!.succeeded = false;
      return g;
    };
    const { client, sent } = world({ simulate: failing });
    await expectCode(client.send({ payToken: TOKEN, maxTokenCost: cap, calls: [CALL] }), "SETTLEMENT_WILL_FAIL");
    expect(sent).not.toContain("eth_sendFrameTransaction");
  });

  it("names the paymaster error when the alt-mempool rejects", async () => {
    const data = encodeErrorResult({ abi: paymasterAbi, errorName: "PoolTooThin", args: [1n, 2n] });
    const { client } = world({ reject: `validation frame 1: reverted with data ${data}` });
    const error = await expectCode(client.send({ payToken: TOKEN, maxTokenCost: cap, calls: [CALL] }), "REJECTED");
    expect(error.message).toContain("PoolTooThin");
  });
});

describe("quote", () => {
  it("sends nothing", async () => {
    const { client, sent } = world({});
    const q = await client.quote({ payToken: TOKEN, calls: [CALL] });
    expect(q.requiredTokens).toBe(parseUnits("1.6", 6));
    expect(sent).not.toContain("eth_sendFrameTransaction");
    expect(sent).not.toContain("eth_sendRawTransaction");
  });

  it("reports the mode the transaction would use", async () => {
    expect((await world({ allowance: 0n }).client.quote({ payToken: TOKEN, calls: [CALL] })).mode).toBe("bootstrap");
    expect((await world({ allowance: parseUnits("100", 6) }).client.quote({ payToken: TOKEN, calls: [CALL] })).mode).toBe("normal");
  });
});

describe("account", () => {
  it("reports balance and allowance for the token's paymaster", async () => {
    const a = await world({ balance: 7n, allowance: 3n }).client.account(TOKEN);
    expect(a).toMatchObject({ balance: 7n, allowance: 3n, paymaster: getAddress(PAYMASTER) });
  });
});

describe("quote with a partial allowance", () => {
  it("reports normal mode when the allowance covers what is needed", async () => {
    const q = await world({ allowance: parseUnits("3", 6), balance: parseUnits("100", 6) }).client.quote({ payToken: TOKEN, calls: [CALL] });
    expect(q.mode).toBe("normal");
  });

  it("reports bootstrap mode when it does not", async () => {
    const q = await world({ allowance: parseUnits("1", 6), balance: parseUnits("100", 6) }).client.quote({ payToken: TOKEN, calls: [CALL] });
    expect(q.mode).toBe("bootstrap");
  });
});

describe("decodePaymasterError", () => {
  it("decodes the sidecar's revert data", () => {
    const data = encodeErrorResult({ abi: paymasterAbi, errorName: "SettleNotBound" });
    expect(decodePaymasterError(`validation frame 1: reverted with data ${data}`)?.name).toBe("SettleNotBound");
  });

  it("leaves other messages alone", () => {
    expect(decodePaymasterError("unstaked payer accessed payer slot 0x00")).toBeUndefined();
  });
});
