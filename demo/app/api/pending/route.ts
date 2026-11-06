import { httpChain } from "@framegas/sdk";
import { NextResponse } from "next/server";
import { GATEWAY } from "../../../lib/config";
import { pendingState } from "../../../lib/live";
import { EXECUTION_URL, MINER_RPC } from "../../../lib/server";

export const dynamic = "force-dynamic";

const minerHas = (hash: string): Promise<boolean> =>
  fetch(MINER_RPC, { method: "POST", headers: { "content-type": "application/json" }, cache: "no-store", signal: AbortSignal.timeout(8_000), body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "skandha_explorer_getTransaction", params: [hash] }) })
    .then(async (res) => ((await res.json()) as { result?: unknown }).result != null)
    .catch(() => false);

/** Where an admitted transaction is: mined, waiting at the gateway without reaching the miner, relayed, or dropped. */
export async function GET(request: Request) {
  const hash = new URL(request.url).searchParams.get("hash") ?? "";
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return NextResponse.json({ error: { code: "BAD_HASH", message: "hash must be a 32-byte hex string" } }, { status: 400 });
  const chain = httpChain(GATEWAY, EXECUTION_URL);
  const [receipt, gateway, minerSeen] = await Promise.all([
    chain.rpc("eth_getTransactionReceipt", [hash]).catch(() => null) as Promise<{ blockNumber?: string } | null>,
    chain.rpc("skandha_explorer_getTransaction", [hash]).catch(() => null) as Promise<{ entry?: unknown; admission?: { at?: number } } | null>,
    minerHas(hash),
  ]);
  return NextResponse.json(
    pendingState({
      receiptBlock: receipt?.blockNumber ? Number(BigInt(receipt.blockNumber)) : undefined,
      gatewayHasEntry: gateway?.entry != null,
      admittedAt: gateway?.admission?.at,
      minerSeen,
    }),
  );
}
