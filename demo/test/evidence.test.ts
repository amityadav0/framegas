import path from "node:path";
import { describe, expect, it } from "vitest";
import { evidenceDir, loadAdmissionReports, loadComparisonRuns } from "../lib/evidence";
import { frameNames } from "../lib/run";

const dir = evidenceDir(path.resolve(__dirname, "..", ".."));

describe("replay data from docs/evidence", () => {
  const runs = loadComparisonRuns(dir);

  it("has a first and a second transaction, in that order", () => {
    expect(runs.map((r) => r.mode)).toEqual(["bootstrap", "normal"]);
  });

  it("shows the canonical mempool refusing and the alt-mempool admitting the same bytes", () => {
    for (const r of runs) {
      expect(r.canonical?.admitted).toBe(false);
      expect(r.canonical?.message).toContain("StorageReadNonSender");
      expect(r.alt.admitted).toBe(true);
    }
  });

  it("reads what the user paid and got back from the paymaster's events", () => {
    for (const r of runs) {
      expect(Number(r.tokensPaid)).toBeGreaterThan(1);
      expect(Number(r.tokensRefunded)).toBeGreaterThan(0);
      expect(Number(r.netCost)).toBeLessThan(Number(r.tokensPaid));
    }
  });

  it("names every frame, with all of them successful", () => {
    const [first, second] = runs;
    expect(first!.frames.map((f) => f.name)).toEqual(["sender verify", "paymaster validate", "approve", "settle", "user call", "refund"]);
    expect(second!.frames.map((f) => f.name)).toEqual(["sender verify", "paymaster validate", "settle", "user call", "refund"]);
    expect(runs.flatMap((r) => r.frames).every((f) => f.success)).toBe(true);
  });

  it("charges the approve frame's new slot as state gas", () => {
    const approve = runs[0]!.frames.find((f) => f.name === "approve");
    expect(approve?.stateGasUsed).toBe("97920");
  });

  it("links a screenshot for each", () => {
    expect(runs.every((r) => r.screenshot?.endsWith("-summary.jpg"))).toBe(true);
  });
});

describe("saved admission reports", () => {
  const reports = loadAdmissionReports(dir);

  it("has both, with every check passed", () => {
    expect(reports.map((r) => r.label)).toEqual(["bootstrap", "normal"]);
    for (const r of reports) {
      expect(r.checks.length).toBe(24);
      expect(r.checks.every((c) => c.passed)).toBe(true);
      expect(r.screenshots.length).toBe(2);
    }
  });
});

describe("frameNames", () => {
  it("numbers several user calls", () => {
    expect(frameNames("normal", 6)).toEqual(["sender verify", "paymaster validate", "settle", "user call 1", "user call 2", "refund"]);
  });
});
