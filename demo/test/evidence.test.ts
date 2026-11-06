import path from "node:path";
import { describe, expect, it } from "vitest";
import { evidenceDir, loadComparisonRuns, loadReplayRuns, loadSdkLiveRuns } from "../lib/evidence";
import { frameKinds, units } from "../lib/run";

const dir = evidenceDir(path.resolve(__dirname, "..", ".."));

describe("replay runs from docs/evidence", () => {
  const runs = loadComparisonRuns(dir);
  const [first, second] = runs;

  it("has a user's first transaction, then their second", () => {
    expect(runs.map((r) => r.mode)).toEqual(["bootstrap", "normal"]);
    expect(first!.sender).toBe(second!.sender);
  });

  it("shows the canonical mempool refusing and the alt-mempool admitting the same signed bytes", () => {
    for (const r of runs) {
      expect(r.canonical).toMatchObject({ method: "eth_sendRawTransaction", admitted: false });
      expect(r.canonical!.message).toContain("StorageReadNonSender");
      expect(r.alt).toMatchObject({ method: "eth_sendFrameTransaction", admitted: true, checksPassed: 24, checksTotal: 24 });
      expect(r.signed!.prefix.startsWith("0x06")).toBe(true);
    }
  });

  it("orders the frames and pairs each with its signed limits", () => {
    expect(first!.frames.map((f) => f.name)).toEqual(["verify", "validate", "approve", "settle", "call", "refund"]);
    expect(second!.frames.map((f) => f.name)).toEqual(["verify", "validate", "settle", "call", "refund"]);
    for (const f of runs.flatMap((r) => r.frames)) {
      expect(f.success).toBe(true);
      expect(BigInt(f.gasUsed)).toBeLessThanOrEqual(BigInt(f.gasLimit));
    }
    expect(first!.frames[2]).toMatchObject({ stateGasUsed: "97920", stateGasLimit: "97920" });
  });

  it("keeps quote below cap, and net below what settlement bought", () => {
    for (const r of runs) {
      expect(Number(r.cost.quote)).toBeLessThan(Number(r.cost.cap));
      expect(Number(r.cost.paid)).toBeLessThan(Number(r.cost.quote));
      expect(Number(r.cost.net)).toBeCloseTo(Number(r.cost.paid) - Number(r.cost.refunded), 6);
    }
    expect(first!.cost).toMatchObject({ cap: "4.000000", quote: "2.353233", paid: "2.249704", refunded: "0.301500" });
    expect(second!.cost).toMatchObject({ cap: "3.000000", quote: "1.636264" });
  });

  it("shows the sender with no ETH, and a balance that falls by the net cost plus the call", () => {
    expect(first!.balances).toMatchObject({ tokenBefore: "100.000000", eth: "0.000000000" });
    const before = Number(first!.balances.tokenBefore);
    const after = Number(first!.balances.tokenAfter);
    expect(before - after).toBeCloseTo(Number(first!.cost.net) + 1, 6);
    expect(first!.call).toMatch(/^Transfer 1\.00 fgUSD to 0x8943/);
  });

  it("leaves the paymaster's ETH up after each transaction", () => {
    for (const r of runs) expect(Number(r.paymaster.delta)).toBeGreaterThan(0);
  });
});

describe("helpers", () => {
  it("names frames for several calls", () => {
    expect(frameKinds("normal", 6)).toEqual(["verify", "validate", "settle", "call", "call", "refund"]);
  });
  it("formats signed amounts", () => {
    expect(units(-1_500_000n, 6)).toBe("-1.500000");
    expect(units(21_988_000_000_000n, 18, 9)).toBe("0.000021988");
  });
});

describe("current-deployment runs from scripts/08-sdk-live.ts", () => {
  const runs = loadSdkLiveRuns(dir);
  const [first, second] = runs;

  it("lists them first, before the 2026-11-05 pair", () => {
    expect(loadReplayRuns(dir).slice(0, 2).map((r) => r.hash)).toEqual(runs.map((r) => r.hash));
    expect(runs.map((r) => [r.mode, r.recordedAt])).toEqual([["bootstrap", "2026-11-06"], ["normal", "2026-11-06"]]);
  });

  it("counts admission checks from each transaction's own report, with the canonical refusal", () => {
    for (const r of runs) {
      expect(r.alt).toMatchObject({ checksPassed: 24, checksTotal: 24 });
      expect(r.alt.checksNote).toBeUndefined();
      expect(r.canonical).toMatchObject({ admitted: false });
      expect(r.canonical!.message).toContain("StorageReadNonSender");
    }
  });

  it("has two calls per transaction and a balance that carries from the first to the second", () => {
    expect(first!.frames.map((f) => f.name)).toEqual(["verify", "validate", "approve", "settle", "call", "call", "refund"]);
    expect(second!.frames.map((f) => f.name)).toEqual(["verify", "validate", "settle", "call", "call", "refund"]);
    expect(first!.balances.tokenBefore).toBe("100.000000");
    expect(first!.balances.tokenAfter).toBe(second!.balances.tokenBefore);
    expect(first!.cost).toMatchObject({ quote: "2.764176", paid: "2.643216", refunded: "0.310746" });
  });
});
