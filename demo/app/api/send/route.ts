import { NextResponse } from "next/server";
import { parseUnits } from "viem";
import { submitLive } from "../../../lib/live";
import type { PresetId } from "../../../lib/presets";
import { liveSetup } from "../../../lib/server";

export const dynamic = "force-dynamic";

/**
 * Simulates, signs and sends one preset from the server's devnet key, which holds tokens and no ETH, with both
 * mempools compared. Answers 202 with a handoff as soon as the alt-mempool admits it; the page then asks
 * `/api/collect` until it is mined. Waiting here would outlive a hosted function's time limit.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { token?: string; preset?: PresetId; maxTokenCost?: string; quote?: string };
  const setup = liveSetup(body.token);
  if ("error" in setup) return NextResponse.json({ error: setup.error }, { status: 503 });
  let cap: bigint;
  let quote: bigint;
  try {
    cap = parseUnits(body.maxTokenCost ?? "", setup.ctx.token.decimals);
    if (cap <= 0n) throw new Error();
    quote = body.quote ? parseUnits(body.quote, setup.ctx.token.decimals) : cap;
  } catch {
    return NextResponse.json({ error: { code: "BAD_CAP", message: "maxTokenCost must be a positive amount" } }, { status: 400 });
  }
  const out = await submitLive(setup.framegas, setup.chain, setup.ctx, body.preset === "supply" ? "supply" : "swap", cap, quote);
  return out.ok ? NextResponse.json(out.value, { status: 202 }) : NextResponse.json({ error: out.error }, { status: out.status });
}
