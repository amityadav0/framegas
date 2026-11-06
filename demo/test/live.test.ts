import { createFrameGas, type Chain, type RawSimulation } from "@framegas/sdk";
import { parseUnits, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { chainIsLive, collectLive, quoteLive, sendLive, submitLive } from "../lib/live";
import { presetCalls, type PresetContext } from "../lib/presets";

const KEY: Hex = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const PAYMASTER: Address = "0x031864db72e3343935bc863207db133f940fc4f8";
const CTX: PresetContext = {
  sender: "0x2a6b302fFa8c176315306Fb678C0f3A8FAD120bf",
  token: { symbol: "fgUSD", address: "0x601e8c20e53154778316bf7262b58475d8946680", decimals: 6, fee: 3000, tickSpacing: 60 },
  demo: { swapRouter: "0x1111111111111111111111111111111111111111", lendingPool: "0x2222222222222222222222222222222222222222" },
};

/** A mocked gateway: normal mode, two calls, every frame succeeds, the canonical mempool refuses. */
function gateway(opts: { balance?: bigint; receiptDelay?: number } = {}): Chain {
  let delay = opts.receiptDelay ?? 0;
  const reads: Record<string, bigint> = {
    MIN_SETTLE_GAS: 150_000n, MIN_SETTLE_STATE_GAS: 0n, MIN_APPROVE_GAS: 30_000n, MIN_APPROVE_STATE_GAS: 97_920n,
    REFUND_GAS_ESTIMATE: 63_000n, REFUND_GAS_PER_FRAME: 5_500n,
    balanceOf: opts.balance ?? parseUnits("50", 6), allowance: parseUnits("50", 6), quote: parseUnits("1.6", 6),
  };
  const sim = (): RawSimulation => ({
    canonicalMempoolValid: false, canonicalMempoolViolation: "StorageReadNonSender", executionStatus: "success", executionError: null,
    frames: Array.from({ length: 6 }, () => ({ gasUsed: "0x4e20", succeeded: true })), gasUsed: "0x41eb0", maxCost: "0x24000000000000",
  });
  return {
    read: async <T,>(_t: Address, _a: unknown, fn: string) => reads[fn] as T,
    simulate: async () => sim(),
    rpc: async (method) => {
      if (method === "eth_getTransactionCount") return "0x0";
      if (method === "eth_getCode") return "0x";
      if (method === "eth_getBalance") return "0x0";
      if (method === "eth_sendFrameTransaction") return "0xbeef";
      if (method === "eth_sendRawTransaction") throw new Error("Invalid params: Frame transaction validation-prefix simulation failed: StorageReadNonSender");
      if (method === "skandha_explorer_getTransaction") return { admission: { checks: Array.from({ length: 24 }, () => ({ verdict: "pass" })) } };
      if (method === "eth_getTransactionReceipt") {
        if (delay-- > 0) return null;
        return { status: "0x1", blockNumber: "0x30", gasUsed: "0x41eb0", effectiveGasPrice: "0x77359400", frameReceipts: Array.from({ length: 6 }, () => ({ status: "0x1", gasUsed: "0x64", logs: [] })) };
      }
      throw new Error(method);
    },
  };
}

const client = (chain: Chain) => createFrameGas({ privateKey: KEY, paymasters: { [CTX.token.address]: PAYMASTER }, chain, mineTimeoutMs: 1_000 });

describe("sendLive", () => {
  it("returns a run with both mempools' answers, frame limits and the admission count", async () => {
    const chain = gateway();
    const out = await sendLive(client(chain), chain, CTX, "swap", parseUnits("2", 6));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const run = out.value;
    expect(run).toMatchObject({ source: "live", mode: "normal", hash: "0xbeef", call: "Swap 5 fgUSD → ETH" });
    expect(run.canonical).toMatchObject({ method: "eth_sendRawTransaction", admitted: false });
    expect(run.alt).toMatchObject({ admitted: true, checksPassed: 24, checksTotal: 24 });
    expect(run.frames.map((f) => f.kind)).toEqual(["verify", "validate", "settle", "call", "call", "refund"]);
    expect(run.frames.every((f) => BigInt(f.gasLimit) > 0n)).toBe(true);
    expect(run.cost).toMatchObject({ cap: "2.000000", quote: "1.600000" });
    expect(run.balances.eth).toBe("0.000000000");
  });

  it("turns an SDK error into a status and a readable message", async () => {
    const chain = gateway({ balance: 1n });
    const out = await sendLive(client(chain), chain, CTX, "supply", parseUnits("2", 6));
    expect(out).toMatchObject({ ok: false, status: 422, error: { code: "INSUFFICIENT_BALANCE" } });
  });
});

describe("quoteLive", () => {
  it("prefills the cap 2% above the quote", async () => {
    const out = await quoteLive(client(gateway()), CTX, "supply");
    expect(out).toEqual({ ok: true, value: { mode: "normal", quote: "1.600000", cap: "1.632000" } });
  });
});

describe("presets", () => {
  it("approves the target for exactly 5 tokens, then calls it", () => {
    for (const id of ["swap", "supply"] as const) {
      const { calls } = presetCalls(id, CTX);
      expect(calls).toHaveLength(2);
      expect(calls[0]!.to).toBe(CTX.token.address);
      expect(calls[0]!.data!.endsWith((5_000_000).toString(16).padStart(64, "0"))).toBe(true);
    }
  });

  it("says to redeploy when the demo contracts are missing", () => {
    expect(() => presetCalls("swap", { ...CTX, demo: {} })).toThrow(/redeploy/);
  });
});

describe("chainIsLive", () => {
  it("treats a recent block as live and a stale one as halted", () => {
    expect(chainIsLive(1_000, 1_060)).toBe(true);
    expect(chainIsLive(1793919526, 1793919526 + 4 * 3600)).toBe(false);
  });
});

describe("pendingState", () => {
  it("names where an admitted transaction is", async () => {
    const { pendingState } = await import("../lib/live");
    expect(pendingState({ receiptBlock: 1221, gatewayHasEntry: false, minerSeen: true })).toEqual({ state: "mined", block: 1221 });
    expect(pendingState({ gatewayHasEntry: true, minerSeen: false, admittedAt: 5 })).toEqual({ state: "stuck-at-gateway", admittedAt: 5 });
    expect(pendingState({ gatewayHasEntry: true, minerSeen: true })).toMatchObject({ state: "relayed" });
    expect(pendingState({ gatewayHasEntry: false, minerSeen: false })).toMatchObject({ state: "dropped" });
  });
});

describe("submitLive and collectLive", () => {
  it("hands off as soon as the alt-mempool admits, and collects the same run later from JSON", async () => {
    const chain = gateway({ receiptDelay: 1 });
    const fg = client(chain);
    const sub = await submitLive(fg, chain, CTX, "swap", parseUnits("2", 6), parseUnits("1.6", 6));
    expect(sub.ok).toBe(true);
    if (!sub.ok) return;
    expect(sub.value).toMatchObject({ hash: "0xbeef", call: "Swap 5 fgUSD → ETH", canonical: { admitted: false }, quote: "1600000", cap: "2000000" });
    expect(typeof sub.value.submittedAt).toBe("number");

    // What the browser sends back is what it received, after a JSON round trip.
    const handoff = JSON.parse(JSON.stringify(sub.value));
    const first = await collectLive(fg, chain, CTX, handoff, 0);
    expect(first).toEqual({ ok: true, value: null });

    const second = await collectLive(fg, chain, CTX, handoff, 0);
    expect(second.ok).toBe(true);
    if (!second.ok || !second.value) return;
    expect(second.value).toMatchObject({ source: "live", hash: "0xbeef", call: "Swap 5 fgUSD → ETH", block: 48 });
    expect(second.value.canonical).toMatchObject({ method: "eth_sendRawTransaction", admitted: false });
    expect(second.value.alt).toMatchObject({ admitted: true, checksPassed: 24, checksTotal: 24 });
    expect(second.value.cost).toMatchObject({ cap: "2.000000", quote: "1.600000" });
    expect(second.value.frames.every((f) => BigInt(f.gasLimit) > 0n)).toBe(true);
  });
});
