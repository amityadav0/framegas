import { NextResponse } from "next/server";
import { whereIs } from "../../../lib/pending";

export const dynamic = "force-dynamic";

/** Where an admitted transaction is: mined, waiting at the gateway without reaching the miner, relayed, or dropped. */
export async function GET(request: Request) {
  const hash = new URL(request.url).searchParams.get("hash") ?? "";
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return NextResponse.json({ error: { code: "BAD_HASH", message: "hash must be a 32-byte hex string" } }, { status: 400 });
  return NextResponse.json(await whereIs(hash));
}
