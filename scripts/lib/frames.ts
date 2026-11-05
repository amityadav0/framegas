/** Builds, signs and submits frame transactions with `@forshtat/hegota-support`, bound to this devnet's profile. */
import { getProfile } from "@forshtat/hegota-support/profiles";
import { toWire } from "@forshtat/hegota-support/rpc";
import * as tx from "@forshtat/hegota-support/tx";
import { type Address, type Hex } from "viem";
import { CHAIN_ID, EXPLORER, rpc, rpcAt, waitMined } from "./devnet.js";

const profile = getProfile("ethrex-eip8141-tracer");
const MAX_FEE_PER_GAS = 2_000_000_000n; // 2 gwei, as the workshop uses
const ETHREX_URL = "https://altmempool.forshtat.com";

export interface PaymasterTxInit {
  sender: Address;
  /** The account that signs. For a contract wallet this is its owner; for an EOA it is the sender. */
  signer?: Address;
  paymaster: Address;
  paymasterData: Hex;
  to: Address;
  nonce: bigint;
  senderLimit: bigint;
  paymasterLimit: bigint;
  executionLimit?: bigint;
  /** State gas for the user frame. Writing a new storage slot needs it on this devnet. */
  executionState?: bigint;
  data?: Hex;
}

/** `[only_verify, pay, user_op]`: the sender authorises, the paymaster pays. */
export function paymasterTx(a: PaymasterTxInit) {
  return tx.newTx({
    chainId: CHAIN_ID,
    sender: a.sender,
    nonceSeq: a.nonce,
    frames: [
      tx.frame(profile, "VERIFY", { scope: "EXECUTION", target: null, execution: a.senderLimit }),
      tx.frame(profile, "VERIFY", { scope: "PAYMENT", target: a.paymaster, execution: a.paymasterLimit, data: a.paymasterData }),
      tx.frame(profile, "SENDER", { target: a.to, execution: a.executionLimit ?? 50_000n, state: a.executionState, data: a.data }),
    ],
    signatures: [tx.secp256k1Placeholder(profile, a.signer ?? "0x")],
    fees: { maxFeePerGas: MAX_FEE_PER_GAS },
  });
}

export type FrameTx = ReturnType<typeof paymasterTx>;

export interface GaslessTxInit {
  sender: Address;
  signer?: Address;
  paymaster: Address;
  nonce: bigint;
  senderLimit: bigint;
  validateLimit: bigint;
  validateData: Hex;
  /** Bootstrap mode: `PAY_TOKEN.approve(paymaster, n)`, right before settlement. */
  approve?: { to: Address; data: Hex; execution: bigint; state: bigint; flags?: number; value?: bigint };
  settle: { data: Hex; execution: bigint; state: bigint; flags?: number; value?: bigint };
  /** The user's calls, one frame each. They run after settlement. */
  calls: { to: Address; data?: Hex; execution: bigint; state?: bigint }[];
  /** Best effort, so it may be left out. It must be the last frame. */
  refund?: { data: Hex; execution: bigint; state: bigint };
  maxPriorityFeePerGas?: bigint;
}

/** `[only_verify, pay, (approve), settle, user calls..., refund]`: the full FrameGas transaction. */
export function gaslessTx(a: GaslessTxInit): FrameTx {
  return tx.newTx({
    chainId: CHAIN_ID,
    sender: a.sender,
    nonceSeq: a.nonce,
    frames: [
      tx.frame(profile, "VERIFY", { scope: "EXECUTION", target: null, execution: a.senderLimit }),
      tx.frame(profile, "VERIFY", { scope: "PAYMENT", target: a.paymaster, execution: a.validateLimit, data: a.validateData }),
      ...(a.approve ? [tx.frame(profile, "SENDER", { target: a.approve.to, execution: a.approve.execution, state: a.approve.state, data: a.approve.data, flags: a.approve.flags, value: a.approve.value })] : []),
      tx.frame(profile, "SENDER", { target: a.paymaster, execution: a.settle.execution, state: a.settle.state, data: a.settle.data, flags: a.settle.flags, value: a.settle.value }),
      ...a.calls.map((c) => tx.frame(profile, "SENDER", { target: c.to, execution: c.execution, state: c.state, data: c.data })),
      ...(a.refund ? [tx.frame(profile, "SENDER", { target: a.paymaster, execution: a.refund.execution, state: a.refund.state, data: a.refund.data })] : []),
    ],
    signatures: [tx.secp256k1Placeholder(profile, a.signer ?? "0x")],
    fees: { maxFeePerGas: MAX_FEE_PER_GAS, maxPriorityFeePerGas: a.maxPriorityFeePerGas },
  });
}

export const sign = (t: FrameTx, key: Hex): Promise<FrameTx> => tx.signTx(profile, t, key) as Promise<FrameTx>;
export const maxFeePerGas = MAX_FEE_PER_GAS;
export const hashOf = (t: FrameTx): Hex => tx.txHash(profile, t);
export const rawOf = (t: FrameTx): Hex => tx.encodeTx(profile, t);
export const explorerTx = (hash: Hex): string => `${EXPLORER}/tx/${hash}`;

export type Outcome = { admitted: true; hash: Hex } | { admitted: false; error: string };

/** Submits to the standard alt-mempool. A rejection is a result here, because several proofs expect one. */
export async function toAltMempool(t: FrameTx): Promise<Outcome> {
  try {
    return { admitted: true, hash: await rpc("eth_sendFrameTransaction", [toWire(t)]) };
  } catch (e) {
    return { admitted: false, error: (e as Error).message };
  }
}

/** Submits the raw transaction, which the gateway forwards to ethrex: the canonical mempool's verdict. */
export async function toCanonicalMempool(t: FrameTx): Promise<Outcome> {
  try {
    return { admitted: true, hash: await rpc("eth_sendRawTransaction", [rawOf(t)]) };
  } catch (e) {
    return { admitted: false, error: (e as Error).message };
  }
}

export interface Mined {
  block: number;
  status: string;
  frames: { status: string; gasUsed: bigint; stateGasUsed: bigint }[];
  gasUsed: bigint;
  effectiveGasPrice: bigint;
}

export async function mined(hash: Hex): Promise<Mined> {
  const r = await waitMined(hash);
  return {
    block: Number(r.blockNumber),
    status: r.status,
    gasUsed: BigInt(r.gasUsed ?? r.cumulativeGasUsed ?? 0),
    effectiveGasPrice: BigInt(r.effectiveGasPrice ?? 0),
    frames: (r.frameReceipts ?? []).map((f: { status: string; gasUsed: string; stateGasUsed?: string }) => ({
      status: f.status,
      gasUsed: BigInt(f.gasUsed),
      stateGasUsed: BigInt(f.stateGasUsed ?? 0),
    })),
  };
}

/** The sidecar's rule-by-rule report for a transaction. */
export const admissionReport = (hash: Hex): Promise<any> => rpc("skandha_explorer_getTransaction", [hash]);

/** The live response. `devnet-readme.md` documents `valid` and `violation`, which the running build does not return. */
export interface Simulation {
  canonicalMempoolValid: boolean;
  canonicalMempoolViolation: string | null;
  executionStatus: "success" | "reverted" | null;
  executionError: string | null;
  haltDetail?: string;
  frames: { gasUsed: string; succeeded: boolean }[] | null;
  maxCost: string;
  erc7562Trace?: unknown;
  erc7562TraceError?: string;
}

/** Dry-runs a transaction with ethrex's own checks. This never submits anything. */
export async function simulate(t: FrameTx, trace = false): Promise<Simulation> {
  return rpcAt(ETHREX_URL, "ethrex_simulateFrameTransaction", [rawOf(t), "latest", { trace }]);
}

/** Whether every frame ran to success. This ignores canonical-mempool verdicts, which a staked paymaster always fails. */
export const executes = (s: Simulation): boolean => s.executionStatus === "success" && (s.frames ?? []).every((f) => f.succeeded);
