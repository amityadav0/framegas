import { NextResponse } from "next/server";
import { GATEWAY, loadDeployment } from "../../../lib/config";
import { chainIsLive, readBalances } from "../../../lib/live";
import { units } from "../../../lib/run";
import { liveSetup } from "../../../lib/server";

export const dynamic = "force-dynamic";

/** Chain height and age from the gateway, and the live wallet when the server has a demo key. */
export async function GET() {
  const deployment = loadDeployment();
  const tokens = deployment.tokens.map(({ symbol, address }) => ({ symbol, address }));
  const demoReady = Boolean(deployment.demo.swapRouter && deployment.demo.lendingPool);
  try {
    const res = await fetch(GATEWAY, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: ["latest", false] }),
      signal: AbortSignal.timeout(5_000),
      cache: "no-store",
    });
    const { result } = (await res.json()) as { result: { number: string; timestamp: string } };
    const blockTimestamp = Number(BigInt(result.timestamp));
    const producing = chainIsLive(blockTimestamp, Math.floor(Date.now() / 1000));
    const setup = liveSetup();
    let wallet = null;
    if (!("error" in setup) && producing) {
      const b = await readBalances(setup.chain, setup.ctx.token.address, setup.ctx.sender);
      wallet = { address: setup.ctx.sender, token: units(b.token, setup.ctx.token.decimals), eth: units(b.eth, 18, 9) };
    }
    const reason = !producing ? "chain is not producing blocks" : "error" in setup ? (setup.error?.message ?? "no demo key") : !demoReady ? "deployment has no demo contracts" : null;
    return NextResponse.json({ reachable: true, block: Number(BigInt(result.number)), blockTimestamp, producing, live: reason === null, reason, wallet, tokens });
  } catch (e) {
    return NextResponse.json({ reachable: false, producing: false, live: false, reason: e instanceof Error ? e.message : String(e), wallet: null, tokens });
  }
}
