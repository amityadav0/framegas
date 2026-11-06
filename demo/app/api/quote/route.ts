import { NextResponse } from "next/server";
import { quoteLive } from "../../../lib/live";
import type { PresetId } from "../../../lib/presets";
import { liveSetup } from "../../../lib/server";

export const dynamic = "force-dynamic";

/** Quotes a preset for the demo key, to prefill maxTokenCost. */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { token?: string; preset?: PresetId };
  const setup = liveSetup(body.token);
  if ("error" in setup) return NextResponse.json({ error: setup.error }, { status: 503 });
  const out = await quoteLive(setup.framegas, setup.ctx, body.preset === "supply" ? "supply" : "swap");
  return out.ok ? NextResponse.json(out.value) : NextResponse.json({ error: out.error }, { status: out.status });
}
