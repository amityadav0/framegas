/**
 * Gate 2c evidence. Every way a user could skip paying should fail admission, and the paths that do get mined must
 * leave the paymaster whole. A failed user call and a failed refund must not cost the paymaster anything extra.
 */
import { encodeFunctionData, parseUnits, toFunctionSelector, type Address, type Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { addressOf, balanceOf, devnetKey, read, readDeployments, rpc, send } from "./lib/devnet.js";
import { explorerTx, gaslessTx, mined, paymasterTx, sign, toAltMempool, type FrameTx } from "./lib/frames.js";
import { approveData, erc20Abi, LIMITS, refundData, refundLimit, settleData, signPermit, submitPermit, validateData } from "./lib/gas-payment.js";

const RECIPIENT: Address = "0x8943545177806ED17B9F23F0a21ee5948eCaa776";
const CAP = parseUnits("5", 6);
const SETTLE_FRAME = 2n;
const SETTLE = { execution: LIMITS.settle, state: LIMITS.settleState };
const APPROVE = { execution: LIMITS.approve, state: LIMITS.approveState };

const paymasterErrors: Record<string, string> = {
  SettleNotBound: "SettleNotBound()",
  SettleGasTooLow: "SettleGasTooLow(uint256,uint256)",
  SettleInAtomicBatch: "SettleInAtomicBatch()",
  SettleMalformed: "SettleMalformed()",
  CostAboveCap: "CostAboveCap(uint256,uint256)",
  InsufficientBalance: "InsufficientBalance(uint256,uint256)",
  InsufficientAllowance: "InsufficientAllowance(uint256,uint256)",
  MaxCostTooHigh: "MaxCostTooHigh(uint256,uint256)",
  ApproveNotBound: "ApproveNotBound()",
  ApproveGasTooLow: "ApproveGasTooLow(uint256,uint256)",
};

const d = readDeployments();
const fgUSD = d.fgUSD as Address;
const paymaster = d.paymaster as Address;
const deployerKey = devnetKey("DEVNET_PRIVATE_KEY");
const balance = (a: Address) => read<bigint>(fgUSD, erc20Abi, "balanceOf", [a]);
const transferData = (amount: bigint): Hex => encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [RECIPIENT, amount] });

async function newUser(allow = true): Promise<{ key: Hex; address: Address }> {
  const key = generatePrivateKey();
  const address = addressOf(key);
  await send(deployerKey, { to: fgUSD, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [address, parseUnits("20", 6)] }) });
  if (allow) await submitPermit(deployerKey, address, fgUSD, paymaster, CAP, await signPermit(key, fgUSD, paymaster, CAP));
  return { key, address };
}

const nonceOf = async (a: Address) => BigInt(await rpc("eth_getTransactionCount", [a, "latest"]));

/** Admission must fail, and with this contract error, not merely some failure. */
async function expectRejected(name: string, error: string, t: FrameTx): Promise<boolean> {
  const out = await toAltMempool(t);
  if (out.admitted) {
    console.log(`  ADMITTED, WHICH IS WRONG: ${name}: ${out.hash}`);
    await mined(out.hash);
    return false;
  }
  const selector = toFunctionSelector(paymasterErrors[error]!);
  if (!out.error.includes(selector)) {
    console.log(`  REJECTED FOR THE WRONG REASON: ${name}: wanted ${error}: ${out.error.slice(0, 200)}`);
    return false;
  }
  console.log(`  rejected: ${name}: ${error}`);
  return true;
}

async function main() {
  console.log(`paymaster ${paymaster}\n\nmust not be admitted:`);
  const u = await newUser();
  const n = await nonceOf(u.address);
  const base = { sender: u.address, paymaster, nonce: n, senderLimit: LIMITS.sender, validateLimit: LIMITS.validateBootstrap, validateData: validateData(), calls: [{ to: fgUSD, data: transferData(1n), execution: 60_000n, state: 0n }] };
  const fresh = await newUser(false);
  const boot = { ...base, sender: fresh.address, nonce: 0n, settle: { data: settleData(CAP), ...SETTLE } };
  const bootstrap = (approve: Partial<typeof APPROVE> & { data?: Hex; to?: Address; flags?: number; value?: bigint }) =>
    sign(gaslessTx({ ...boot, approve: { to: fgUSD, data: approveData(paymaster, CAP), ...APPROVE, ...approve } }), fresh.key);

  const short = settleData(CAP).slice(0, 2 + 2 * 36) as Hex;
  const results = [
    await expectRejected("no settle frame", "SettleNotBound", await sign(paymasterTx({ sender: u.address, paymaster, paymasterData: validateData(), to: RECIPIENT, nonce: n, senderLimit: LIMITS.sender, paymasterLimit: LIMITS.validateBootstrap }), u.key)),
    await expectRejected("settle frame declares too little execution gas", "SettleGasTooLow", await sign(gaslessTx({ ...base, settle: { data: settleData(CAP), execution: LIMITS.settle - 1n, state: SETTLE.state } }), u.key)),
    await expectRejected("settle frame in an atomic batch with the user's call", "SettleInAtomicBatch", await sign(gaslessTx({ ...base, settle: { data: settleData(CAP), ...SETTLE, flags: 4 } }), u.key)),
    await expectRejected("settle frame sends ETH the user does not have", "SettleMalformed", await sign(gaslessTx({ ...base, settle: { data: settleData(CAP), ...SETTLE, value: 1n } }), u.key)),
    await expectRejected("settle frame calldata is too short", "SettleMalformed", await sign(gaslessTx({ ...base, settle: { data: short, ...SETTLE } }), u.key)),
    await expectRejected("cap below the quote", "CostAboveCap", await sign(gaslessTx({ ...base, settle: { data: settleData(parseUnits("0.1", 6)), ...SETTLE } }), u.key)),
    await expectRejected("cap above the balance", "InsufficientBalance", await sign(gaslessTx({ ...base, settle: { data: settleData(parseUnits("21", 6)), ...SETTLE } }), u.key)),
    await expectRejected("maximum cost above the per-transaction limit", "MaxCostTooHigh", await sign(gaslessTx({ ...base, calls: [{ to: fgUSD, data: transferData(1n), execution: 1_500_000n, state: 0n }], settle: { data: settleData(CAP), ...SETTLE } }), u.key)),
    await expectRejected("no allowance and no permit", "InsufficientAllowance", await sign(gaslessTx(boot), fresh.key)),
    await expectRejected("bootstrap: another function on the token", "ApproveNotBound", await bootstrap({ data: transferData(CAP) })),
    await expectRejected("bootstrap: another spender", "ApproveNotBound", await bootstrap({ data: approveData(RECIPIENT, CAP) })),
    await expectRejected("bootstrap: amount below the cap", "ApproveNotBound", await bootstrap({ data: approveData(paymaster, CAP - 1n) })),
    await expectRejected("bootstrap: trailing data", "ApproveNotBound", await bootstrap({ data: `${approveData(paymaster, CAP)}00` as Hex })),
    await expectRejected("bootstrap: approve sends ETH", "ApproveNotBound", await bootstrap({ value: 1n })),
    await expectRejected("bootstrap: approve in an atomic batch", "ApproveNotBound", await bootstrap({ flags: 4 })),
    await expectRejected("bootstrap: too little execution gas", "ApproveGasTooLow", await bootstrap({ execution: LIMITS.approve - 1n })),
    await expectRejected("bootstrap: too little state gas", "ApproveGasTooLow", await bootstrap({ state: LIMITS.approveState - 1n })),
  ];
  if (results.includes(false)) throw new Error("a griefing path was admitted");

  console.log("\nmined, and the paymaster must not end short:");
  const scenarios: { name: string; call: { execution: bigint; state: bigint; data: Hex }; refund?: { execution: bigint; state: bigint }; expectFrames: string[] }[] = [
    { name: "the user's call reverts: settlement stands", call: { data: transferData(parseUnits("1000", 6)), execution: 60_000n, state: 0n }, refund: { execution: refundLimit(4n), state: 0n }, expectFrames: ["0x1", "0x1", "0x1", "0x0", "0x1"] },
    { name: "the refund frame runs out of gas: the user forfeits it", call: { data: transferData(1n), execution: 60_000n, state: 0n }, refund: { execution: 30_000n, state: 0n }, expectFrames: ["0x1", "0x1", "0x1", "0x1", "0x0"] },
    { name: "no refund frame: the user forfeits it", call: { data: transferData(1n), execution: 60_000n, state: 0n }, expectFrames: ["0x1", "0x1", "0x1", "0x1"] },
  ];
  for (const s of scenarios) {
    const user = await newUser();
    const floatBefore = await balanceOf(paymaster);
    const tokensBefore = await balance(user.address);
    const t = await sign(
      gaslessTx({
        sender: user.address, paymaster, nonce: 0n, senderLimit: LIMITS.sender, validateLimit: LIMITS.validateBootstrap, validateData: validateData(),
        settle: { data: settleData(CAP), ...SETTLE },
        calls: [{ to: fgUSD, ...s.call }],
        refund: s.refund && { data: refundData(SETTLE_FRAME), ...s.refund },
      }),
      user.key,
    );
    const out = await toAltMempool(t);
    if (!out.admitted) throw new Error(`${s.name}: rejected: ${out.error}`);
    const r = await mined(out.hash);
    const floatAfter = await balanceOf(paymaster);
    const statuses = r.frames.map((f) => f.status);
    const paid = tokensBefore - (await balance(user.address));
    console.log(`  ${s.name}\n    ${explorerTx(out.hash)}\n    frames ${statuses.join(" ")}, user paid ${paid} (cap ${CAP}), paymaster ${floatAfter - floatBefore >= 0n ? "+" : ""}${floatAfter - floatBefore} wei`);
    if (statuses.join() !== s.expectFrames.join()) throw new Error(`unexpected frame statuses, wanted ${s.expectFrames.join(" ")}`);
    if (floatAfter < floatBefore) throw new Error("the paymaster ended short");
    if (paid > CAP) throw new Error("the user paid more than the cap");
  }
  console.log("\nall hold");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
