import fs from "node:fs";
import path from "node:path";
import type { Address } from "viem";
import type { LiveToken } from "./live";

export const GATEWAY = process.env.FRAMEGAS_GATEWAY ?? "https://altmempoolgateway.forshtat.com/rpc";

/** The registered tokens and their paymasters, from the repo's deployment record. */
export function loadDeployment(root = path.resolve(process.cwd(), "..")): { tokens: (LiveToken & { paymaster: Address })[] } {
  const file = path.join(root, "deployments", "devnet.json");
  if (!fs.existsSync(file)) return { tokens: [] };
  const d = JSON.parse(fs.readFileSync(file, "utf8")) as { tokens?: Record<string, { address: Address; decimals: number; paymaster: Address }> };
  return { tokens: Object.entries(d.tokens ?? {}).map(([symbol, t]) => ({ symbol, address: t.address, decimals: t.decimals, paymaster: t.paymaster })) };
}
