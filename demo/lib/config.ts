import { DEFAULT_NODE_URL } from "@framegas/sdk";
import fs from "node:fs";
import path from "node:path";
import type { Address } from "viem";

/** The alt-mempool node live mode submits to. The miner's own sidecar by default; see `DEFAULT_NODE_URL` in the SDK. */
export const GATEWAY = process.env.FRAMEGAS_GATEWAY ?? DEFAULT_NODE_URL;

export interface DeployedToken {
  symbol: string;
  address: Address;
  decimals: number;
  paymaster: Address;
  fee: number;
  tickSpacing: number;
}

export interface Deployment {
  tokens: DeployedToken[];
  demo: { swapRouter?: Address; lendingPool?: Address };
}

/** The registered tokens, their paymasters and the demo's call targets, from the repo's deployment record. */
export function loadDeployment(root = path.resolve(process.cwd(), "..")): Deployment {
  const file = path.join(root, "deployments", "devnet.json");
  if (!fs.existsSync(file)) return { tokens: [], demo: {} };
  const d = JSON.parse(fs.readFileSync(file, "utf8")) as {
    pool?: { fee: number; tickSpacing: number };
    tokens?: Record<string, { address: Address; decimals: number; paymaster: Address }>;
    demo?: Deployment["demo"];
  };
  const tokens = Object.entries(d.tokens ?? {}).map(([symbol, t]) => ({
    symbol,
    address: t.address,
    decimals: t.decimals,
    paymaster: t.paymaster,
    fee: d.pool?.fee ?? 3000,
    tickSpacing: d.pool?.tickSpacing ?? 60,
  }));
  return { tokens, demo: d.demo ?? {} };
}
