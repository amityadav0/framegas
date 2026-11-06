import { createFrameGas, type Chain, type RawSimulation } from "@framegas/sdk";
import { parseUnits, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { chainIsLive, sendLive } from "../lib/live";

const KEY: Hex = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const TOKEN = { symbol: "fgUSD", address: "0x601e8c20e53154778316bf7262b58475d8946680" as Address, decimals: 6 };
const PAYMASTER: Address = "0x031864db72e3343935bc863207db133f940fc4f8";

function gateway(opts: { balance?: bigint } = {}): Chain {
  const reads: Record<string, bigint> = {
    MIN_SETTLE_GAS: 150_000n, MIN_SETTLE_STATE_GAS: 0n, MIN_APPROVE_GAS: 30_000n, MIN_APPROVE_STATE_GAS: 97_920n,
    REFUND_GAS_ESTIMATE: 63_000n, REFUND_GAS_PER_FRAME: 5_500n,
    balanceOf: opts.balance ?? parseUnits("50", 6), allowance: parseUnits("50", 6), quote: parseUnits("1.6", 6),
  };
  const sim = (): RawSimulation => ({
    canonicalMempoolValid: false, canonicalMempoolViolation: "StorageReadNonSender", executionStatus: "success", executionError: null,
    frames: Array.from({ length: 5 }, () => ({ gasUsed: "0x4e20", succeeded: true })), gasUsed: "0x41eb0", maxCost: "0x24000000000000",
  });
  return {
    read: async <T,>(_t: Address, _a: unknown, fn: string) => reads[fn] as T,
    simulate: async () => sim(),
    rpc: async (method) => {
      if (method === "eth_getTransactionCount") return "0x0";
      if (method === "eth_getCode") return "0x";
      if (method === "eth_sendFrameTransaction") return "0xbeef";
      if (method === "eth_sendRawTransaction") throw new Error("Invalid params: Frame transaction validation-prefix simulation failed: StorageReadNonSender");
      if (method === "eth_getTransactionReceipt") return { status: "0x1", blockNumber: "0x30", gasUsed: "0x41eb0", effectiveGasPrice: "0x77359400", frameReceipts: [{ status: "0x1", gasUsed: "0x64", logs: [] }] };
      throw new Error(method);
    },
  };
}

const client = (chain: Chain) => createFrameGas({ privateKey: KEY, paymasters: { [TOKEN.address]: PAYMASTER }, chain, mineTimeoutMs: 1_000 });

describe("sendLive", () => {
  it("returns a run with both mempools' answers", async () => {
    const out = await sendLive(client(gateway()), TOKEN, "1");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.run).toMatchObject({ source: "live", mode: "normal", hash: "0xbeef" });
    expect(out.run.canonical).toMatchObject({ admitted: false });
    expect(out.run.explorerUrl).toContain("0xbeef");
  });

  it("turns an SDK error into a status and a readable message", async () => {
    const out = await sendLive(client(gateway({ balance: 1n })), TOKEN, "1");
    expect(out).toMatchObject({ ok: false, status: 422, error: { code: "INSUFFICIENT_BALANCE" } });
  });
});

describe("chainIsLive", () => {
  it("treats a recent block as live and a stale one as halted", () => {
    expect(chainIsLive(1_000, 1_060)).toBe(true);
    expect(chainIsLive(1793919526, 1793919526 + 4 * 3600)).toBe(false);
  });
});
