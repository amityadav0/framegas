/** Deploys FrameGasPaymaster on the devnet pool, and signs the permits and frames its transactions need. */
import { encodeFunctionData, parseAbi, parseEther, type Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { artifact, deploy, PREDEPLOYS, read, send } from "./devnet.js";

const PERMIT_DEADLINE = 2n ** 256n - 1n;

export const paymasterAbi = (): Abi => artifact("FrameGasPaymaster").abi;
export const erc20Abi = parseAbi([
  "function transfer(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function nonces(address) view returns (uint256)",
]);

export interface PaymasterParams {
  minSettleGas: bigint;
  minSettleStateGas: bigint;
  refundGasEstimate: bigint;
  floatEth?: string;
}

export async function deployPaymaster(key: Hex, fgUSD: Address, p: PaymasterParams): Promise<Address> {
  const stake = parseEther("0.012");
  const config = {
    poolManager: PREDEPLOYS.poolManager,
    registry: PREDEPLOYS.stakingRegistry,
    payToken: fgUSD,
    fee: 3000,
    tickSpacing: 60,
    maxDeviation: 1000, // about 10.5%, wide enough that ordinary swaps do not evict pending transactions
    bufferBps: 500n,
    stakeAmount: stake,
    unstakeDelaySec: 86_400,
    minSettleGas: p.minSettleGas,
    minSettleStateGas: p.minSettleStateGas,
    refundGasEstimate: p.refundGasEstimate,
  };
  return deploy(key, "FrameGasPaymaster", [config], stake + parseEther(p.floatEth ?? "0.02"), 25_000_000n);
}

export const validateData = (): Hex => encodeFunctionData({ abi: paymasterAbi(), functionName: "validate" });
export const refundData = (settleFrame: bigint): Hex => encodeFunctionData({ abi: paymasterAbi(), functionName: "refund", args: [settleFrame] });

export interface PermitSignature {
  v: number;
  r: Hex;
  s: Hex;
}

/** Signs an unexpiring permit for exactly `cap`, the only kind validation can check. */
export async function signPermit(userKey: Hex, fgUSD: Address, paymaster: Address, cap: bigint): Promise<PermitSignature> {
  const user = privateKeyToAccount(userKey);
  const nonce = await read<bigint>(fgUSD, erc20Abi, "nonces", [user.address]);
  const signature = await user.signTypedData({
    domain: { name: "FrameGas USD", version: "1", chainId: 1337, verifyingContract: fgUSD },
    types: {
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Permit",
    message: { owner: user.address, spender: paymaster, value: cap, nonce, deadline: PERMIT_DEADLINE },
  });
  return { r: `0x${signature.slice(2, 66)}`, s: `0x${signature.slice(66, 130)}`, v: parseInt(signature.slice(130, 132), 16) };
}

/** Calldata for `settle`. Without a permit it relies on an existing allowance. */
export function settleData(cap: bigint, permit?: PermitSignature): Hex {
  const zero: Hex = `0x${"00".repeat(32)}`;
  return encodeFunctionData({ abi: paymasterAbi(), functionName: "settle", args: [cap, permit?.v ?? 0, permit?.r ?? zero, permit?.s ?? zero] });
}

/** Submits a signed permit in an ordinary transaction. Anyone can do this, and the user spends no ETH. */
export async function submitPermit(payerKey: Hex, owner: Address, fgUSD: Address, spender: Address, cap: bigint, permit: PermitSignature): Promise<void> {
  const abi = parseAbi(["function permit(address owner,address spender,uint256 value,uint256 deadline,uint8 v,bytes32 r,bytes32 s)"]);
  await send(payerKey, { to: fgUSD, data: encodeFunctionData({ abi, functionName: "permit", args: [owner, spender, cap, PERMIT_DEADLINE, permit.v, permit.r, permit.s] }) });
}
