/** Live mode: quotes and sends through the SDK. Kept free of Next.js so it can be tested against a fake gateway. */
import { erc20Abi, FrameGasError, type Chain, type FrameGas, type SendResult } from "@framegas/sdk";
import type { Address } from "viem";
import { presetCalls, type PresetContext, type PresetId } from "./presets";
import { frameKinds, frameName, frameRole, units, type Run } from "./run";

export type LiveError = { code: string; message: string; requiredTokens?: string };
export type Outcome<T> = { ok: true; value: T } | { ok: false; status: number; error: LiveError };

export async function readBalances(chain: Chain, token: Address, who: Address): Promise<{ token: bigint; eth: bigint }> {
  const [t, e] = await Promise.all([chain.read<bigint>(token, erc20Abi, "balanceOf", [who]), chain.rpc("eth_getBalance", [who, "latest"])]);
  return { token: t, eth: BigInt(e as string) };
}

/** The admission report's checks, when the gateway still has it. */
async function admissionChecks(chain: Chain, hash: string): Promise<{ passed: number; total: number } | undefined> {
  try {
    const r = (await chain.rpc("skandha_explorer_getTransaction", [hash])) as { admission?: { checks?: { verdict: string }[] } };
    const checks = r?.admission?.checks;
    return checks ? { passed: checks.filter((c) => c.verdict === "pass").length, total: checks.length } : undefined;
  } catch {
    return undefined;
  }
}

function fail(e: unknown): { ok: false; status: number; error: LiveError } {
  if (e instanceof FrameGasError) {
    const status = e.code === "NOT_MINED" ? 504 : e.code === "REJECTED" ? 502 : 422;
    const required = (e.details as { requiredTokens?: bigint } | undefined)?.requiredTokens;
    return { ok: false, status, error: { code: e.code, message: e.message, ...(required !== undefined ? { requiredTokens: required.toString() } : {}) } };
  }
  return { ok: false, status: 500, error: { code: "UNEXPECTED", message: e instanceof Error ? e.message : String(e) } };
}

export async function quoteLive(framegas: FrameGas, ctx: PresetContext, preset: PresetId): Promise<Outcome<{ mode: string; quote: string; cap: string }>> {
  try {
    const { calls } = presetCalls(preset, ctx);
    const q = await framegas.quote({ payToken: ctx.token.address, calls });
    const d = ctx.token.decimals;
    // 2% over the quote leaves room for the price to move before inclusion.
    return { ok: true, value: { mode: q.mode, quote: units(q.requiredTokens, d), cap: units((q.requiredTokens * 102n) / 100n, d) } };
  } catch (e) {
    return fail(e);
  }
}

export interface LiveContext {
  quote: bigint;
  cap: bigint;
  call: string;
  before: { token: bigint; eth: bigint };
  after: { token: bigint; eth: bigint };
  checks?: { passed: number; total: number };
}

/** What the page shows for a transaction the SDK just sent. */
export function liveRun(r: SendResult, ctx: PresetContext, live: LiveContext): Run {
  const d = ctx.token.decimals;
  const tok = (v: bigint) => units(v, d);
  const eth = (v: bigint) => units(v, 18, 9);
  const kinds = frameKinds(r.mode, r.frames.length);
  return {
    source: "live",
    mode: r.mode,
    hash: r.hash,
    explorerUrl: r.explorerUrl,
    block: r.block,
    sender: ctx.sender,
    token: { symbol: ctx.token.symbol, address: ctx.token.address, decimals: d },
    call: live.call,
    balances: { tokenBefore: tok(live.before.token), tokenAfter: tok(live.after.token), eth: eth(live.before.eth) },
    cost: { quote: tok(live.quote), cap: tok(live.cap), paid: tok(r.tokensPaid), refunded: tok(r.tokensRefunded), net: tok(r.tokensPaid - r.tokensRefunded) },
    paymaster: { maxCost: eth(r.maxCostWei), bought: eth(r.ethBought), sold: eth(r.ethSold), fee: eth(r.feeWei), returned: eth(r.maxCostWei - r.feeWei), delta: eth(r.ethBought - r.ethSold - r.feeWei) },
    canonical: r.canonicalMempool ? { method: "eth_sendRawTransaction", ...r.canonicalMempool } : null,
    alt: {
      method: "eth_sendFrameTransaction",
      admitted: true,
      message: r.success ? "admitted" : "admitted, but a frame failed",
      checksPassed: live.checks?.passed,
      checksTotal: live.checks?.total,
    },
    frames: r.frames.map((f, i) => ({
      kind: kinds[i]!,
      name: frameName(kinds[i]!),
      role: frameRole(kinds[i]!),
      success: f.success,
      gasUsed: f.gasUsed.toString(),
      gasLimit: f.gasLimit.toString(),
      stateGasUsed: f.stateGasUsed.toString(),
      stateGasLimit: f.stateGasLimit.toString(),
    })),
  };
}

/** Quotes, sends with both mempools compared, and reads the wallet before and after. */
export async function sendLive(framegas: FrameGas, chain: Chain, ctx: PresetContext, preset: PresetId, cap: bigint): Promise<Outcome<Run>> {
  try {
    const { calls, label } = presetCalls(preset, ctx);
    const before = await readBalances(chain, ctx.token.address, ctx.sender);
    const q = await framegas.quote({ payToken: ctx.token.address, calls });
    const r = await framegas.send({ payToken: ctx.token.address, maxTokenCost: cap, calls, compareMempools: true });
    const [after, checks] = await Promise.all([readBalances(chain, ctx.token.address, ctx.sender), admissionChecks(chain, r.hash)]);
    return { ok: true, value: liveRun(r, ctx, { quote: q.requiredTokens, cap, call: label, before, after, checks }) };
  } catch (e) {
    return fail(e);
  }
}

/** Live mode needs a chain that is producing blocks. */
export function chainIsLive(latestBlockTimestamp: number, nowSeconds: number, maxAgeSeconds = 120): boolean {
  return nowSeconds - latestBlockTimestamp <= maxAgeSeconds;
}
