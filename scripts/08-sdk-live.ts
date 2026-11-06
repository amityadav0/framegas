/**
 * Gate 4.1 on the devnet, through the SDK only: a first and a second transaction with two calls each, recording both
 * mempools' answers, and a first-ever tick crossing where the SDK has to find the state gas settlement needs.
 */
import fs from "node:fs";
import { createFrameGas, type SendResult } from "@framegas/sdk";
import { encodeFunctionData, formatUnits, parseUnits, type Address, type Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { addressOf, devnetKey, readDeployments, rpc, send } from "./lib/devnet.js";
import { erc20Abi } from "./lib/gas-payment.js";

const RECIPIENTS: Address[] = ["0x8943545177806ED17B9F23F0a21ee5948eCaa776", "0x000000000000000000000000000000000000dEaD"];
// A thin pool from scripts/07-thin-pool.ts whose next swap crosses a tick for the first time.
const THIN = { token: "0x601e8c20e53154778316bf7262b58475d8946680" as Address, paymaster: "0xe475c6cb9da46f34ce7d453ce2310b9995df1564" as Address };

const deployerKey = devnetKey("DEVNET_PRIVATE_KEY");

async function fundedUser(token: Address): Promise<Hex> {
  const key = generatePrivateKey();
  await send(deployerKey, { to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [addressOf(key), parseUnits("100", 6)] }) });
  return key;
}

const transfer = (token: Address, to: Address, amount: bigint) => ({ to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] }) });

function print(label: string, r: SendResult): void {
  console.log(`\n${label}: ${r.mode}, ${r.explorerUrl}`);
  for (const f of r.frames) console.log(`  ${f.name.padEnd(20)} ${f.success ? "ok    " : "FAILED"} gas ${String(f.gasUsed).padStart(6)}  state gas ${f.stateGasUsed}`);
  console.log(`  declared: settle ${r.limits.settle.execution}/${r.limits.settle.state}, calls ${r.limits.calls.map((c) => `${c.execution}/${c.state}`).join(", ")}, refund ${r.limits.refund ? `${r.limits.refund.execution}/${r.limits.refund.state}` : "none"}`);
  console.log(`  paid ${formatUnits(r.tokensPaid, 6)}, refunded ${formatUnits(r.tokensRefunded, 6)}, reserve ${(Number(r.maxCostWei) / Number(r.feeWei)).toFixed(3)}x the fee`);
  if (r.canonicalMempool) console.log(`  canonical mempool: ${r.canonicalMempool.admitted ? "ADMITTED" : `rejected: ${r.canonicalMempool.message}`}`);
  if (r.warnings.length) console.log(`  warnings: ${r.warnings.join("; ")}`);
}

async function main() {
  const d = readDeployments() as { fgUSD: Address; paymasters: Record<string, Address> };
  const results: Record<string, unknown> = {};

  const key = await fundedUser(d.fgUSD);
  const framegas = createFrameGas({ privateKey: key, paymasters: d.paymasters });
  const calls = RECIPIENTS.map((to) => transfer(d.fgUSD, to, parseUnits("0.5", 6)));
  for (const label of ["first", "second"]) {
    const quote = await framegas.quote({ payToken: d.fgUSD, calls });
    console.log(`\nquote ${label}: ${quote.mode}, needs ${formatUnits(quote.requiredTokens, 6)}, expects ${formatUnits(quote.estimatedTokens, 6)}, ${quote.simulations} simulations`);
    const r = await framegas.send({ payToken: d.fgUSD, maxTokenCost: (quote.requiredTokens * 102n) / 100n, calls, compareMempools: true });
    print(`${label} transaction, two calls`, r);
    if (!r.success) throw new Error(`${label} transaction failed`);
    if (r.canonicalMempool?.admitted) throw new Error("the canonical mempool admitted it");
    results[label] = { hash: r.hash, mode: r.mode, canonical: r.canonicalMempool };
  }

  // The thin pool's paymaster is gone after a devnet reset until 07-thin-pool.ts runs again.
  if ((await rpc("eth_getCode", [THIN.paymaster, "latest"])) === "0x") {
    console.log(`\nfirst-ever tick crossing: skipped, no paymaster at ${THIN.paymaster} on this chain (rerun 07-thin-pool.ts and update THIN)`);
    fs.writeFileSync(new URL("../docs/evidence/sdk-live.json", import.meta.url), `${JSON.stringify(results, null, 2)}\n`);
    return;
  }
  const thinKey = await fundedUser(THIN.token);
  const thin = createFrameGas({ privateKey: thinKey, paymasters: { [THIN.token]: THIN.paymaster } });
  const call = [transfer(THIN.token, RECIPIENTS[0]!, 1n)];
  const quote = await thin.quote({ payToken: THIN.token, calls: call });
  console.log(`\nthin pool quote: settle declares ${quote.limits.settle.execution} gas and ${quote.limits.settle.state} state gas, ${quote.simulations} simulations`);
  const r = await thin.send({ payToken: THIN.token, maxTokenCost: (quote.requiredTokens * 102n) / 100n, calls: call });
  print("first-ever tick crossing", r);
  if (!r.success) throw new Error("the crossing transaction failed");
  results.crossing = { hash: r.hash, settleState: r.limits.settle.state.toString() };

  fs.writeFileSync(new URL("../docs/evidence/sdk-live.json", import.meta.url), `${JSON.stringify(results, null, 2)}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
