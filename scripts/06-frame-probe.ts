/**
 * Records what the devnet's frame opcodes actually return, because the settlement design depends on it: gas used per
 * frame, the effective gas price, and whether transient storage survives from one frame to the next.
 */
import { getProfile } from "@forshtat/hegota-support/profiles";
import { toWire } from "@forshtat/hegota-support/rpc";
import * as tx from "@forshtat/hegota-support/tx";
import { decodeEventLog, encodeFunctionData } from "viem";
import { addressOf, artifact, deploy, devnetKey, rpc, waitMined } from "./lib/devnet.js";

const profile = getProfile("ethrex-eip8141-tracer");

async function main() {
  const key = devnetKey("DEVNET_PRIVATE_KEY"); const me = addressOf(key);
  const { abi } = artifact("FrameProbe");
  const probe = await deploy(key, "FrameProbe", [], 0n, 9_000_000n);
  console.log("probe", probe);
  const nonce = BigInt(await rpc("eth_getTransactionCount", [me, "latest"]));
  const t = await tx.signTx(profile, tx.newTx({ chainId: 1337, sender: me, nonceSeq: nonce,
    frames: [
      tx.frame(profile, "VERIFY", { scope: "EXECUTION_AND_PAYMENT", target: null, execution: 30_000n }),
      tx.frame(profile, "SENDER", { target: probe, execution: 60_000n, state: 7_000n, data: encodeFunctionData({ abi, functionName: "mark" }) }),
      tx.frame(profile, "SENDER", { target: probe, execution: 900_000n, state: 11_000n, data: encodeFunctionData({ abi, functionName: "probe" }) }),
    ],
    signatures: [tx.secp256k1Placeholder(profile, "0x")],
    fees: { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000n },
  }), key);
  const hash = await rpc("eth_sendFrameTransaction", [toWire(t)]);
  console.log("tx", hash);
  const r = await waitMined(hash);
  console.log("status", r.status, "gasUsed", BigInt(r.gasUsed), "effectiveGasPrice", r.effectiveGasPrice && BigInt(r.effectiveGasPrice));
  (r.frameReceipts as any[]).forEach((f, i) => console.log(`frame ${i}: status ${f.status} gasUsed ${BigInt(f.gasUsed)} stateGasUsed ${f.stateGasUsed && BigInt(f.stateGasUsed)} logs ${f.logs.length}`));
  for (const f of r.frameReceipts as any[]) for (const l of f.logs) {
    if (l.address.toLowerCase() !== probe.toLowerCase()) continue;
    const e: any = decodeEventLog({ abi, data: l.data, topics: l.topics });
    if (e.eventName === "Facts") console.log("FACTS", Object.fromEntries(Object.entries(e.args).map(([k, v]) => [k, String(v)])));
    else if (e.args.param >= 1n && (e.args.param <= 1n || e.args.param >= 9n)) console.log(`frame ${e.args.frameIndex} param ${e.args.param}: ok=${e.args.ok} value=${e.args.value}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
