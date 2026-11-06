/** One transaction as the demo shows it, whether it was recorded or just sent. Amounts are strings, ready to show. */
export interface Run {
  source: "replay" | "live";
  label: string;
  mode: "bootstrap" | "normal";
  hash: string;
  explorerUrl: string;
  block: number | null;
  recordedAt?: string;
  canonical: { admitted: boolean; message: string } | null;
  alt: { admitted: boolean; message: string; checksPassed?: number; checksTotal?: number; note?: string };
  frames: { name: string; success: boolean; gasUsed: string; stateGasUsed: string }[];
  tokensPaid: string;
  tokensRefunded: string;
  netCost: string;
  feeEth: string;
  screenshot?: string;
}

export const frameNames = (mode: Run["mode"], count: number): string[] => {
  const head = ["sender verify", "paymaster validate", ...(mode === "bootstrap" ? ["approve"] : []), "settle"];
  const tailCount = count - head.length;
  if (tailCount <= 0) return head.slice(0, count);
  return [...head, ...Array.from({ length: tailCount - 1 }, (_, i) => `user call${tailCount > 2 ? ` ${i + 1}` : ""}`), "refund"];
};
