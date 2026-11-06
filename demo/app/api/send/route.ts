import { createFrameGas } from "@framegas/sdk";
import { NextResponse } from "next/server";
import type { Hex } from "viem";
import { loadDeployment } from "../../../lib/config";
import { sendLive } from "../../../lib/live";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Sends one demo transaction from the server's devnet key, which holds tokens and no ETH. */
export async function POST(request: Request) {
  const key = process.env.FRAMEGAS_DEMO_KEY as Hex | undefined;
  if (!key) return NextResponse.json({ error: { code: "NO_KEY", message: "FRAMEGAS_DEMO_KEY is not set on the server" } }, { status: 503 });
  const body = (await request.json().catch(() => ({}))) as { token?: string; amount?: string };
  const tokens = loadDeployment().tokens;
  const token = tokens.find((t) => t.symbol === body.token) ?? tokens[0];
  if (!token) return NextResponse.json({ error: { code: "NO_TOKEN", message: "deployments/devnet.json lists no tokens" } }, { status: 503 });
  const amount = body.amount && Number(body.amount) > 0 && Number(body.amount) <= 10 ? body.amount : "1";
  const framegas = createFrameGas({ privateKey: key, paymasters: Object.fromEntries(tokens.map((t) => [t.address, t.paymaster])) });
  const outcome = await sendLive(framegas, token, amount);
  return outcome.ok ? NextResponse.json(outcome.run) : NextResponse.json({ error: outcome.error }, { status: outcome.status });
}
