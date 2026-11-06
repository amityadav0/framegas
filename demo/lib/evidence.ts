/** Turns the recorded files in docs/evidence/ into runs the demo can replay with no devnet. */
import fs from "node:fs";
import path from "node:path";
import { paymasterAbi } from "@framegas/sdk";
import { decodeEventLog, decodeFunctionData, getAddress, parseAbi, type Hex } from "viem";
import { frameKinds, frameName, frameRole, units, type Run } from "./run";

export const evidenceDir = (root = path.resolve(process.cwd(), "..")) => path.join(root, "docs", "evidence");

const TOKEN_DECIMALS = 6;
const erc20 = parseAbi(["function transfer(address,uint256) returns (bool)", "function approve(address,uint256) returns (bool)"]);
const settleAbi = parseAbi(["function settle(uint256 maxTokenCost, uint8 v, bytes32 r, bytes32 s)"]);

interface Log { address: string; data: Hex; topics: [Hex, ...Hex[]] }
interface Receipt {
  blockNumber: string;
  gasUsed: string;
  effectiveGasPrice?: string;
  from: string;
  frameReceipts: { status: string; gasUsed: string; stateGasUsed?: string; logs: Log[] }[];
}
interface SignedFrame { target: string | null; limits: { execution: string; state: string }; data: Hex }

/** What the paymaster's events say moved, in tokens and in ETH. */
export function settlementFrom(receipt: Pick<Receipt, "frameReceipts">) {
  const s = { paid: 0n, refunded: 0n, ethBought: 0n, ethSold: 0n };
  for (const log of receipt.frameReceipts.flatMap((f) => f.logs)) {
    try {
      const e = decodeEventLog({ abi: paymasterAbi, data: log.data, topics: log.topics });
      if (e.eventName === "Settled") (s.paid += e.args.tokensPaid), (s.ethBought += e.args.ethBought);
      if (e.eventName === "Refunded") (s.refunded += e.args.tokensReturned), (s.ethSold += e.args.ethSold);
    } catch {
      // Token transfers and pool events log here too.
    }
  }
  return s;
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** The user's call, in words, from its calldata. */
export function describeCall(frame: SignedFrame, symbol: string): string {
  try {
    const { functionName, args } = decodeFunctionData({ abi: erc20, data: frame.data });
    if (functionName === "transfer") return `Transfer ${units(args[1], TOKEN_DECIMALS, 2)} ${symbol} to ${short(args[0])}`;
  } catch {
    // Not a token call.
  }
  return `Call ${short(frame.target ?? "")}`;
}

/** The checks counted in a saved admission report with the same frame layout, keyed by mode. */
function admissionCounts(dir: string): Record<string, { passed: number; total: number; hash: string }> {
  const out: Record<string, { passed: number; total: number; hash: string }> = {};
  for (const file of fs.readdirSync(dir).filter((f) => /^(bootstrap|normal)-0x[0-9a-f]{64}\.json$/.test(f))) {
    const d = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    const checks: { verdict: string }[] = d.admission.admission.checks;
    out[d.label] = { passed: checks.filter((c) => c.verdict === "pass").length, total: checks.length, hash: d.txHash };
  }
  return out;
}

/** The SDK end-to-end transactions on the current deployment (scripts/08-sdk-live.ts), with their own admission reports. */
export function loadSdkLiveRuns(dir = evidenceDir()): Run[] {
  return fs
    .readdirSync(dir)
    .filter((f) => /^sdk-live-(bootstrap|normal)-0x[0-9a-f]{64}\.json$/.test(f))
    .map((file): Run => {
      const d = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
      const mode: Run["mode"] = file.includes("bootstrap") ? "bootstrap" : "normal";
      const receipt: Receipt = d.receipt;
      const signedFrames: SignedFrame[] = d.admission.entry.tx.frames;
      const kinds = frameKinds(mode, receipt.frameReceipts.length);
      const settleFrame = signedFrames[kinds.indexOf("settle")]!;
      const callFrames = signedFrames.filter((_, i) => kinds[i] === "call");
      const cap = decodeFunctionData({ abi: settleAbi, data: settleFrame.data }).args[0];
      const s = settlementFrom(receipt);
      const fee = BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice ?? "0x77359400");
      const eth = (v: bigint) => units(v, 18, 9);
      const tok = (v: bigint) => units(v, TOKEN_DECIMALS);
      const checks: { verdict: string }[] = d.admission?.admission?.checks ?? [];
      const calls = callFrames.map((f) => describeCall(f, "fgUSD"));
      return {
        source: "replay",
        mode,
        hash: d.txHash,
        explorerUrl: d.explorer,
        block: Number(BigInt(receipt.blockNumber)),
        recordedAt: "2026-11-06",
        sender: getAddress(receipt.from),
        token: { symbol: "fgUSD", address: getAddress(callFrames[0]!.target!), decimals: TOKEN_DECIMALS },
        call: calls.length > 1 ? `${calls[0]}, and ${calls.length - 1} more` : calls[0]!,
        balances: { tokenBefore: tok(BigInt(d.senderTokenBalance.before)), tokenAfter: tok(BigInt(d.senderTokenBalance.after)), eth: eth(BigInt(d.senderEthBalanceNow)) },
        cost: { quote: tok(BigInt(d.quoteTokens)), cap: tok(cap), paid: tok(s.paid), refunded: tok(s.refunded), net: tok(s.paid - s.refunded) },
        paymaster: { maxCost: eth(s.ethBought), bought: eth(s.ethBought), sold: eth(s.ethSold), fee: eth(fee), returned: eth(s.ethBought - fee), delta: eth(s.ethBought - s.ethSold - fee) },
        canonical: { method: "eth_sendRawTransaction", admitted: d.canonicalMempool.admitted, message: d.canonicalMempool.message },
        alt: {
          method: "eth_sendFrameTransaction",
          admitted: true,
          message: "admitted",
          checksPassed: checks.filter((c) => c.verdict === "pass").length,
          checksTotal: checks.length,
        },
        frames: receipt.frameReceipts.map((f, i) => ({
          kind: kinds[i]!,
          name: frameName(kinds[i]!),
          role: frameRole(kinds[i]!),
          success: f.status === "0x1",
          gasUsed: BigInt(f.gasUsed).toString(),
          gasLimit: BigInt(signedFrames[i]?.limits.execution ?? "0x0").toString(),
          stateGasUsed: BigInt(f.stateGasUsed ?? "0x0").toString(),
          stateGasLimit: BigInt(signedFrames[i]?.limits.state ?? "0x0").toString(),
        })),
      };
    })
    .sort((a, b) => (a.mode === b.mode ? 0 : a.mode === "bootstrap" ? -1 : 1));
}

/** Every recorded run: the current deployment's first, then the 2026-11-05 pair sent to both mempools. */
export function loadReplayRuns(dir = evidenceDir()): Run[] {
  return [...loadSdkLiveRuns(dir), ...loadComparisonRuns(dir)];
}

/** The two transactions sent to both mempools: a user's first, then their second. */
export function loadComparisonRuns(dir = evidenceDir()): Run[] {
  const quotes = JSON.parse(fs.readFileSync(path.join(dir, "replay-quotes.json"), "utf8")) as Record<
    string,
    { senderTokenBalance: { before: string; after: string }; senderEthBalanceNow: string; quoteTokens: string; maxCostWei: string }
  >;
  const counts = admissionCounts(dir);
  const runs = fs
    .readdirSync(dir)
    .filter((f) => /^mempool-comparison-.*\.json$/.test(f))
    .map((file): Run => {
      const d = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
      const mode: Run["mode"] = d.label === "bootstrap" ? "bootstrap" : "normal";
      const receipt: Receipt = d.receipt;
      const signedFrames: SignedFrame[] = d.admission.entry.tx.frames;
      const kinds = frameKinds(mode, receipt.frameReceipts.length);
      const settleFrame = signedFrames[kinds.indexOf("settle")]!;
      const callFrame = signedFrames[kinds.indexOf("call")]!;
      const cap = decodeFunctionData({ abi: settleAbi, data: settleFrame.data }).args[0];
      const tokenAddress = getAddress(callFrame.target!);
      const q = quotes[d.txHash];
      const s = settlementFrom(receipt);
      const fee = BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice ?? "0x77359400");
      const eth = (v: bigint) => units(v, 18, 9);
      const tok = (v: bigint) => units(v, TOKEN_DECIMALS);
      const count = counts[mode];
      const canonical = d.canonicalMempool;
      const alt = d.altMempool;
      return {
        source: "replay",
        mode,
        hash: d.txHash,
        explorerUrl: minerView(d.explorer ?? `https://explorer.altmempool.wtf/tx/${d.txHash}`),
        block: Number(BigInt(receipt.blockNumber)),
        recordedAt: "2026-11-05",
        sender: getAddress(receipt.from),
        token: { symbol: "fgUSD", address: tokenAddress, decimals: TOKEN_DECIMALS },
        call: describeCall(callFrame, "fgUSD"),
        signed: { prefix: (d.signedRawTx as string).slice(0, 18), bytes: ((d.signedRawTx as string).length - 2) / 2 },
        balances: {
          tokenBefore: q ? tok(BigInt(q.senderTokenBalance.before)) : null,
          tokenAfter: q ? tok(BigInt(q.senderTokenBalance.after)) : null,
          eth: q ? eth(BigInt(q.senderEthBalanceNow)) : "0",
        },
        cost: { quote: q ? tok(BigInt(q.quoteTokens)) : null, cap: tok(cap), paid: tok(s.paid), refunded: tok(s.refunded), net: tok(s.paid - s.refunded) },
        paymaster: { maxCost: eth(s.ethBought), bought: eth(s.ethBought), sold: eth(s.ethSold), fee: eth(fee), returned: eth(s.ethBought - fee), delta: eth(s.ethBought - s.ethSold - fee) },
        canonical: { method: canonical.method, admitted: canonical.response.admitted, message: canonical.response.admitted ? "admitted" : canonical.response.error },
        alt: {
          method: alt.method,
          admitted: alt.response.admitted,
          message: alt.response.admitted ? "admitted" : alt.response.error,
          checksPassed: count?.passed,
          checksTotal: count?.total,
          checksNote: count
            ? `Count from the saved report for ${short(count.hash)}, which has the same frames. This transaction's report was lost when the gateway restarted; its recorded screenshot shows every rule passed.`
            : undefined,
        },
        frames: receipt.frameReceipts.map((f, i) => ({
          kind: kinds[i]!,
          name: frameName(kinds[i]!),
          role: frameRole(kinds[i]!),
          success: f.status === "0x1",
          gasUsed: BigInt(f.gasUsed).toString(),
          gasLimit: BigInt(signedFrames[i]?.limits.execution ?? "0x0").toString(),
          stateGasUsed: BigInt(f.stateGasUsed ?? "0x0").toString(),
          stateGasLimit: BigInt(signedFrames[i]?.limits.state ?? "0x0").toString(),
        })),
      };
    });
  return runs.sort((a, b) => (a.mode === b.mode ? 0 : a.mode === "bootstrap" ? -1 : 1));
}

/** Explorer links open the miner's view: the gateway keeps transactions only in memory and forgets them on restart. */
export function minerView(url: string): string {
  return /[?&]node=/.test(url) ? url : `${url}${url.includes("?") ? "&" : "?"}node=${encodeURIComponent("https://altmempool.forshtat.com/rpc")}`;
}
