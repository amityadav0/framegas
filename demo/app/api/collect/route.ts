import { NextResponse } from "next/server";
import { collectLive, type Handoff } from "../../../lib/live";
import { whereIs } from "../../../lib/pending";
import { liveSetup } from "../../../lib/server";

export const dynamic = "force-dynamic";

/** One short poll per request, so each stays well inside a hosted function's time limit. */
const COLLECT_WAIT_MS = 3_000;

/**
 * Finishes a send that `/api/send` handed off: 200 with the run once the transaction is mined, otherwise 202 with
 * where it is (at the gateway, relayed to the miner, or dropped). Stateless, so any instance can answer.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as (Handoff & { token?: string }) | null;
  if (!body || typeof body.hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(body.hash) || !body.submitted) {
    return NextResponse.json({ error: { code: "BAD_HANDOFF", message: "the body must be what /api/send returned" } }, { status: 400 });
  }
  const setup = liveSetup(body.token);
  if ("error" in setup) return NextResponse.json({ error: setup.error }, { status: 503 });
  const out = await collectLive(setup.framegas, setup.chain, setup.ctx, body, COLLECT_WAIT_MS);
  if (!out.ok) return NextResponse.json({ error: out.error }, { status: out.status });
  if (out.value) return NextResponse.json(out.value);
  return NextResponse.json({ pending: await whereIs(body.hash) }, { status: 202 });
}
