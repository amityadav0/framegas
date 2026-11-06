/** Where an admitted transaction is, from what the gateway and the miner each report. Shared by `/api/pending` and `/api/collect`. */
import { httpChain } from "@framegas/sdk";
import { GATEWAY } from "./config";
import { pendingState, type PendingState } from "./live";
import { EXECUTION_URL, MINER_RPC } from "./server";

const minerHas = (hash: string): Promise<boolean> =>
  fetch(MINER_RPC, { method: "POST", headers: { "content-type": "application/json" }, cache: "no-store", signal: AbortSignal.timeout(4_000), body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "skandha_explorer_getTransaction", params: [hash] }) })
    .then(async (res) => ((await res.json()) as { result?: unknown }).result != null)
    .catch(() => false);

export async function whereIs(hash: string): Promise<PendingState> {
  const chain = httpChain(GATEWAY, EXECUTION_URL);
  const [receipt, gateway, minerSeen] = await Promise.all([
    chain.rpc("eth_getTransactionReceipt", [hash]).catch(() => null) as Promise<{ blockNumber?: string } | null>,
    chain.rpc("skandha_explorer_getTransaction", [hash]).catch(() => null) as Promise<{ entry?: unknown; admission?: { at?: number } } | null>,
    minerHas(hash),
  ]);
  return pendingState({
    receiptBlock: receipt?.blockNumber ? Number(BigInt(receipt.blockNumber)) : undefined,
    gatewayHasEntry: gateway?.entry != null,
    admittedAt: gateway?.admission?.at,
    minerSeen,
  });
}
