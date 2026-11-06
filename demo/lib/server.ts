/** Server-side wiring for live mode: the demo key, the gateway and the deployment record. */
import { createFrameGas, httpChain } from "@framegas/sdk";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { GATEWAY, loadDeployment } from "./config";
import type { PresetContext } from "./presets";

export const EXECUTION_URL = process.env.FRAMEGAS_EXECUTION_URL ?? "https://altmempool.forshtat.com";
/** The miner's own sidecar, asked whether a transaction reached it. */
export const MINER_RPC = process.env.FRAMEGAS_MINER_RPC ?? "https://altmempool.forshtat.com/rpc";
/** The devnet includes most transactions within half a minute, so after this the UI shows where one is stuck instead. */
const DEMO_MINE_TIMEOUT_MS = 90_000;

export function liveSetup(symbol?: string) {
  const key = process.env.FRAMEGAS_DEMO_KEY as Hex | undefined;
  const deployment = loadDeployment();
  const token = deployment.tokens.find((t) => t.symbol === symbol) ?? deployment.tokens[0];
  if (!key) return { error: { code: "NO_KEY", message: "FRAMEGAS_DEMO_KEY is not set on the server" } } as const;
  if (!token) return { error: { code: "NO_TOKEN", message: "deployments/devnet.json lists no tokens" } } as const;
  const chain = httpChain(GATEWAY, EXECUTION_URL);
  const framegas = createFrameGas({ privateKey: key, chain, paymasters: Object.fromEntries(deployment.tokens.map((t) => [t.address, t.paymaster])), mineTimeoutMs: DEMO_MINE_TIMEOUT_MS });
  const ctx: PresetContext = { sender: privateKeyToAccount(key).address, token, demo: deployment.demo };
  return { chain, framegas, ctx } as const;
}
