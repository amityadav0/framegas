/** Live mode: quotes and sends through the SDK. Kept free of Next.js so it can be tested against a fake gateway. */
import { erc20Abi, FrameGasError, type Chain, type FrameGas, type SendResult, type Submitted } from "@framegas/sdk";
import type { Address } from "viem";
import { presetCalls, type PresetContext, type PresetId } from "./presets";
import { frameKinds, frameName, frameRole, units, type Run } from "./run";

export type LiveError = { code: string; message: string; requiredTokens?: string; hash?: string; explorerUrl?: string };
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
    const details = e.details as { requiredTokens?: bigint; hash?: string; explorerUrl?: string } | undefined;
    const required = details?.requiredTokens;
    return {
      ok: false,
      status,
      error: {
        code: e.code,
        message: e.message,
        ...(required !== undefined ? { requiredTokens: required.toString() } : {}),
        ...(details?.hash ? { hash: details.hash, explorerUrl: details.explorerUrl } : {}),
      },
    };
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

/**
 * What `/api/send` hands the browser once the alt-mempool admits a transaction, and the browser hands back to
 * `/api/collect` until it is mined. Hosted functions are cut off after about ten seconds, so the wait for a block
 * cannot live in the request that sent the transaction. Bigints travel as decimal strings.
 */
export interface Handoff {
  submitted: unknown;
  hash: string;
  explorerUrl: string;
  canonical: { method: "eth_sendRawTransaction"; admitted: boolean; message: string } | null;
  quote: string;
  cap: string;
  call: string;
  before: { token: string; eth: string };
  /** Unix seconds. */
  submittedAt: number;
}

const BIG = /^-?\d+n$/;
export const pack = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? `${x}n` : x)));
export const unpack = <T,>(v: unknown): T => JSON.parse(JSON.stringify(v), (_, x) => (typeof x === "string" && BIG.test(x) ? BigInt(x.slice(0, -1)) : x)) as T;

/** Simulates, signs and broadcasts, and returns as soon as the alt-mempool answers. `quote` is what the page showed the user, in base units. */
export async function submitLive(framegas: FrameGas, chain: Chain, ctx: PresetContext, preset: PresetId, cap: bigint, quote: bigint): Promise<Outcome<Handoff>> {
  try {
    const { calls, label } = presetCalls(preset, ctx);
    const before = await readBalances(chain, ctx.token.address, ctx.sender);
    const s = await framegas.submit({ payToken: ctx.token.address, maxTokenCost: cap, calls, compareMempools: true });
    return {
      ok: true,
      value: {
        submitted: pack(s),
        hash: s.hash,
        explorerUrl: s.explorerUrl,
        canonical: s.canonicalMempool ? { method: "eth_sendRawTransaction", ...s.canonicalMempool } : null,
        quote: quote.toString(),
        cap: cap.toString(),
        call: label,
        before: { token: before.token.toString(), eth: before.eth.toString() },
        submittedAt: Math.floor(Date.now() / 1000),
      },
    };
  } catch (e) {
    return fail(e);
  }
}

/** Polls once for the receipt, for at most `timeoutMs`. Mined: the full run. Not yet: `null`, and the caller asks again. */
export async function collectLive(framegas: FrameGas, chain: Chain, ctx: PresetContext, h: Handoff, timeoutMs: number): Promise<Outcome<Run | null>> {
  try {
    const submitted = unpack<Submitted>(h.submitted);
    let r: SendResult;
    try {
      r = await framegas.collect(submitted, { timeoutMs });
    } catch (e) {
      if (e instanceof FrameGasError && e.code === "NOT_MINED") return { ok: true, value: null };
      throw e;
    }
    const [after, checks] = await Promise.all([readBalances(chain, ctx.token.address, ctx.sender), admissionChecks(chain, r.hash)]);
    const before = { token: BigInt(h.before.token), eth: BigInt(h.before.eth) };
    return { ok: true, value: liveRun(r, ctx, { quote: BigInt(h.quote), cap: BigInt(h.cap), call: h.call, before, after, checks }) };
  } catch (e) {
    return fail(e);
  }
}

/** Live mode needs a chain that is producing blocks. */
export function chainIsLive(latestBlockTimestamp: number, nowSeconds: number, maxAgeSeconds = 120): boolean {
  return nowSeconds - latestBlockTimestamp <= maxAgeSeconds;
}

/** Where an admitted transaction is, from what the gateway and the miner each report. */
export type PendingState = { state: "mined"; block: number } | { state: "stuck-at-gateway"; admittedAt?: number } | { state: "relayed"; admittedAt?: number } | { state: "dropped"; admittedAt?: number };

export function pendingState(input: { receiptBlock?: number; gatewayHasEntry: boolean; admittedAt?: number; minerSeen: boolean }): PendingState {
  if (input.receiptBlock !== undefined) return { state: "mined", block: input.receiptBlock };
  if (input.minerSeen) return { state: "relayed", admittedAt: input.admittedAt };
  if (input.gatewayHasEntry) return { state: "stuck-at-gateway", admittedAt: input.admittedAt };
  return { state: "dropped", admittedAt: input.admittedAt };
}
