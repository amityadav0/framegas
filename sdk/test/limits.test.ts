import { describe, expect, it } from "vitest";
import { deriveLimits, STATE_GAS_PER_SLOT, type Floors, type Limits, type Simulated } from "../src/limits.js";

const floors: Floors = { settle: { execution: 150_000n, state: 0n }, refund: { execution: 85_000n, state: 0n } };

/** A chain where a frame succeeds when it declares at least what it needs. */
function chain(needs: { settle?: { gas: bigint; state: bigint }; call?: { gas: bigint; state: bigint }; refundFails?: boolean; validationFails?: string }) {
  const seen: Limits[] = [];
  const simulate = async (l: Limits): Promise<Simulated> => {
    seen.push(l);
    if (needs.validationFails) return { maxCost: 0n, error: needs.validationFails };
    const settleNeed = needs.settle ?? { gas: 116_000n, state: 0n };
    const callNeed = needs.call ?? { gas: 15_000n, state: 0n };
    const settleOk = l.settle.execution >= settleNeed.gas && l.settle.state >= settleNeed.state;
    return {
      maxCost: 1n,
      frames: {
        settle: { succeeded: settleOk, gasUsed: settleOk ? settleNeed.gas : l.settle.execution },
        calls: l.calls.map((c) => {
          const ok = c.execution >= callNeed.gas && c.state >= callNeed.state;
          return { succeeded: ok, gasUsed: ok ? callNeed.gas : c.execution };
        }),
        refund: l.refund ? { succeeded: !needs.refundFails, gasUsed: 74_000n } : undefined,
      },
    };
  };
  return { simulate, seen };
}

describe("deriveLimits", () => {
  it("declares the floors when an ordinary transaction needs nothing more", async () => {
    const out = await deriveLimits(chain({}).simulate, floors, 1);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.limits.settle).toEqual({ execution: 150_000n, state: 0n });
    expect(out.limits.refund).toEqual(floors.refund);
    expect(out.warnings).toEqual([]);
  });

  it("tightens a call to what it used, with headroom", async () => {
    const out = await deriveLimits(chain({ call: { gas: 16_000n, state: 0n } }).simulate, floors, 1);
    if (!out.ok) throw new Error("expected success");
    expect(out.limits.calls[0]!.execution).toBeGreaterThan(16_000n);
    expect(out.limits.calls[0]!.execution).toBeLessThan(20_000n);
  });

  it("finds the state gas a first-ever crossing needs", async () => {
    const out = await deriveLimits(chain({ settle: { gas: 149_000n, state: 2n * STATE_GAS_PER_SLOT } }).simulate, floors, 1);
    if (!out.ok) throw new Error("expected success");
    expect(out.limits.settle.state).toBe(2n * STATE_GAS_PER_SLOT);
    expect(out.limits.settle.execution).toBeGreaterThanOrEqual(149_000n);
  });

  it("finds execution gas for several crossings", async () => {
    const out = await deriveLimits(chain({ settle: { gas: 190_000n, state: 4n * STATE_GAS_PER_SLOT } }).simulate, floors, 1);
    if (!out.ok) throw new Error("expected success");
    expect(out.limits.settle.execution).toBeGreaterThanOrEqual(190_000n);
    expect(out.limits.settle.state).toBe(4n * STATE_GAS_PER_SLOT);
  });

  it("finds the state gas a call needs for a new slot", async () => {
    const out = await deriveLimits(chain({ call: { gas: 30_000n, state: STATE_GAS_PER_SLOT } }).simulate, floors, 2);
    if (!out.ok) throw new Error("expected success");
    expect(out.limits.calls.map((c) => c.state)).toEqual([STATE_GAS_PER_SLOT, STATE_GAS_PER_SLOT]);
  });

  it("reports a pool that can never settle, rather than sending", async () => {
    const out = await deriveLimits(chain({ settle: { gas: 9_000_000n, state: 0n } }).simulate, floors, 1);
    expect(out).toMatchObject({ ok: false, reason: "SETTLEMENT" });
  });

  it("reports a call that reverts at every limit, and which one", async () => {
    const out = await deriveLimits(chain({ call: { gas: 9_000_000n, state: 0n } }).simulate, floors, 1);
    expect(out).toMatchObject({ ok: false, reason: "CALL", callIndex: 0 });
  });

  it("reports a validation failure without searching", async () => {
    const c = chain({ validationFails: "PoolTooThin" });
    const out = await deriveLimits(c.simulate, floors, 1);
    expect(out).toEqual({ ok: false, reason: "VALIDATION", error: "PoolTooThin" });
    expect(c.seen.length).toBe(1);
  });

  it("drops a refund that cannot succeed, and says so", async () => {
    const out = await deriveLimits(chain({ refundFails: true }).simulate, floors, 1);
    if (!out.ok) throw new Error("expected success");
    expect(out.limits.refund).toBeUndefined();
    expect(out.warnings[0]).toContain("refund");
  });

  it("gives a refund one new slot before dropping it, as the first refund on a pool needs", async () => {
    const simulate = async (l: Limits): Promise<Simulated> => ({
      maxCost: 1n,
      frames: {
        settle: { succeeded: true, gasUsed: 116_000n },
        calls: l.calls.map(() => ({ succeeded: true, gasUsed: 15_000n })),
        refund: l.refund ? { succeeded: l.refund.state >= STATE_GAS_PER_SLOT, gasUsed: 74_000n } : undefined,
      },
    });
    const out = await deriveLimits(simulate, floors, 1);
    if (!out.ok) throw new Error("expected success");
    expect(out.limits.refund?.state).toBe(STATE_GAS_PER_SLOT);
    expect(out.warnings).toEqual([]);
  });

  it("falls back to the searched limits when tightened ones fail", async () => {
    let calls = 0;
    const simulate = async (l: Limits): Promise<Simulated> => {
      calls++;
      const ok = calls === 1 || l.calls[0]!.execution >= 150_000n;
      return { maxCost: 1n, frames: { settle: { succeeded: true, gasUsed: 116_000n }, calls: [{ succeeded: ok, gasUsed: 15_000n }], refund: { succeeded: true, gasUsed: 74_000n } } };
    };
    const out = await deriveLimits(simulate, floors, 1);
    if (!out.ok) throw new Error("expected success");
    expect(out.limits.calls[0]!.execution).toBe(150_000n);
    expect(out.warnings.join()).toContain("tightened");
  });

  it("bounds the number of simulations", async () => {
    const c = chain({ settle: { gas: 9_000_000n, state: 0n } });
    await deriveLimits(c.simulate, floors, 1);
    expect(c.seen.length).toBeLessThanOrEqual(24);
  });
});
