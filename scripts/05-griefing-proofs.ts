/**
 * Gate 2c evidence. Every way a user could skip paying should fail admission, and the paths that do get mined must
 * leave the paymaster whole. A failed user call and a failed refund must not cost the paymaster anything extra.
 */
import { encodeFunctionData, parseUnits, type Address, type Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { addressOf, balanceOf, devnetKey, read, readDeployments, rpc, send } from "./lib/devnet.js";
import { explorerTx, gaslessTx, mined, paymasterTx, sign, toAltMempool, type FrameTx } from "./lib/frames.js";
import { erc20Abi, refundData, settleData, signPermit, submitPermit, validateData } from "./lib/gas-payment.js";

const RECIPIENT: Address = "0x8943545177806ED17B9F23F0a21ee5948eCaa776";
const CAP = parseUnits("8", 6);
const SETTLE_FRAME = 2n;
const SETTLE = { execution: 250_000n, state: 300_000n };

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

async function expectRejected(name: string, t: FrameTx): Promise<boolean> {
  const out = await toAltMempool(t);
  if (out.admitted) {
    console.log(`  ADMITTED, WHICH IS WRONG: ${name}: ${out.hash}`);
    await mined(out.hash);
    return false;
  }
  console.log(`  rejected: ${name}\n    ${out.error.slice(0, 180)}`);
  return true;
}

async function main() {
  console.log(`paymaster ${paymaster}\n\nmust not be admitted:`);
  const u = await newUser();
  const n = await nonceOf(u.address);
  const base = { sender: u.address, paymaster, nonce: n, senderLimit: 1_000n, validateLimit: 55_000n, validateData: validateData(), calls: [{ to: fgUSD, data: transferData(1n), execution: 60_000n, state: 100_000n }] };

  const results = [
    await expectRejected("no settle frame", await sign(paymasterTx({ sender: u.address, paymaster, paymasterData: validateData(), to: RECIPIENT, nonce: n, senderLimit: 1_000n, paymasterLimit: 55_000n }), u.key)),
    await expectRejected("settle frame declares too little execution gas", await sign(gaslessTx({ ...base, settle: { data: settleData(CAP), execution: 199_999n, state: SETTLE.state } }), u.key)),
    await expectRejected("settle frame declares too little state gas", await sign(gaslessTx({ ...base, settle: { data: settleData(CAP), execution: SETTLE.execution, state: 299_999n } }), u.key)),
    await expectRejected("settle frame in an atomic batch with the user's call", await sign(gaslessTx({ ...base, settle: { data: settleData(CAP), ...SETTLE, flags: 4 } }), u.key)),
    await expectRejected("cap below the quote", await sign(gaslessTx({ ...base, settle: { data: settleData(parseUnits("0.1", 6)), ...SETTLE } }), u.key)),
    await expectRejected("cap above the balance", await sign(gaslessTx({ ...base, settle: { data: settleData(parseUnits("21", 6)), ...SETTLE } }), u.key)),
  ];
  const noAllowance = await newUser(false);
  results.push(await expectRejected("no allowance and no permit", await sign(gaslessTx({ ...base, sender: noAllowance.address, nonce: 0n, settle: { data: settleData(CAP), ...SETTLE } }), noAllowance.key)));
  if (results.includes(false)) throw new Error("a griefing path was admitted");

  console.log("\nmined, and the paymaster must not end short:");
  const scenarios: { name: string; call: { execution: bigint; state: bigint; data: Hex }; refund?: { execution: bigint; state: bigint }; expectFrames: string[] }[] = [
    { name: "the user's call reverts: settlement stands", call: { data: transferData(parseUnits("1000", 6)), execution: 60_000n, state: 0n }, refund: { execution: 90_000n, state: 0n }, expectFrames: ["0x1", "0x1", "0x1", "0x0", "0x1"] },
    { name: "the refund frame runs out of gas: the user forfeits it", call: { data: transferData(1n), execution: 60_000n, state: 100_000n }, refund: { execution: 30_000n, state: 0n }, expectFrames: ["0x1", "0x1", "0x1", "0x1", "0x0"] },
    { name: "no refund frame: the user forfeits it", call: { data: transferData(1n), execution: 60_000n, state: 100_000n }, expectFrames: ["0x1", "0x1", "0x1", "0x1"] },
  ];
  for (const s of scenarios) {
    const user = await newUser();
    const floatBefore = await balanceOf(paymaster);
    const tokensBefore = await balance(user.address);
    const t = await sign(
      gaslessTx({
        sender: user.address, paymaster, nonce: 0n, senderLimit: 1_000n, validateLimit: 55_000n, validateData: validateData(),
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
