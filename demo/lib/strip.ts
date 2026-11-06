/**
 * The frame strip's state machine. A transaction plays as a sequence of stages:
 *
 *   position -1     signed, not sent
 *   position 0      sent to both mempools: their answers are shown
 *   position 1..n   frame (position - 1) has executed
 *   position n + 1  mined: block and settlement totals are final
 *
 * Pure, so the page and the tests drive the same transitions.
 */

export type FrameStatus = "pending" | "current" | "ok" | "failed";

export interface StripState {
  /** Whether each frame succeeded, in order. Empty until a transaction is loaded. */
  outcomes: boolean[];
  position: number;
  playing: boolean;
  /** A live send is in flight: simulation, signing and submission happen before any outcome is known. */
  sending: boolean;
  /** The alt-mempool admitted a live send and the page is waiting for a block. */
  submitted: boolean;
}

export type StripAction =
  | { type: "load"; outcomes: boolean[]; play?: boolean }
  | { type: "sending" }
  | { type: "submitted" }
  | { type: "failed" }
  | { type: "next" }
  | { type: "prev" }
  | { type: "end" }
  | { type: "reset" }
  | { type: "play" }
  | { type: "pause" };

export const initialStrip: StripState = { outcomes: [], position: -1, playing: false, sending: false, submitted: false };

export const lastPosition = (s: StripState): number => s.outcomes.length + 1;

export function stripReducer(s: StripState, a: StripAction): StripState {
  const last = lastPosition(s);
  switch (a.type) {
    case "load":
      return { outcomes: a.outcomes, position: -1, playing: a.play ?? false, sending: false, submitted: false };
    case "sending":
      return { ...initialStrip, sending: true };
    case "submitted":
      return { ...initialStrip, submitted: true };
    case "failed":
      return { ...s, sending: false, submitted: false, playing: false };
    case "next": {
      if (s.outcomes.length === 0) return s;
      const position = Math.min(s.position + 1, last);
      return { ...s, position, playing: s.playing && position < last };
    }
    case "prev":
      return { ...s, position: Math.max(s.position - 1, -1), playing: false };
    case "end":
      return s.outcomes.length === 0 ? s : { ...s, position: last, playing: false };
    case "reset":
      return { ...s, position: -1, playing: false };
    case "play":
      if (s.outcomes.length === 0) return s;
      // Playing from the end starts again.
      return { ...s, position: s.position >= last ? -1 : s.position, playing: true };
    case "pause":
      return { ...s, playing: false };
  }
}

export function frameStatus(s: StripState, index: number): FrameStatus {
  const executed = s.position - 1; // index of the frame that ran most recently
  if (index > executed) return "pending";
  const outcome = s.outcomes[index];
  if (index === executed && s.position <= s.outcomes.length) return "current";
  return outcome ? "ok" : "failed";
}

/** The mempools answer as soon as the transaction is sent. */
export const mempoolsAnswered = (s: StripState): boolean => s.outcomes.length > 0 && s.position >= 0;
export const mined = (s: StripState): boolean => s.outcomes.length > 0 && s.position >= lastPosition(s);
/** Whether frame `index` has run, so its effects (a payment, a refund) can be shown. */
export const hasRun = (s: StripState, index: number): boolean => index >= 0 && s.position - 1 >= index;

export function stageLabel(s: StripState, frameNames: string[]): string {
  if (s.sending) return "Simulating, signing and submitting";
  if (s.outcomes.length === 0) return "No transaction loaded";
  const n = s.outcomes.length;
  if (s.position < 0) return "Signed, not sent";
  if (s.position === 0) return "Sent to both mempools";
  if (s.position <= n) {
    const i = s.position - 1;
    return `Frame ${i} ${frameNames[i] ?? ""} ${s.outcomes[i] ? "executed" : "failed"}`;
  }
  return s.outcomes.every(Boolean) ? "Mined, every frame succeeded" : "Mined, a frame failed";
}

/** 1-based step for the step counter, out of n + 3 stages. */
export const stepOf = (s: StripState): { step: number; of: number } => ({ step: s.position + 2, of: s.outcomes.length + 3 });
