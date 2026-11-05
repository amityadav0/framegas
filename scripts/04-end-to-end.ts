/**
 * Gate 2c. One user holding zero ETH sends two transactions, with no relayer and no precompile:
 *   bootstrap: approve, settle, user call, refund
 *   normal:    settle, user call, refund
 * The outcome is checked on chain rather than trusted from frame statuses.
 *
 * `--permit-in-frame` instead sends the permit path, which needs `ecrecover` in validation. The devnet's sidecar refuses
 * it while its config has `precompiles: []`, so that run records the node's answer.
 */
import { encodeFunctionData, parseUnits, type Address, type Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { addressOf, balanceOf, devnetKey, read, readDeployments, recordDeployments, rpc, send } from "./lib/devnet.js";
import { executes, explorerTx, gaslessTx, maxFeePerGas, mined, sign, simulate, toAltMempool, type FrameTx } from "./lib/frames.js";
import { approveData, deployPaymaster, erc20Abi, LIMITS, paymasterAbi, refundData, refundLimit, settleData, signPermit, validateData, type PermitSignature } from "./lib/gas-payment.js";

const RECIPIENT: Address = "0x8943545177806ED17B9F23F0a21ee5948eCaa776";
const SENT = parseUnits("1", 6);
const ALLOWANCE = parseUnits("50", 6); // the user's budget for this paymaster
const CALL = { execution: 16_000n, state: 0n };
const MAX_RESERVE_RATIO = 1.5;

const argFlag = (name: string) => process.argv.includes(name);

async function main() {
  const deployerKey = devnetKey("DEVNET_PRIVATE_KEY");
  const d = readDeployments();
  const fgUSD = d.fgUSD as Address;
  const paymaster = (!argFlag("--fresh") && (d.paymaster as Address | undefined)) || (await deployPaymaster(deployerKey, fgUSD));
  recordDeployments({ paymaster });
  console.log(`paymaster ${paymaster}`);

  // A brand-new key every run: it has never held ETH and has no allowance.
  const userKey = generatePrivateKey();
  const user = addressOf(userKey);
  await send(deployerKey, { to: fgUSD, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [user, parseUnits("100", 6)] }) });
  const balance = (a: Address) => read<bigint>(fgUSD, erc20Abi, "balanceOf", [a]);
  console.log(`user ${user}: ${await balanceOf(user)} wei, allowance ${await read<bigint>(fgUSD, erc20Abi, "allowance", [user, paymaster])}\n`);

  const transfer = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [RECIPIENT, SENT] });
  const nonce = async () => BigInt(await rpc("eth_getTransactionCount", [user, "latest"]));

  async function run(name: string, build: () => Promise<FrameTx>, frameNames: string[]): Promise<void> {
    const t = await build();
    const sim = await simulate(t);
    if (!executes(sim)) throw new Error(`${name}: simulation failed, so nothing was sent: ${sim.executionError ?? ""} ${JSON.stringify((sim.frames ?? []).map((f) => [parseInt(f.gasUsed, 16), f.succeeded]))}`);
    const maxCost = BigInt(sim.maxCost);

    const before = { user: await balance(user), float: await balanceOf(paymaster), recipient: await balance(RECIPIENT) };
    const result = await toAltMempool(t);
    if (!result.admitted) {
      console.log(`${name}: rejected by the alt-mempool: ${result.error}\n`);
      if (argFlag("--permit-in-frame")) return;
      throw new Error("rejected");
    }
    const r = await mined(result.hash);
    const after = { user: await balance(user), float: await balanceOf(paymaster), recipient: await balance(RECIPIENT), eth: await balanceOf(user) };
    const fee = r.gasUsed * r.effectiveGasPrice;
    const paid = before.user - after.user - SENT;
    const ratio = Number(maxCost) / Number(fee);
    const feeInTokens = ((await read<bigint>(paymaster, paymasterAbi(), "quote", [fee])) * 10_000n) / 10_500n;

    console.log(`${name}: ${explorerTx(result.hash)}`);
    console.log(`  block ${r.block}, gas used ${r.gasUsed}, price ${r.effectiveGasPrice}`);
    frameNames.forEach((frame, i) => {
      const f = r.frames[i]!;
      console.log(`  ${i} ${frame.padEnd(20)} status ${f.status}  gas ${String(f.gasUsed).padStart(6)}  state gas ${f.stateGasUsed}`);
    });
    console.log(`  fee ${fee} wei, reserved ${maxCost} wei: ${ratio.toFixed(3)}x`);
    console.log(`  user paid ${paid} fgUSD units, the fee is worth ${feeInTokens}: ${(Number(paid) / Number(feeInTokens)).toFixed(3)}x`);
    console.log(`  tokens the user must hold: ${await read<bigint>(paymaster, paymasterAbi(), "quote", [maxCost])}`);
    console.log(`  paymaster ETH ${after.float - before.float >= 0n ? "+" : ""}${after.float - before.float} wei, user ETH ${after.eth}\n`);

    const failures = [
      after.eth !== 0n && "the user holds ETH",
      r.status !== "0x1" && "the transaction failed",
      r.frames.some((f) => f.status !== "0x1") && "a frame failed",
      after.recipient - before.recipient !== SENT && "the user call did not land",
      paid <= 0n && "the user paid nothing",
      after.float < before.float && "the paymaster ended short",
      ratio > MAX_RESERVE_RATIO && `the reserve is ${ratio.toFixed(3)}x the fee, above ${MAX_RESERVE_RATIO}x`,
    ].filter(Boolean);
    if (failures.length) throw new Error(`${name}: invariants failed: ${failures.join(", ")}`);
    recordDeployments({ [`${name}Tx`]: result.hash });
  }

  const baseTx = async () => ({ sender: user, paymaster, nonce: await nonce(), senderLimit: LIMITS.sender, validateData: validateData() });
  const call = [{ to: fgUSD, data: transfer, ...CALL }];

  if (argFlag("--permit-in-frame")) {
    const cap = parseUnits("5", 6);
    const permit: PermitSignature = await signPermit(userKey, fgUSD, paymaster, cap);
    await run("permitInFrame", async () =>
      sign(gaslessTx({ ...(await baseTx()), validateLimit: LIMITS.validateBootstrap, settle: { data: settleData(cap, permit), execution: LIMITS.settle, state: LIMITS.settlePermitState }, calls: call, refund: { data: refundData(2n), execution: refundLimit(4n), state: 0n } }), userKey),
      ["sender verify", "paymaster validate", "settle with permit", "user call", "refund"]);
    return;
  }

  await run("bootstrap", async () =>
    sign(gaslessTx({
      ...(await baseTx()),
      validateLimit: LIMITS.validateBootstrap,
      approve: { to: fgUSD, data: approveData(paymaster, ALLOWANCE), execution: LIMITS.approve, state: LIMITS.approveState },
      settle: { data: settleData(parseUnits("4", 6)), execution: LIMITS.settle, state: LIMITS.settleState },
      calls: call,
      refund: { data: refundData(3n), execution: refundLimit(5n), state: 0n },
    }), userKey),
    ["sender verify", "paymaster validate", "approve", "settle", "user call", "refund"]);

  await run("normal", async () =>
    sign(gaslessTx({
      ...(await baseTx()),
      validateLimit: LIMITS.validate,
      settle: { data: settleData(parseUnits("3", 6)), execution: LIMITS.settle, state: LIMITS.settleState },
      calls: call,
      refund: { data: refundData(2n), execution: refundLimit(4n), state: 0n },
    }), userKey),
    ["sender verify", "paymaster validate", "settle", "user call", "refund"]);

  console.log(`all invariants hold. max fee ${maxFeePerGas} wei`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
