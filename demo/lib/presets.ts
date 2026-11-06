/** The demo's live actions, as call lists for the SDK. Each needs a demo contract from the deployment record. */
import { encodeFunctionData, parseAbi, parseUnits, zeroAddress, type Address } from "viem";
import type { Call } from "@framegas/sdk";

export type PresetId = "swap" | "supply";

export interface PresetContext {
  sender: Address;
  token: { address: Address; decimals: number; symbol: string; fee: number; tickSpacing: number };
  demo: { swapRouter?: Address; lendingPool?: Address };
}

export const PRESETS: { id: PresetId; label: string; needs: keyof PresetContext["demo"] }[] = [
  { id: "swap", label: "Swap 5 fgUSD → ETH", needs: "swapRouter" },
  { id: "supply", label: "Supply 5 fgUSD (mock Aave)", needs: "lendingPool" },
];

const erc20 = parseAbi(["function approve(address,uint256) returns (bool)"]);
const swapRouter = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "struct SwapParams { bool zeroForOne; int256 amountSpecified; uint160 sqrtPriceLimitX96; }",
  "struct TestSettings { bool takeClaims; bool settleUsingBurn; }",
  "function swap(PoolKey key, SwapParams params, TestSettings testSettings, bytes hookData) payable returns (int256)",
]);
const lendingPool = parseAbi(["function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)"]);
/** TickMath.MAX_SQRT_PRICE - 1: no price limit when selling currency1 for currency0. */
const NO_LIMIT_SELLING_TOKEN = 1461446703485210103287273052203988822378723970341n;

export function presetCalls(id: PresetId, ctx: PresetContext): { calls: Call[]; label: string } {
  const amount = parseUnits("5", ctx.token.decimals);
  const approve = (spender: Address): Call => ({ to: ctx.token.address, data: encodeFunctionData({ abi: erc20, functionName: "approve", args: [spender, amount] }) });
  const preset = PRESETS.find((p) => p.id === id);
  const target = preset && ctx.demo[preset.needs];
  if (!preset || !target) throw new Error(`the deployment has no ${preset?.needs ?? id} contract. Run scripts/redeploy.sh --fresh`);
  if (id === "swap") {
    const key = { currency0: zeroAddress, currency1: ctx.token.address, fee: ctx.token.fee, tickSpacing: ctx.token.tickSpacing, hooks: zeroAddress };
    const params = { zeroForOne: false, amountSpecified: -amount, sqrtPriceLimitX96: NO_LIMIT_SELLING_TOKEN };
    const swap = encodeFunctionData({ abi: swapRouter, functionName: "swap", args: [key, params, { takeClaims: false, settleUsingBurn: false }, "0x"] });
    return { calls: [approve(target), { to: target, data: swap }], label: preset.label };
  }
  const supply = encodeFunctionData({ abi: lendingPool, functionName: "supply", args: [ctx.token.address, amount, ctx.sender, 0] });
  return { calls: [approve(target), { to: target, data: supply }], label: preset.label };
}
