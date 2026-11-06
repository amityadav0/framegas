import { rpc as hegotaRpc } from "@forshtat/hegota-support/rpc";
import { decodeFunctionResult, encodeFunctionData, type Abi, type Address, type Hex } from "viem";

/** What the SDK needs from the network. Tests provide their own. */
export interface Chain {
  read<T>(to: Address, abi: Abi, functionName: string, args?: readonly unknown[]): Promise<T>;
  /** A call to the gateway, which validates frame transactions and forwards chain reads. */
  rpc(method: string, params: unknown[]): Promise<any>;
  /** A dry run with the execution client's own checks. It never submits anything. */
  simulate(rawTx: Hex): Promise<RawSimulation>;
}

/** The live response of `ethrex_simulateFrameTransaction`. */
export interface RawSimulation {
  canonicalMempoolValid: boolean;
  canonicalMempoolViolation: string | null;
  executionStatus: "success" | "reverted" | null;
  executionError: string | null;
  frames: { gasUsed: string; succeeded: boolean }[] | null;
  gasUsed: string | null;
  maxCost: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A node's answer, even an error, is final. Only failing to reach the node is retried. */
async function withRetries(url: string, method: string, params: unknown[]): Promise<any> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await hegotaRpc(url, method, params);
    } catch (e) {
      if ((e as { code?: string }).code !== "RPC_UNREACHABLE" || attempt >= 12) throw e;
      await sleep(3_000);
    }
  }
}

export function httpChain(gatewayUrl: string, executionUrl: string): Chain {
  return {
    rpc: (method, params) => withRetries(gatewayUrl, method, params),
    simulate: (rawTx) => withRetries(executionUrl, "ethrex_simulateFrameTransaction", [rawTx, "latest", { trace: false }]),
    async read<T>(to: Address, abi: Abi, functionName: string, args: readonly unknown[] = []): Promise<T> {
      const data = encodeFunctionData({ abi, functionName, args });
      const out = await withRetries(gatewayUrl, "eth_call", [{ to, data }, "latest"]);
      return decodeFunctionResult({ abi, functionName, data: out }) as T;
    },
  };
}
