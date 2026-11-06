/**
 * QuotaPolicy on the devnet: deploys a quota-enabled paymaster on the current fgUSD pool, then measures the validation
 * frame with and without a quota in both modes, and shows the SDK refusing a cap above what the quota leaves.
 *
 *   pnpm exec tsx scripts/10-quota-live.ts            deploys a new paymaster
 *   pnpm exec tsx scripts/10-quota-live.ts 0xabc…     reuses one
 */
import fs from "node:fs";
import { createFrameGas, FrameGasError, paymasterAbi as sdkPaymasterAbi, type SendResult } from "@framegas/sdk";
import { encodeFunctionData, formatUnits, getAddress, parseUnits, type Address, type Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { addressOf, devnetKey, readDeployments, recordDeployments, send } from "./lib/devnet.js";
import { deployPaymaster, erc20Abi } from "./lib/gas-payment.js";

const RECIPIENT: Address = "0x8943545177806ED17B9F23F0a21ee5948eCaa776";
const QUOTA = parseUnits("10", 6);
const deployerKey = devnetKey("DEVNET_PRIVATE_KEY");

const transfer = (token: Address) => ({ to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [RECIPIENT, 1n] }) });
const setQuota = (paymaster: Address, amount: bigint) => ({ to: paymaster, data: encodeFunctionData({ abi: sdkPaymasterAbi, functionName: "setQuota", args: [amount] }) });

async function user(token: Address): Promise<Hex> {
  const key = generatePrivateKey();
  await send(deployerKey, { to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [addressOf(key), parseUnits("100", 6)] }) });
  return key;
}

const rows: Record<string, unknown>[] = [];
function record(label: string, quota: boolean, r: SendResult): void {
  const validate = r.frames[1]!;
  console.log(`\n${label}: ${r.mode}, quota ${quota ? "on" : "off"}, ${r.explorerUrl}`);
  for (const f of r.frames) console.log(`  ${f.name.padEnd(20)} ${f.success ? "ok    " : "FAILED"} ${String(f.gasUsed).padStart(7)} / ${f.gasLimit}${f.stateGasLimit ? `  state ${f.stateGasUsed} / ${f.stateGasLimit}` : ""}`);
  rows.push({ label, mode: r.mode, quota, hash: r.hash, block: r.block, success: r.success, validateGasUsed: validate.gasUsed.toString(), validateGasLimit: validate.gasLimit.toString(), frames: r.frames.map((f) => ({ name: f.name, gasUsed: f.gasUsed.toString(), gasLimit: f.gasLimit.toString(), stateGasUsed: f.stateGasUsed.toString(), stateGasLimit: f.stateGasLimit.toString(), success: f.success })) });
  if (!r.success) throw new Error(`${label}: a frame failed`);
}

async function sendVia(key: Hex, token: Address, paymaster: Address, calls: { to: Address; data: Hex }[], approveAmount?: bigint): Promise<SendResult> {
  const fg = createFrameGas({ privateKey: key, paymasters: { [token]: paymaster } });
  const q = await fg.quote({ payToken: token, calls });
  return fg.send({ payToken: token, maxTokenCost: (q.requiredTokens * 102n) / 100n, calls, approveAmount });
}

async function main() {
  const d = readDeployments() as { fgUSD: Address; paymaster: Address; paymasters: Record<string, Address> };
  const token = getAddress(d.fgUSD);
  let paymaster = process.argv[2] as Address | undefined;
  if (!paymaster) {
    paymaster = await deployPaymaster(deployerKey, token);
    console.log(`deployed quota paymaster ${paymaster}`);
    recordDeployments({ paymaster, paymasterPreQuota: d.paymaster, paymasters: { [token]: paymaster }, tokens: { fgUSD: { ...(readDeployments().tokens as any).fgUSD, paymaster } } });
  }

  // A: no quota, bootstrap then normal.
  const a = await user(token);
  record("A1 first transaction", false, await sendVia(a, token, paymaster, [transfer(token)]));
  record("A2 second transaction", false, await sendVia(a, token, paymaster, [transfer(token)]));

  // B: opts in during its first transaction, approving only that transaction's cap, so the next one is bootstrap too.
  const b = await user(token);
  const fgB = createFrameGas({ privateKey: b, paymasters: { [token]: paymaster } });
  const optIn = [setQuota(paymaster, QUOTA)];
  const q = await fgB.quote({ payToken: token, calls: optIn });
  const cap = (q.requiredTokens * 102n) / 100n;
  record("B1 opt-in (setQuota in a bootstrap transaction)", false, await fgB.send({ payToken: token, maxTokenCost: cap, calls: optIn, approveAmount: cap }));
  record("B2 bootstrap under quota", true, await sendVia(b, token, paymaster, [transfer(token)]));
  record("B3 normal under quota", true, await sendVia(b, token, paymaster, [transfer(token)]));

  const status = await fgB.quoteRemaining();
  console.log(`\nB's quota: limit ${formatUnits(status.limit, 6)}, spent ${formatUnits(status.spent, 6)}, remaining ${formatUnits(status.remaining, 6)}, epoch ${status.epoch}, resets from block ${status.resetsAtBlock}`);

  let refusal: string | undefined;
  try {
    await fgB.send({ payToken: token, maxTokenCost: status.remaining + 1n, calls: [transfer(token)] });
  } catch (e) {
    if (!(e instanceof FrameGasError) || e.code !== "QUOTA_EXCEEDED") throw e;
    refusal = e.message;
    console.log(`cap of remaining + 1: refused, ${e.code}: ${e.message}`);
  }

  fs.writeFileSync(new URL("../docs/evidence/quota-live.json", import.meta.url), `${JSON.stringify({ paymaster, quota: QUOTA.toString(), rows, remaining: { ...status, limit: status.limit.toString(), spent: status.spent.toString(), remaining: status.remaining.toString(), resetsAtBlock: status.resetsAtBlock.toString() }, refusal }, null, 2)}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
