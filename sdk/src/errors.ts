import { decodeErrorResult, type Hex } from "viem";
import { paymasterAbi } from "./abi.js";

export type FrameGasErrorCode =
  | "UNKNOWN_TOKEN"
  | "INSUFFICIENT_BALANCE"
  | "CAP_TOO_LOW"
  | "QUOTA_EXCEEDED"
  | "COST_TOO_HIGH"
  | "VALUE_NOT_SUPPORTED"
  | "NO_CALLS"
  | "VALIDATION_FAILED"
  | "SETTLEMENT_WILL_FAIL"
  | "CALL_WILL_REVERT"
  | "REJECTED"
  | "NOT_MINED";

/** Every failure the SDK raises itself. `details` holds what a caller needs to react, such as the tokens required. */
export class FrameGasError extends Error {
  constructor(
    readonly code: FrameGasErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "FrameGasError";
  }
}

const REVERT_DATA = /0x[0-9a-fA-F]{8,}/;

/** The paymaster error inside a node's rejection text, when there is one. The sidecar reports raw revert data. */
export function decodePaymasterError(message: string): { name: string; args: readonly unknown[] } | undefined {
  const match = message.match(REVERT_DATA);
  if (!match) return undefined;
  try {
    const decoded = decodeErrorResult({ abi: paymasterAbi, data: match[0] as Hex });
    return { name: decoded.errorName, args: (decoded.args ?? []) as readonly unknown[] };
  } catch {
    return undefined;
  }
}
