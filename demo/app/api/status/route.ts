import { NextResponse } from "next/server";
import { chainIsLive } from "../../../lib/live";
import { GATEWAY, loadDeployment } from "../../../lib/config";

export const dynamic = "force-dynamic";

/** Whether live mode can work: the chain must be producing blocks, and the server needs a demo key and a token. */
export async function GET() {
  const tokens = loadDeployment().tokens.map(({ symbol, address }) => ({ symbol, address }));
  const hasKey = Boolean(process.env.FRAMEGAS_DEMO_KEY);
  try {
    const res = await fetch(GATEWAY, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: ["latest", false] }),
      signal: AbortSignal.timeout(5_000),
      cache: "no-store",
    });
    const { result } = (await res.json()) as { result: { number: string; timestamp: string } };
    const timestamp = Number(BigInt(result.timestamp));
    const producing = chainIsLive(timestamp, Math.floor(Date.now() / 1000));
    return NextResponse.json({ live: producing && hasKey && tokens.length > 0, producing, hasKey, block: Number(BigInt(result.number)), blockTimestamp: timestamp, tokens });
  } catch (e) {
    return NextResponse.json({ live: false, producing: false, hasKey, tokens, error: e instanceof Error ? e.message : String(e) });
  }
}
