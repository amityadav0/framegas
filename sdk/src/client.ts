import { getProfile } from "@forshtat/hegota-support/profiles";
import { toWire } from "@forshtat/hegota-support/rpc";
import * as frameTx from "@forshtat/hegota-support/tx";
import { decodeEventLog, encodeFunctionData, getAddress, zeroHash, type Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { erc20Abi, paymasterAbi } from "./abi.js";
import { httpChain, type Chain, type RawSimulation } from "./chain.js";
import { decodePaymasterError, FrameGasError } from "./errors.js";
import { deriveLimits, type FrameLimit, type Limits, type Simulated } from "./limits.js";

const profile = getProfile("ethrex-eip8141-tracer");

/** Measured on the devnet, with room to spare. Validation does not vary much, and running short only fails admission. */
const VALIDATE_LIMIT = 49_000n;
const VALIDATE_BOOTSTRAP_LIMIT = 54_000n;
const EOA_VERIFY_LIMIT = 200n;
const WALLET_VERIFY_LIMIT = 12_000n;
const DEFAULT_MAX_FEE = 2_000_000_000n;
/** How many transactions' worth of the cap a first approval covers, so the next ones need no approve frame. */
const DEFAULT_APPROVE_MULTIPLE = 20n;
/** The devnet sometimes takes minutes to include an admitted transaction, and occasionally never does. */
const DEFAULT_MINE_TIMEOUT_MS = 600_000;

export interface Call {
  to: Address;
  data?: Hex;
  /** Not supported: the sender holds no ETH, so a frame carrying value would revert. */
  value?: bigint;
}

export interface FrameGasConfig {
  /** Signs transactions. Devnet keys only. */
  privateKey: Hex;
  /** Token address to the paymaster serving it. */
  paymasters: Record<string, Address>;
  /** A contract wallet the key owns. Without it, the key's own account sends. */
  sender?: Address;
  gatewayUrl?: string;
  executionUrl?: string;
  explorerUrl?: string;
  chainId?: number;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  mineTimeoutMs?: number;
  /** Replaces the network, for tests. */
  chain?: Chain;
}

export interface QuoteRequest {
  payToken: Address;
  calls: Call[];
}

export interface SendRequest extends QuoteRequest {
  /** The most the user agrees to pay, in token base units. The user must hold at least this. */
  maxTokenCost: bigint;
  /** What a first transaction approves. Defaults to 20 times the cap. */
  approveAmount?: bigint;
  /** Also submits the same signed bytes to the canonical mempool first, and records its answer. */
  compareMempools?: boolean;
}

export type Mode = "bootstrap" | "normal";

export interface Quote {
  mode: Mode;
  /** The smallest `maxTokenCost` validation accepts right now. The user must also hold this much. */
  requiredTokens: bigint;
  /** What the transaction should cost in tokens after the refund, at the pool's price, including the quote's buffer. */
  estimatedTokens: bigint;
  maxCostWei: bigint;
  estimatedFeeWei: bigint;
  limits: Limits;
  simulations: number;
  warnings: string[];
}

export interface MempoolAnswer {
  admitted: boolean;
  message: string;
}

export interface SendResult {
  mode: Mode;
  hash: Hex;
  explorerUrl: string;
  block: number;
  success: boolean;
  frames: { name: string; success: boolean; gasUsed: bigint; stateGasUsed: bigint }[];
  tokensPaid: bigint;
  tokensRefunded: bigint;
  feeWei: bigint;
  maxCostWei: bigint;
  limits: Limits;
  warnings: string[];
  canonicalMempool?: MempoolAnswer;
}

interface Paymaster {
  address: Address;
  floors: { settle: FrameLimit; approve: FrameLimit; refundBase: bigint; refundPerFrame: bigint };
}

interface Plan {
  mode: Mode;
  paymaster: Paymaster;
  limits: Limits;
  simulated: Simulated;
  simulations: number;
  warnings: string[];
  requiredTokens: bigint;
}

const ok = (status: string | undefined): boolean => status === "0x1";

export function createFrameGas(config: FrameGasConfig) {
  const chain =
    config.chain ??
    httpChain(config.gatewayUrl ?? "https://altmempoolgateway.forshtat.com/rpc", config.executionUrl ?? "https://altmempool.forshtat.com");
  const signer = privateKeyToAccount(config.privateKey);
  const sender = config.sender ?? signer.address;
  const chainId = config.chainId ?? 1337;
  const explorerUrl = (config.explorerUrl ?? "https://explorer.altmempool.wtf").replace(/\/$/, "");
  const maxFeePerGas = config.maxFeePerGas ?? DEFAULT_MAX_FEE;
  const paymasters = new Map(Object.entries(config.paymasters).map(([token, pm]) => [getAddress(token), getAddress(pm)]));
  const cache = new Map<Address, Paymaster>();

  const read = <T>(to: Address, abi: Abi, fn: string, args: readonly unknown[] = []) => chain.read<T>(to, abi, fn, args);

  async function paymasterFor(token: Address): Promise<Paymaster> {
    const address = paymasters.get(getAddress(token));
    if (!address) throw new FrameGasError("UNKNOWN_TOKEN", `no paymaster is registered for token ${token}`, { token });
    const cached = cache.get(address);
    if (cached) return cached;
    const value = (fn: string) => read<bigint>(address, paymasterAbi, fn);
    const [settle, settleState, approve, approveState, refundBase, refundPerFrame] = await Promise.all([
      value("MIN_SETTLE_GAS"),
      value("MIN_SETTLE_STATE_GAS"),
      value("MIN_APPROVE_GAS"),
      value("MIN_APPROVE_STATE_GAS"),
      value("REFUND_GAS_ESTIMATE"),
      value("REFUND_GAS_PER_FRAME"),
    ]);
    const paymaster: Paymaster = {
      address,
      floors: { settle: { execution: settle, state: settleState }, approve: { execution: approve, state: approveState }, refundBase, refundPerFrame },
    };
    cache.set(address, paymaster);
    return paymaster;
  }

  function checkCalls(calls: Call[]): void {
    if (calls.length === 0) throw new FrameGasError("NO_CALLS", "a transaction needs at least one call");
    if (calls.some((c) => (c.value ?? 0n) !== 0n)) {
      throw new FrameGasError("VALUE_NOT_SUPPORTED", "calls cannot carry ETH: the sender holds none, so the frame would revert");
    }
  }

  async function build(
    req: QuoteRequest,
    mode: Mode,
    paymaster: Paymaster,
    limits: Limits,
    cap: bigint,
    approveAmount: bigint,
    senderLimit: bigint,
    nonce: bigint,
  ): Promise<ReturnType<typeof frameTx.newTx>> {
    const settleData = encodeFunctionData({ abi: paymasterAbi, functionName: "settle", args: [cap, 0, zeroHash, zeroHash] });
    const settleIndex = mode === "bootstrap" ? 3n : 2n;
    const frames = [
      frameTx.frame(profile, "VERIFY", { scope: "EXECUTION", target: null, execution: senderLimit }),
      frameTx.frame(profile, "VERIFY", {
        scope: "PAYMENT",
        target: paymaster.address,
        execution: mode === "bootstrap" ? VALIDATE_BOOTSTRAP_LIMIT : VALIDATE_LIMIT,
        data: encodeFunctionData({ abi: paymasterAbi, functionName: "validate" }),
      }),
      ...(mode === "bootstrap"
        ? [
            frameTx.frame(profile, "SENDER", {
              target: req.payToken,
              execution: paymaster.floors.approve.execution,
              state: paymaster.floors.approve.state,
              data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [paymaster.address, approveAmount] }),
            }),
          ]
        : []),
      frameTx.frame(profile, "SENDER", { target: paymaster.address, execution: limits.settle.execution, state: limits.settle.state, data: settleData }),
      ...req.calls.map((c, i) => frameTx.frame(profile, "SENDER", { target: c.to, execution: limits.calls[i]!.execution, state: limits.calls[i]!.state, data: c.data })),
      ...(limits.refund
        ? [
            frameTx.frame(profile, "SENDER", {
              target: paymaster.address,
              execution: limits.refund.execution,
              state: limits.refund.state,
              data: encodeFunctionData({ abi: paymasterAbi, functionName: "refund", args: [settleIndex] }),
            }),
          ]
        : []),
    ];
    const unsigned = frameTx.newTx({
      chainId,
      sender,
      nonceSeq: nonce,
      frames,
      signatures: [frameTx.secp256k1Placeholder(profile, config.sender ? signer.address : "0x")],
      fees: { maxFeePerGas, maxPriorityFeePerGas: config.maxPriorityFeePerGas },
    });
    return frameTx.signTx(profile, unsigned, config.privateKey) as Promise<ReturnType<typeof frameTx.newTx>>;
  }

  /** The frame layout, as the simulator's flat list maps onto it. */
  function toSimulated(raw: RawSimulation, mode: Mode, callCount: number, hasRefund: boolean): Simulated {
    const base: Simulated = { maxCost: BigInt(raw.maxCost), gasUsed: raw.gasUsed ? BigInt(raw.gasUsed) : undefined, error: raw.executionError ?? undefined };
    if (!raw.frames) return base;
    const list = raw.frames.map((f) => ({ succeeded: f.succeeded, gasUsed: BigInt(f.gasUsed) }));
    const settleIndex = mode === "bootstrap" ? 3 : 2;
    return {
      ...base,
      frames: {
        settle: list[settleIndex]!,
        calls: list.slice(settleIndex + 1, settleIndex + 1 + callCount),
        refund: hasRefund ? list[settleIndex + 1 + callCount] : undefined,
      },
    };
  }

  /** Decides the mode and limits by simulating, using the largest cap the user could sign, so any cap is judged after. */
  async function plan(req: QuoteRequest, cap: bigint | undefined, approveAmount: bigint | undefined): Promise<Plan & { build: (limits: Limits, finalCap: bigint, finalApprove: bigint) => ReturnType<typeof build> }> {
    checkCalls(req.calls);
    const paymaster = await paymasterFor(req.payToken);
    const [balance, allowance, nonceHex, code] = await Promise.all([
      read<bigint>(req.payToken, erc20Abi, "balanceOf", [sender]),
      read<bigint>(req.payToken, erc20Abi, "allowance", [sender, paymaster.address]),
      chain.rpc("eth_getTransactionCount", [sender, "latest"]),
      chain.rpc("eth_getCode", [sender, "latest"]),
    ]);
    if (cap !== undefined && balance < cap) {
      throw new FrameGasError("INSUFFICIENT_BALANCE", `the sender holds ${balance} of the token, below the ${cap} cap`, { balance, maxTokenCost: cap });
    }
    if (balance === 0n) throw new FrameGasError("INSUFFICIENT_BALANCE", "the sender holds none of the token", { balance });

    // An allowance covering the cap needs no approve frame. Without a cap, any allowance short of the balance is judged
    // against what the transaction turns out to need, below.
    const wanted = cap ?? balance;
    const mode: Mode = allowance >= wanted ? "normal" : "bootstrap";
    const probeCap = mode === "normal" ? (allowance < balance ? allowance : balance) : balance;
    const probeApprove = approveAmount && approveAmount > probeCap ? approveAmount : probeCap;

    const senderLimit = code === "0x" ? EOA_VERIFY_LIMIT : WALLET_VERIFY_LIMIT;
    const nonce = BigInt(nonceHex);
    const framesBeforeRefund = BigInt(2 + (mode === "bootstrap" ? 1 : 0) + 1 + req.calls.length);
    const refund: FrameLimit = { execution: paymaster.floors.refundBase + framesBeforeRefund * paymaster.floors.refundPerFrame, state: 0n };

    const buildWith = (limits: Limits, finalCap: bigint, finalApprove: bigint) =>
      build(req, mode, paymaster, limits, finalCap, finalApprove, senderLimit, nonce);

    const outcome = await deriveLimits(
      async (limits) => {
        const signed = await buildWith(limits, probeCap, probeApprove);
        const raw = await chain.simulate(frameTx.encodeTx(profile, signed));
        return toSimulated(raw, mode, req.calls.length, limits.refund !== undefined);
      },
      { settle: paymaster.floors.settle, refund },
      req.calls.length,
    );

    if (!outcome.ok) {
      if (outcome.reason === "VALIDATION") {
        throw new FrameGasError("VALIDATION_FAILED", `the paymaster would refuse this transaction: ${outcome.error}`, { error: outcome.error });
      }
      if (outcome.reason === "SETTLEMENT") {
        throw new FrameGasError("SETTLEMENT_WILL_FAIL", "settlement fails in simulation at every limit tried, so the pool is probably too thin. Nothing was sent", { tried: outcome.tried });
      }
      throw new FrameGasError("CALL_WILL_REVERT", `call ${outcome.callIndex} reverts in simulation at every limit tried. Nothing was sent`, { callIndex: outcome.callIndex });
    }

    const requiredTokens = await read<bigint>(paymaster.address, paymasterAbi, "quote", [outcome.simulated.maxCost]);
    return { mode, paymaster, limits: outcome.limits, simulated: outcome.simulated, simulations: outcome.simulations, warnings: outcome.warnings, requiredTokens, build: buildWith };
  }

  /** What the sender holds and has approved for a token's paymaster. */
  async function account(payToken: Address): Promise<{ sender: Address; paymaster: Address; balance: bigint; allowance: bigint }> {
    const paymaster = await paymasterFor(payToken);
    const [balance, allowance] = await Promise.all([
      read<bigint>(payToken, erc20Abi, "balanceOf", [sender]),
      read<bigint>(payToken, erc20Abi, "allowance", [sender, paymaster.address]),
    ]);
    return { sender, paymaster: paymaster.address, balance, allowance };
  }

  /** Works out what a transaction would cost, by simulating it. Nothing is sent. */
  async function quote(req: QuoteRequest): Promise<Quote> {
    let p = await plan(req, undefined, undefined);
    // Judged against the whole balance, a partial allowance looks short. It may still cover this transaction.
    if (p.mode === "bootstrap") {
      const allowance = await read<bigint>(req.payToken, erc20Abi, "allowance", [sender, p.paymaster.address]);
      if (allowance >= p.requiredTokens) p = await plan(req, allowance, undefined);
    }
    const maxCostWei = p.simulated.maxCost;
    const estimatedFeeWei = (p.simulated.gasUsed ?? 0n) * maxFeePerGas;
    const estimatedTokens = await read<bigint>(p.paymaster.address, paymasterAbi, "quote", [estimatedFeeWei]);
    return { mode: p.mode, requiredTokens: p.requiredTokens, estimatedTokens, maxCostWei, estimatedFeeWei, limits: p.limits, simulations: p.simulations, warnings: p.warnings };
  }

  /** Simulates, then quotes, builds, signs and broadcasts. Raises before sending when the simulation says it would fail. */
  async function send(req: SendRequest): Promise<SendResult> {
    const p = await plan(req, req.maxTokenCost, req.approveAmount);
    if (req.maxTokenCost < p.requiredTokens) {
      throw new FrameGasError("CAP_TOO_LOW", `this transaction needs a maxTokenCost of at least ${p.requiredTokens}`, { requiredTokens: p.requiredTokens, maxTokenCost: req.maxTokenCost });
    }
    const approveAmount = req.approveAmount ?? req.maxTokenCost * DEFAULT_APPROVE_MULTIPLE;
    if (p.mode === "bootstrap" && approveAmount < req.maxTokenCost) {
      throw new FrameGasError("CAP_TOO_LOW", "approveAmount must cover maxTokenCost", { approveAmount, maxTokenCost: req.maxTokenCost });
    }
    const signed = await p.build(p.limits, req.maxTokenCost, approveAmount);
    const raw = frameTx.encodeTx(profile, signed);

    let canonicalMempool: MempoolAnswer | undefined;
    if (req.compareMempools) canonicalMempool = await tryCanonical(raw);

    let hash: Hex;
    try {
      hash = await chain.rpc("eth_sendFrameTransaction", [toWire(signed)]);
    } catch (e) {
      const message = (e as Error).message;
      const decoded = decodePaymasterError(message);
      throw new FrameGasError("REJECTED", `the alt-mempool rejected the transaction: ${decoded ? decoded.name : message}`, { message, decoded });
    }

    const receipt = await waitForReceipt(hash);
    return summarise(hash, receipt, p, req, canonicalMempool);
  }

  async function tryCanonical(raw: Hex): Promise<MempoolAnswer> {
    try {
      const hash = await chain.rpc("eth_sendRawTransaction", [raw]);
      return { admitted: true, message: hash };
    } catch (e) {
      return { admitted: false, message: (e as Error).message };
    }
  }

  async function waitForReceipt(hash: Hex): Promise<any> {
    const deadline = Date.now() + (config.mineTimeoutMs ?? DEFAULT_MINE_TIMEOUT_MS);
    for (;;) {
      const receipt = await chain.rpc("eth_getTransactionReceipt", [hash]);
      if (receipt) return receipt;
      if (Date.now() >= deadline) {
        throw new FrameGasError("NOT_MINED", `${hash} was admitted but not mined in time. It may still be mined`, { hash, explorerUrl: `${explorerUrl}/tx/${hash}` });
      }
      await new Promise((resolve) => setTimeout(resolve, config.chain ? 0 : 2_000));
    }
  }

  function summarise(hash: Hex, receipt: any, p: Plan, req: SendRequest, canonicalMempool: MempoolAnswer | undefined): SendResult {
    const names = ["sender verify", "paymaster validate", ...(p.mode === "bootstrap" ? ["approve"] : []), "settle", ...req.calls.map((_, i) => `call ${i}`), ...(p.limits.refund ? ["refund"] : [])];
    const frameReceipts: any[] = receipt.frameReceipts ?? [];
    let tokensPaid = 0n;
    let tokensRefunded = 0n;
    for (const frame of frameReceipts) {
      for (const log of frame.logs ?? []) {
        if (getAddress(log.address) !== p.paymaster.address) continue;
        try {
          const event = decodeEventLog({ abi: paymasterAbi, data: log.data, topics: log.topics });
          if (event.eventName === "Settled") tokensPaid += event.args.tokensPaid;
          if (event.eventName === "Refunded") tokensRefunded += event.args.tokensReturned;
        } catch {
          // A log this contract emitted that is not settlement, such as a reference update.
        }
      }
    }
    return {
      mode: p.mode,
      hash,
      explorerUrl: `${explorerUrl}/tx/${hash}`,
      block: Number(receipt.blockNumber),
      success: ok(receipt.status) && frameReceipts.every((f) => ok(f.status)),
      frames: frameReceipts.map((f, i) => ({ name: names[i] ?? `frame ${i}`, success: ok(f.status), gasUsed: BigInt(f.gasUsed), stateGasUsed: BigInt(f.stateGasUsed ?? 0) })),
      tokensPaid,
      tokensRefunded,
      feeWei: BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice ?? maxFeePerGas),
      maxCostWei: p.simulated.maxCost,
      limits: p.limits,
      warnings: p.warnings,
      canonicalMempool,
    };
  }

  return { quote, send, account, sender };
}

export type FrameGas = ReturnType<typeof createFrameGas>;
