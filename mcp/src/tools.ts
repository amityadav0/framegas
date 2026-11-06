/**
 * The three tools, as plain functions over the SDK, so they can be tested without an MCP transport. Amounts cross the
 * boundary as decimal strings in token units ("1.5"), because agents handle those better than base units.
 */
import { FrameGasError, type FrameGas, type SendResult } from "@framegas/sdk";
import { formatEther, formatUnits, getAddress, isAddress, parseUnits, type Address, type Hex } from "viem";

export interface TokenInfo {
  symbol: string;
  address: Address;
  decimals: number;
}

export interface ToolContext {
  framegas: FrameGas;
  tokens: TokenInfo[];
}

export interface CallInput {
  to: string;
  data?: string;
}

/** A token by symbol, case-insensitive, or by address. */
export function resolveToken(tokens: TokenInfo[], ref: string): TokenInfo {
  const bySymbol = tokens.find((t) => t.symbol.toLowerCase() === ref.toLowerCase());
  if (bySymbol) return bySymbol;
  if (isAddress(ref, { strict: false })) {
    const byAddress = tokens.find((t) => getAddress(t.address) === getAddress(ref));
    if (byAddress) return byAddress;
  }
  throw new FrameGasError("UNKNOWN_TOKEN", `unknown token ${ref}. Known: ${tokens.map((t) => t.symbol).join(", ")}`);
}

function toCalls(calls: CallInput[]): { to: Address; data?: Hex }[] {
  return calls.map((c, i) => {
    if (!isAddress(c.to, { strict: false })) throw new FrameGasError("NO_CALLS", `call ${i} has an invalid address: ${c.to}`);
    if (c.data !== undefined && !/^0x([0-9a-fA-F]{2})*$/.test(c.data)) throw new FrameGasError("NO_CALLS", `call ${i} has invalid calldata`);
    return { to: getAddress(c.to), data: c.data as Hex | undefined };
  });
}

export async function quoteTool(ctx: ToolContext, input: { payToken: string; calls: CallInput[] }) {
  const token = resolveToken(ctx.tokens, input.payToken);
  const q = await ctx.framegas.quote({ payToken: token.address, calls: toCalls(input.calls) });
  return {
    token: token.symbol,
    mode: q.mode,
    firstTransaction: q.mode === "bootstrap",
    requiredTokens: formatUnits(q.requiredTokens, token.decimals),
    estimatedTokens: formatUnits(q.estimatedTokens, token.decimals),
    maxCostEth: formatEther(q.maxCostWei),
    estimatedFeeEth: formatEther(q.estimatedFeeWei),
    note: "Use requiredTokens as maxTokenCost, or more. The user must hold at least maxTokenCost.",
    warnings: q.warnings,
  };
}

export async function sendTool(ctx: ToolContext, input: { payToken: string; maxTokenCost: string; calls: CallInput[]; compareMempools?: boolean }) {
  const token = resolveToken(ctx.tokens, input.payToken);
  const r: SendResult = await ctx.framegas.send({
    payToken: token.address,
    maxTokenCost: parseUnits(input.maxTokenCost, token.decimals),
    calls: toCalls(input.calls),
    compareMempools: input.compareMempools,
  });
  return {
    success: r.success,
    mode: r.mode,
    hash: r.hash,
    explorerUrl: r.explorerUrl,
    block: r.block,
    tokensPaid: formatUnits(r.tokensPaid, token.decimals),
    tokensRefunded: formatUnits(r.tokensRefunded, token.decimals),
    netCost: formatUnits(r.tokensPaid - r.tokensRefunded, token.decimals),
    feeEth: formatEther(r.feeWei),
    frames: r.frames.map((f) => ({ name: f.name, success: f.success, gasUsed: f.gasUsed.toString() })),
    canonicalMempool: r.canonicalMempool,
    warnings: r.warnings,
  };
}

export async function budgetTool(ctx: ToolContext, input: { payToken: string; calls?: CallInput[] }) {
  const token = resolveToken(ctx.tokens, input.payToken);
  const [account, q0] = await Promise.all([ctx.framegas.account(token.address), ctx.framegas.quoteRemaining(undefined, token.address)]);
  const units = (v: bigint) => formatUnits(v, token.decimals);
  const quota = q0.active
    ? { active: true, limit: units(q0.limit), spent: units(q0.spent), remaining: units(q0.remaining), epoch: q0.epoch, resetsAtBlock: q0.resetsAtBlock.toString() }
    : { active: false };
  const base = {
    token: token.symbol,
    sender: account.sender,
    paymaster: account.paymaster,
    balance: units(account.balance),
    allowance: units(account.allowance),
    quota,
  };
  if (!input.calls?.length) return base;
  const q = await ctx.framegas.quote({ payToken: token.address, calls: toCalls(input.calls) });
  const affordable = q.estimatedTokens > 0n ? account.balance / q.estimatedTokens : 0n;
  return {
    ...base,
    nextTransaction: {
      mode: q.mode,
      requiredTokens: formatUnits(q.requiredTokens, token.decimals),
      estimatedTokens: formatUnits(q.estimatedTokens, token.decimals),
    },
    canSendNow: account.balance >= q.requiredTokens && q0.remaining >= q.requiredTokens,
    transactionsLikeThisAffordable: Number(affordable),
  };
}

/** A tool failure as the agent should see it: the SDK's code, its message and anything it can act on. */
export function describeError(e: unknown): { code: string; message: string; details?: Record<string, string> } {
  if (e instanceof FrameGasError) {
    const details = Object.fromEntries(Object.entries(e.details).filter(([, v]) => typeof v !== "object").map(([k, v]) => [k, String(v)]));
    return { code: e.code, message: e.message, details };
  }
  return { code: "UNEXPECTED", message: e instanceof Error ? e.message : String(e) };
}
