/**
 * Works out what a transaction must declare, by simulating it. Frame limits are not knowable in advance: the same swap
 * can cross a tick, and a first-ever crossing writes new storage slots that cost state gas. The simulator reports only
 * whether each frame succeeded and its execution gas, so state gas is found by trying more of it.
 *
 * Declared limits also change what is simulated: they set the maximum cost, which sets how much ETH settlement buys,
 * which can change how many ticks it crosses. So the final limits are always simulated as a whole.
 */

/** Each new storage slot costs this much state gas on the devnet. */
export const STATE_GAS_PER_SLOT = 97_920n;

const MAX_SIMULATIONS = 24;
/** A nested call keeps back 1/64 of its gas, so a frame needs room above what it uses. */
const headroom = (used: bigint): bigint => used + used / 16n + 2_000n;

export interface FrameLimit {
  execution: bigint;
  state: bigint;
}

export interface Limits {
  settle: FrameLimit;
  calls: FrameLimit[];
  /** Absent when the refund cannot succeed for this transaction. */
  refund?: FrameLimit;
}

export interface Floors {
  settle: FrameLimit;
  /** A refund's limit is fixed by the contract's estimate, so it is not searched. */
  refund: FrameLimit;
}

export interface SimulatedFrame {
  succeeded: boolean;
  gasUsed: bigint;
}

export interface Simulated {
  /** Absent when the transaction would not get past validation. */
  frames?: { settle: SimulatedFrame; calls: SimulatedFrame[]; refund?: SimulatedFrame };
  maxCost: bigint;
  gasUsed?: bigint;
  error?: string;
}

export type Simulate = (limits: Limits) => Promise<Simulated>;

export type DeriveOutcome =
  | { ok: true; limits: Limits; simulated: Simulated; simulations: number; warnings: string[] }
  | { ok: false; reason: "VALIDATION"; error: string }
  | { ok: false; reason: "SETTLEMENT"; tried: FrameLimit[] }
  | { ok: false; reason: "CALL"; callIndex: number; tried: FrameLimit[] };

const copy = (l: Limits): Limits => ({ settle: { ...l.settle }, calls: l.calls.map((c) => ({ ...c })), refund: l.refund && { ...l.refund } });

/** State gas first, because it is what a first-ever crossing lacks, then execution gas for further crossings. */
function settleLadder(floor: FrameLimit): FrameLimit[] {
  const slots = [0n, 1n, 2n, 3n, 4n];
  const out: FrameLimit[] = slots.map((n) => ({ execution: floor.execution, state: floor.state + n * STATE_GAS_PER_SLOT }));
  for (const extra of [25_000n, 50_000n, 100_000n, 200_000n]) {
    for (const n of [2n, 4n]) out.push({ execution: floor.execution + extra, state: floor.state + n * STATE_GAS_PER_SLOT });
  }
  return out;
}

/** A call gets ample execution gas while searching, then is tightened to what it used. */
function callLadder(): FrameLimit[] {
  return [
    { execution: 150_000n, state: 0n },
    { execution: 150_000n, state: STATE_GAS_PER_SLOT },
    { execution: 150_000n, state: 2n * STATE_GAS_PER_SLOT },
    { execution: 400_000n, state: 2n * STATE_GAS_PER_SLOT },
  ];
}

export async function deriveLimits(simulate: Simulate, floors: Floors, callCount: number): Promise<DeriveOutcome> {
  const warnings: string[] = [];
  const settleSteps = settleLadder(floors.settle);
  const callSteps = callLadder();
  const callRung = Array.from({ length: callCount }, () => 0);
  let settleRung = 0;
  let refund: FrameLimit | undefined = floors.refund;
  let simulations = 0;

  const searching = (): Limits => ({ settle: settleSteps[settleRung]!, calls: callRung.map((r) => callSteps[r]!), refund });

  // Search upward until every frame succeeds.
  let found: Simulated | undefined;
  while (simulations < MAX_SIMULATIONS) {
    simulations++;
    const result = await simulate(searching());
    if (!result.frames) {
      // Searching raises the maximum cost, so a later failure means the limits needed cost more than validation allows.
      if (simulations > 1) return { ok: false, reason: "SETTLEMENT", tried: settleSteps };
      return { ok: false, reason: "VALIDATION", error: result.error ?? "the transaction would not pass validation" };
    }

    if (!result.frames.settle.succeeded) {
      if (settleRung + 1 >= settleSteps.length) return { ok: false, reason: "SETTLEMENT", tried: settleSteps };
      settleRung++;
      continue;
    }
    const failedCall = result.frames.calls.findIndex((c) => !c.succeeded);
    if (failedCall >= 0) {
      if (callRung[failedCall]! + 1 >= callSteps.length) return { ok: false, reason: "CALL", callIndex: failedCall, tried: callSteps };
      callRung[failedCall]!++;
      continue;
    }
    if (result.frames.refund && !result.frames.refund.succeeded) {
      // The first refund on a pool writes a new fee-growth slot. Until one succeeds, no refund on that pool can.
      if (refund && refund.state === 0n) {
        refund = { ...refund, state: STATE_GAS_PER_SLOT };
        continue;
      }
      refund = undefined;
      warnings.push("the refund would fail for this transaction, so it is left out and the unused gas is not returned");
      continue;
    }
    found = result;
    break;
  }
  if (!found?.frames) return { ok: false, reason: "SETTLEMENT", tried: settleSteps };

  // Tighten what the search over-declared. Execution gas comes down to what was used; state gas is already minimal.
  const searched = searching();
  const tight = copy(searched);
  found.frames.calls.forEach((c, i) => {
    tight.calls[i]!.execution = headroom(c.gasUsed);
  });
  const settleNeed = headroom(found.frames.settle.gasUsed);
  if (settleNeed > floors.settle.execution && settleNeed < tight.settle.execution) tight.settle.execution = settleNeed;
  if (settleNeed <= floors.settle.execution) tight.settle.execution = floors.settle.execution;

  simulations++;
  const final = await simulate(tight);
  const finalOk =
    final.frames?.settle.succeeded && final.frames.calls.every((c) => c.succeeded) && (!final.frames.refund || final.frames.refund.succeeded);
  if (finalOk) return { ok: true, limits: tight, simulated: final, simulations, warnings };

  // A lower reserve changes the swap, and that rarely changes what it needs. The searched limits are known to work.
  warnings.push("tightened limits failed in simulation, so the transaction declares the larger limits it was found with");
  return { ok: true, limits: searched, simulated: found, simulations, warnings };
}
