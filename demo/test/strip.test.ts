import { describe, expect, it } from "vitest";
import {
  frameStatus,
  hasRun,
  initialStrip,
  mempoolsAnswered,
  mined,
  stageLabel,
  stepOf,
  stripReducer,
  type StripAction,
  type StripState,
} from "../lib/strip";

const run = (s: StripState, ...actions: StripAction[]) => actions.reduce(stripReducer, s);
const loaded = (outcomes = [true, true, true, true, true]) => run(initialStrip, { type: "load", outcomes });
const statuses = (s: StripState) => s.outcomes.map((_, i) => frameStatus(s, i));
const NAMES = ["verify", "validate", "settle", "call", "refund"];

describe("frame strip", () => {
  it("starts signed, with nothing sent and every frame pending", () => {
    const s = loaded();
    expect(s.position).toBe(-1);
    expect(mempoolsAnswered(s)).toBe(false);
    expect(mined(s)).toBe(false);
    expect(statuses(s).every((x) => x === "pending")).toBe(true);
    expect(stageLabel(s, NAMES)).toBe("Signed, not sent");
  });

  it("shows both mempools' answers before any frame runs", () => {
    const s = run(loaded(), { type: "next" });
    expect(mempoolsAnswered(s)).toBe(true);
    expect(statuses(s).every((x) => x === "pending")).toBe(true);
    expect(stageLabel(s, NAMES)).toBe("Sent to both mempools");
  });

  it("lights frames in order: the latest is current, earlier ones are done", () => {
    const s = run(loaded(), { type: "next" }, { type: "next" }, { type: "next" }, { type: "next" });
    expect(statuses(s)).toEqual(["ok", "ok", "current", "pending", "pending"]);
    expect(hasRun(s, 2)).toBe(true);
    expect(hasRun(s, 3)).toBe(false);
    expect(stageLabel(s, NAMES)).toBe("Frame 2 settle executed");
  });

  it("ends mined with every frame done, and does not step past the end", () => {
    let s = loaded();
    for (let i = 0; i < 20; i++) s = stripReducer(s, { type: "next" });
    expect(s.position).toBe(6);
    expect(mined(s)).toBe(true);
    expect(statuses(s).every((x) => x === "ok")).toBe(true);
    expect(stageLabel(s, NAMES)).toBe("Mined, every frame succeeded");
    expect(stepOf(s)).toEqual({ step: 8, of: 8 });
  });

  it("marks a failed frame, and says so once mined", () => {
    const s = run(loaded([true, true, false, true, true]), { type: "end" });
    expect(statuses(s)).toEqual(["ok", "ok", "failed", "ok", "ok"]);
    expect(stageLabel(s, NAMES)).toBe("Mined, a frame failed");
    const mid = run(loaded([true, true, false, true, true]), { type: "next" }, { type: "next" }, { type: "next" }, { type: "next" });
    expect(stageLabel(mid, NAMES)).toBe("Frame 2 settle failed");
  });

  it("steps back to signed and no further", () => {
    const s = run(loaded(), { type: "next" }, { type: "next" }, { type: "prev" }, { type: "prev" }, { type: "prev" });
    expect(s.position).toBe(-1);
  });

  it("stops playing at the end, and starts over when played again", () => {
    let s = run(loaded([true, true]), { type: "play" });
    expect(s.playing).toBe(true);
    while (s.playing) s = stripReducer(s, { type: "next" });
    expect(mined(s)).toBe(true);
    s = stripReducer(s, { type: "play" });
    expect(s).toMatchObject({ position: -1, playing: true });
  });

  it("stops playing when stepped back or paused", () => {
    expect(run(loaded(), { type: "play" }, { type: "next" }, { type: "prev" }).playing).toBe(false);
    expect(run(loaded(), { type: "play" }, { type: "pause" }).playing).toBe(false);
  });

  it("ignores steps with nothing loaded", () => {
    expect(run(initialStrip, { type: "next" }, { type: "end" }, { type: "play" })).toEqual(initialStrip);
    expect(stageLabel(initialStrip, [])).toBe("No transaction loaded");
  });

  it("clears the strip while a live send is in flight, then plays the result", () => {
    const sending = run(loaded(), { type: "end" }, { type: "sending" });
    expect(sending).toMatchObject({ outcomes: [], position: -1, sending: true });
    expect(stageLabel(sending, [])).toBe("Simulating, signing and submitting");
    const done = stripReducer(sending, { type: "load", outcomes: [true, true, true], play: true });
    expect(done).toMatchObject({ sending: false, playing: true, position: -1 });
    expect(stripReducer(sending, { type: "failed" }).sending).toBe(false);
  });

  it("resets to signed without unloading", () => {
    const s = run(loaded(), { type: "end" }, { type: "reset" });
    expect(s.position).toBe(-1);
    expect(s.outcomes.length).toBe(5);
  });
});

describe("live send phases", () => {
  it("moves from sending to submitted, and a load clears both", () => {
    const sending = stripReducer(initialStrip, { type: "sending" });
    expect(sending).toMatchObject({ sending: true, submitted: false });
    const submitted = stripReducer(sending, { type: "submitted" });
    expect(submitted).toMatchObject({ sending: false, submitted: true, outcomes: [] });
    expect(stripReducer(submitted, { type: "failed" })).toMatchObject({ sending: false, submitted: false });
    expect(stripReducer(submitted, { type: "load", outcomes: [true, true] })).toMatchObject({ submitted: false, outcomes: [true, true] });
  });
});
