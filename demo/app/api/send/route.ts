import { NextResponse } from "next/server";
import { parseUnits } from "viem";
import { sendLive } from "../../../lib/live";
import type { PresetId } from "../../../lib/presets";
import { liveSetup } from "../../../lib/server";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Sends one preset from the server's devnet key, which holds tokens and no ETH, with both mempools compared. */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { token?: string; preset?: PresetId; maxTokenCost?: string };
  const setup = liveSetup(body.token);
  if ("error" in setup) return NextResponse.json({ error: setup.error }, { status: 503 });
  let cap: bigint;
  try {
    cap = parseUnits(body.maxTokenCost ?? "", setup.ctx.token.decimals);
    if (cap <= 0n) throw new Error();
  } catch {
    return NextResponse.json({ error: { code: "BAD_CAP", message: "maxTokenCost must be a positive amount" } }, { status: 400 });
  }
  const out = await sendLive(setup.framegas, setup.chain, setup.ctx, body.preset === "supply" ? "supply" : "swap", cap);
  return out.ok ? NextResponse.json(out.value) : NextResponse.json({ error: out.error }, { status: out.status });
}
