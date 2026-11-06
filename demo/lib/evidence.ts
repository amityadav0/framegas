/** Turns the recorded files in docs/evidence/ into runs the demo can replay with no devnet. */
import fs from "node:fs";
import path from "node:path";
import { paymasterAbi } from "@framegas/sdk";
import { decodeEventLog, formatEther, formatUnits, type Hex } from "viem";
import { frameNames, type Run } from "./run";

export const evidenceDir = (root = path.resolve(process.cwd(), "..")) => path.join(root, "docs", "evidence");

interface Receipt {
  status: string;
  blockNumber: string;
  gasUsed: string;
  effectiveGasPrice?: string;
  frameReceipts: { status: string; gasUsed: string; stateGasUsed?: string; logs: { address: string; data: Hex; topics: [Hex, ...Hex[]] }[] }[];
}

/** What the paymaster's events say was paid and returned. */
export function settlementFrom(receipt: Receipt): { paid: bigint; refunded: bigint } {
  let paid = 0n;
  let refunded = 0n;
  for (const frame of receipt.frameReceipts) {
    for (const log of frame.logs) {
      try {
        const event = decodeEventLog({ abi: paymasterAbi, data: log.data, topics: log.topics });
        if (event.eventName === "Settled") paid += event.args.tokensPaid;
        if (event.eventName === "Refunded") refunded += event.args.tokensReturned;
      } catch {
        // Not a settlement event: token transfers and the reference tick log here too.
      }
    }
  }
  return { paid, refunded };
}

function fromReceipt(receipt: Receipt, mode: Run["mode"]) {
  const { paid, refunded } = settlementFrom(receipt);
  const names = frameNames(mode, receipt.frameReceipts.length);
  return {
    block: Number(receipt.blockNumber),
    frames: receipt.frameReceipts.map((f, i) => ({
      name: names[i] ?? `frame ${i}`,
      success: f.status === "0x1",
      gasUsed: BigInt(f.gasUsed).toString(),
      stateGasUsed: BigInt(f.stateGasUsed ?? "0x0").toString(),
    })),
    tokensPaid: formatUnits(paid, 6),
    tokensRefunded: formatUnits(refunded, 6),
    netCost: formatUnits(paid - refunded, 6),
    feeEth: formatEther(BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice ?? "0x77359400")),
  };
}

const modeOf = (label: string): Run["mode"] => (label === "bootstrap" ? "bootstrap" : "normal");

/** The transactions sent to both mempools, in the order they were sent: a user's first, then second. */
export function loadComparisonRuns(dir = evidenceDir()): Run[] {
  const files = fs.readdirSync(dir).filter((f) => f.startsWith("mempool-comparison-") && f.endsWith(".json"));
  const runs = files.map((file): Run => {
    const d = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    const mode = modeOf(d.label);
    const alt = d.altMempool.response;
    const canonical = d.canonicalMempool.response;
    const screenshot = file.replace(/\.json$/, "-summary.jpg");
    return {
      source: "replay",
      label: mode === "bootstrap" ? "First transaction: approve inside the same transaction" : "Second transaction: normal mode",
      mode,
      hash: d.txHash,
      explorerUrl: d.explorer ?? `https://explorer.altmempool.wtf/tx/${d.txHash}`,
      recordedAt: "2026-11-05",
      canonical: { admitted: canonical.admitted, message: canonical.admitted ? `admitted as ${canonical.hash}` : canonical.error },
      alt: { admitted: alt.admitted, message: alt.admitted ? "admitted and mined" : alt.error, note: d.admissionNote },
      screenshot: fs.existsSync(path.join(dir, screenshot)) ? screenshot : undefined,
      ...fromReceipt(d.receipt, mode),
    };
  });
  return runs.sort((a, b) => (a.mode === b.mode ? 0 : a.mode === "bootstrap" ? -1 : 1));
}

/** The transactions whose full admission reports were saved before the gateway restarted. */
export function loadAdmissionReports(dir = evidenceDir()) {
  return fs
    .readdirSync(dir)
    .filter((f) => /^(bootstrap|normal)-0x[0-9a-f]{64}\.json$/.test(f))
    .map((file) => {
      const d = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
      const checks: { rule: string; frameIndex?: number; entity?: string; verdict: string }[] = d.admission.admission.checks;
      return {
        label: d.label as string,
        hash: d.txHash as string,
        explorerUrl: d.explorer as string,
        outcome: d.admission.admission.outcome as string,
        checks: checks.map((c) => ({ rule: c.rule, scope: c.frameIndex === undefined ? "transaction" : `frame ${c.frameIndex}, ${c.entity}`, passed: c.verdict === "pass" })),
        screenshots: [`${d.label}-${d.txHash}-summary.jpg`, `${d.label}-${d.txHash}-frames.jpg`].filter((s) => fs.existsSync(path.join(dir, s))),
      };
    })
    .sort((a) => (a.label === "bootstrap" ? -1 : 1));
}

export type AdmissionReport = ReturnType<typeof loadAdmissionReports>[number];
