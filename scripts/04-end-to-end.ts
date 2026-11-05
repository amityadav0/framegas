/**
 * Gate 2c. One transaction from a user holding zero ETH: permit, pull, swap, refill, user call, refund.
 * It checks the outcome on chain rather than trusting the frame statuses.
 */
import { encodeFunctionData, parseUnits, type Address, type Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { addressOf, balanceOf, devnetKey, read, readDeployments, recordDeployments, rpc, send } from "./lib/devnet.js";
import { executes, explorerTx, gaslessTx, mined, sign, simulate, toAltMempool } from "./lib/frames.js";
import { deployPaymaster, erc20Abi, paymasterAbi, refundData, settleData, signPermit, submitPermit, validateData } from "./lib/gas-payment.js";

const RECIPIENT: Address = "0x8943545177806ED17B9F23F0a21ee5948eCaa776";
const CAP = parseUnits("8", 6);
const SENT = parseUnits("1", 6);
const SETTLE_FRAME = 2n;

// Settlement is about 136k. Each new storage slot costs 97,920 state gas here, and the worst case is three: the permit
// nonce, the allowance, and a pool fee-growth slot. Validation requires these, so a user cannot starve settlement.
const MIN_SETTLE_GAS = 200_000n;
const MIN_SETTLE_STATE_GAS = 300_000n;
const argValue = (name: string, fallback: bigint): bigint => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? BigInt(process.argv[i + 1]!) : fallback;
};
const REFUND_GAS_ESTIMATE = argValue("--refund-estimate", 200_000n);
const REFUND_STATE = argValue("--refund-state", 0n);

const argFlag = (name: string) => process.argv.includes(name);

async function main() {
  const deployerKey = devnetKey("DEVNET_PRIVATE_KEY");
  const d = readDeployments();
  const fgUSD = d.fgUSD as Address;
  const paymaster = (!argFlag("--fresh") && (d.paymaster as Address | undefined)) ||
    (await deployPaymaster(deployerKey, fgUSD, { minSettleGas: MIN_SETTLE_GAS, minSettleStateGas: MIN_SETTLE_STATE_GAS, refundGasEstimate: REFUND_GAS_ESTIMATE }));
  recordDeployments({ paymaster });
  console.log(`paymaster ${paymaster}`);

  // A brand-new key every run: it has never held ETH and has no allowance.
  const userKey = generatePrivateKey();
  const user = addressOf(userKey);
  await send(deployerKey, { to: fgUSD, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [user, parseUnits("100", 6)] }) });

  const balance = (a: Address) => read<bigint>(fgUSD, erc20Abi, "balanceOf", [a]);
  const before = { userEth: await balanceOf(user), userToken: await balance(user), float: await balanceOf(paymaster), recipient: await balance(RECIPIENT) };
  console.log(`user ${user}: ${before.userEth} wei, ${before.userToken} fgUSD units, allowance ${await read<bigint>(fgUSD, erc20Abi, "allowance", [user, paymaster])}`);

  // The devnet's sidecar rejects any precompile call in validation (`precompiles: []` in its config), so it cannot
  // admit a permit checked in the frame. By default the signed permit goes in its own transaction, which anyone can pay
  // for. `--permit-in-frame` sends the transaction shape the rules intend, to record the node's answer.
  const permit = await signPermit(userKey, fgUSD, paymaster, CAP);
  const inFrame = argFlag("--permit-in-frame");
  if (!inFrame) await submitPermit(deployerKey, user, fgUSD, paymaster, CAP, permit);

  const transfer = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [RECIPIENT, SENT] });
  const build = async () =>
    sign(
      gaslessTx({
        sender: user,
        paymaster,
        nonce: BigInt(await rpc("eth_getTransactionCount", [user, "latest"])),
        senderLimit: 1_000n,
        validateLimit: 55_000n,
        validateData: validateData(),
        settle: { data: settleData(CAP, inFrame ? permit : undefined), execution: 250_000n, state: MIN_SETTLE_STATE_GAS },
        calls: [{ to: fgUSD, data: transfer, execution: 60_000n, state: 100_000n }],
        refund: { data: refundData(SETTLE_FRAME), execution: REFUND_GAS_ESTIMATE, state: REFUND_STATE },
      }),
      userKey,
    );

  const t = await build();
  const sim = await simulate(t);
  console.log(`simulation: ${sim.executionStatus}, ${sim.executionError ?? "no error"} ${sim.haltDetail ?? ""}`);
  console.log(`  frames: ${JSON.stringify(sim.frames)}`);
  console.log(`  max cost ${BigInt(sim.maxCost)} wei`);
  if (!executes(sim)) throw new Error("simulation did not execute cleanly, so nothing was sent");
  if (argFlag("--simulate")) return;

  const result = await toAltMempool(t);
  if (!result.admitted) {
    console.log(`rejected by the alt-mempool: ${result.error}`);
    if (inFrame) return;
    throw new Error("rejected");
  }
  const r = await mined(result.hash);
  const after = { userEth: await balanceOf(user), userToken: await balance(user), float: await balanceOf(paymaster), recipient: await balance(RECIPIENT) };
  const maxCost = BigInt(sim.maxCost);
  const fee = r.gasUsed * r.effectiveGasPrice;
  const tokensSpent = before.userToken - after.userToken - SENT;

  console.log(`\nadmitted ${explorerTx(result.hash)}\nblock ${r.block}, status ${r.status}, price ${r.effectiveGasPrice}, gas used ${r.gasUsed}`);
  ["sender verify", "paymaster validate", "settle", "user call", "refund"].forEach((name, i) => {
    const f = r.frames[i]!;
    console.log(`  ${i} ${name.padEnd(19)} status ${f.status}  gas ${f.gasUsed}  state gas ${f.stateGasUsed}`);
  });
  console.log(`user ETH ${before.userEth} -> ${after.userEth}`);
  console.log(`user fgUSD spent on gas ${tokensSpent} (cap ${CAP})`);
  console.log(`recipient fgUSD +${after.recipient - before.recipient}`);
  console.log(`paymaster ETH ${before.float} -> ${after.float} (${after.float - before.float >= 0n ? "+" : ""}${after.float - before.float})`);
  console.log(`fee ${fee} wei of max ${maxCost} wei, ${(Number(maxCost) / Number(fee)).toFixed(2)}x`);
  const feeInTokens = ((await read<bigint>(paymaster, paymasterAbi(), "quote", [fee])) * 10_000n) / 10_500n;
  console.log(`fee at pool price ${feeInTokens} fgUSD units, so the user paid ${(Number(tokensSpent) / Number(feeInTokens)).toFixed(3)}x the fee`);

  const failures = [
    after.userEth !== 0n && "the user holds ETH",
    r.status !== "0x1" && "the transaction failed",
    r.frames.some((f) => f.status !== "0x1") && "a frame failed",
    after.recipient - before.recipient !== SENT && "the user call did not land",
    tokensSpent > CAP && "the user paid more than the cap",
    tokensSpent <= 0n && "the user paid nothing",
    after.float < before.float && "the paymaster ended short",
  ].filter(Boolean);
  if (failures.length) throw new Error(`invariants failed: ${failures.join(", ")}`);
  console.log("all invariants hold");
  recordDeployments({ endToEndTx: result.hash });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
