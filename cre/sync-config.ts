/**
 * Writes divergence/config.json from deployments/devnet.json: the devnet pool, the paymaster, and a price snapshot the
 * workflow falls back to when the devnet is halted or unreachable. The snapshot is refreshed when the gateway answers.
 *
 *   bun run sync-config.ts
 */
import fs from "node:fs";
import { decodeFunctionResult, encodeFunctionData, type Hex, parseAbi } from "viem";

const GATEWAY = "https://altmempoolgateway.forshtat.com/rpc";
const DEVNET_STATE_VIEW = "0xd89a052862AaA34f0B6cc7f3B6a9D080584a43FB";
const root = new URL("../", import.meta.url);
const out = new URL("divergence/config.json", import.meta.url);
const stateViewAbi = parseAbi(["function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)"]);

const deployment = JSON.parse(fs.readFileSync(new URL("deployments/devnet.json", root), "utf8")) as { paymaster: string; pool: { id: Hex } };
const previous = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, "utf8")) : undefined;

async function rpc(method: string, params: unknown[]): Promise<any> {
  const res = await fetch(GATEWAY, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(10_000) });
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (body.error || body.result == null) throw new Error(body.error?.message ?? "no result");
  return body.result;
}

let fallback = previous?.devnet?.poolId === deployment.pool.id ? previous.devnet.fallback : undefined;
try {
  const block = BigInt(await rpc("eth_blockNumber", []));
  const data = encodeFunctionData({ abi: stateViewAbi, functionName: "getSlot0", args: [deployment.pool.id] });
  const [sqrtPriceX96, tick] = decodeFunctionResult({ abi: stateViewAbi, functionName: "getSlot0", data: await rpc("eth_call", [{ to: DEVNET_STATE_VIEW, data }, "latest"]) });
  fallback = { sqrtPriceX96: sqrtPriceX96.toString(), tick, block: Number(block), source: `deployments/devnet.json pool, snapshot at block ${block}` };
  console.log(`snapshot: tick ${tick} at block ${block}`);
} catch (e) {
  console.log(`gateway unavailable (${(e as Error).message}); keeping the previous snapshot`);
}
if (!fallback) throw new Error("no snapshot: the gateway is down and config.json has none for this pool");

const config = {
  schedule: "0 */5 * * * *",
  thresholdBps: 300,
  boundTicks: 300,
  staleSeconds: 300,
  mainnet: {
    chainSelectorName: "ethereum-mainnet",
    stateView: "0x7fFE42C4a5DEeA5b0feC41C94C136Cf115597227",
    poolId: "0xdce6394339af00981949f5f3baf27e3610c76326a700af57e4b3e3ae4977f78d",
  },
  devnet: { gatewayUrl: GATEWAY, stateView: DEVNET_STATE_VIEW, poolId: deployment.pool.id, paymaster: deployment.paymaster, fallback },
};
fs.writeFileSync(out, `${JSON.stringify(config, null, 2)}\n`);
console.log(`wrote ${out.pathname}`);
