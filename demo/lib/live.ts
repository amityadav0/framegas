/** Live mode: sends through the SDK and returns what the page shows. Kept free of Next.js so it can be tested. */
import { FrameGasError, type FrameGas } from "@framegas/sdk";
import { encodeFunctionData, formatEther, formatUnits, parseAbi, type Address } from "viem";
import type { Run } from "./run";

const transferAbi = parseAbi(["function transfer(address,uint256) returns (bool)"]);
/** The demo's call: a token transfer, so a reader can see it land on the explorer. */
export const DEMO_RECIPIENT: Address = "0x8943545177806ED17B9F23F0a21ee5948eCaa776";

export interface LiveToken {
  symbol: string;
  address: Address;
  decimals: number;
}

export type LiveOutcome = { ok: true; run: Run } | { ok: false; status: number; error: { code: string; message: string } };

export async function sendLive(framegas: FrameGas, token: LiveToken, amount: string): Promise<LiveOutcome> {
  try {
    const value = BigInt(Math.round(Number(amount) * 10 ** token.decimals));
    const calls = [{ to: token.address, data: encodeFunctionData({ abi: transferAbi, functionName: "transfer", args: [DEMO_RECIPIENT, value] }) }];
    const quote = await framegas.quote({ payToken: token.address, calls });
    const r = await framegas.send({ payToken: token.address, maxTokenCost: (quote.requiredTokens * 102n) / 100n, calls, compareMempools: true });
    const fmt = (v: bigint) => formatUnits(v, token.decimals);
    return {
      ok: true,
      run: {
        source: "live",
        label: r.mode === "bootstrap" ? "First transaction: approve inside the same transaction" : "Normal mode",
        mode: r.mode,
        hash: r.hash,
        explorerUrl: r.explorerUrl,
        block: r.block,
        canonical: r.canonicalMempool ?? null,
        alt: { admitted: true, message: r.success ? "admitted and mined" : "admitted, but a frame failed" },
        frames: r.frames.map((f) => ({ name: f.name, success: f.success, gasUsed: f.gasUsed.toString(), stateGasUsed: f.stateGasUsed.toString() })),
        tokensPaid: fmt(r.tokensPaid),
        tokensRefunded: fmt(r.tokensRefunded),
        netCost: fmt(r.tokensPaid - r.tokensRefunded),
        feeEth: formatEther(r.feeWei),
      },
    };
  } catch (e) {
    if (e instanceof FrameGasError) {
      const status = e.code === "NOT_MINED" ? 504 : e.code === "REJECTED" ? 502 : 422;
      return { ok: false, status, error: { code: e.code, message: e.message } };
    }
    return { ok: false, status: 500, error: { code: "UNEXPECTED", message: e instanceof Error ? e.message : String(e) } };
  }
}

/** Live mode needs a chain that is producing blocks. */
export function chainIsLive(latestBlockTimestamp: number, nowSeconds: number, maxAgeSeconds = 120): boolean {
  return nowSeconds - latestBlockTimestamp <= maxAgeSeconds;
}
