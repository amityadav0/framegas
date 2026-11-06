/** One transaction as the demo shows it, recorded or just sent. Amounts are decimal strings in the token's units. */

export type FrameKind = "verify" | "validate" | "approve" | "settle" | "call" | "refund";

export interface FrameRow {
  kind: FrameKind;
  name: string;
  /** Who the frame acts for, as the explorer labels it. */
  role: "sender" | "payer" | "user";
  success: boolean;
  gasUsed: string;
  gasLimit: string;
  stateGasUsed: string;
  stateGasLimit: string;
}

export interface MempoolResult {
  method: string;
  admitted: boolean;
  message: string;
}

export interface Run {
  source: "replay" | "live";
  mode: "bootstrap" | "normal";
  hash: string;
  explorerUrl: string;
  block: number | null;
  recordedAt?: string;
  sender: string;
  token: { symbol: string; address: string; decimals: number };
  /** What the user's call does, in words. */
  call: string;
  /** The signed transaction both mempools were given. Live runs do not keep the bytes. */
  signed?: { prefix: string; bytes: number };
  balances: { tokenBefore: string | null; tokenAfter: string | null; eth: string };
  cost: { quote: string | null; cap: string; paid: string; refunded: string; net: string };
  /** The paymaster's ETH through the transaction: reserved, bought, sold back, unused reserve returned, net. */
  paymaster: { maxCost: string; bought: string; sold: string; fee: string; returned: string; delta: string };
  canonical: MempoolResult | null;
  alt: MempoolResult & { checksPassed?: number; checksTotal?: number; checksNote?: string };
  frames: FrameRow[];
}

export function frameKinds(mode: Run["mode"], count: number): FrameKind[] {
  const head: FrameKind[] = ["verify", "validate", ...(mode === "bootstrap" ? (["approve"] as const) : []), "settle"];
  if (count <= head.length) return head.slice(0, count);
  return [...head, ...Array.from({ length: count - head.length - 1 }, () => "call" as const), "refund"];
}

const NAMES: Record<FrameKind, string> = { verify: "verify", validate: "validate", approve: "approve", settle: "settle", call: "call", refund: "refund" };
const ROLES: Record<FrameKind, FrameRow["role"]> = { verify: "sender", validate: "payer", approve: "user", settle: "user", call: "user", refund: "user" };

export const frameName = (k: FrameKind): string => NAMES[k];
export const frameRole = (k: FrameKind): FrameRow["role"] => ROLES[k];

/** Signed decimal with a fixed number of places, for amounts in base units. */
export function units(value: bigint, decimals: number, places = decimals): string {
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, "0").slice(0, places);
  return `${neg ? "-" : ""}${whole}${places > 0 ? `.${frac}` : ""}`;
}
