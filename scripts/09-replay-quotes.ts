/**
 * Recovers the quote each recorded comparison transaction was validated against, for the demo's replay mode.
 *
 * The node keeps no historical state, so `quote()` cannot be called at an old block. The price validation read is the
 * pool's price after the last swap before the settle swap, which the PoolManager's Swap logs record. This applies the
 * paymaster's own `_quote` arithmetic to that price and the max cost the settle frame bought.
 *
 * It also records the sender's token balance around the transaction: today's balance, less what moved since, from the
 * token's Transfer logs. The latest state is readable even though old states are not.
 *
 * Writes docs/evidence/replay-quotes.json. Run: pnpm exec tsx scripts/09-replay-quotes.ts
 */
import fs from "node:fs";
import path from "node:path";
import { decodeAbiParameters, encodeFunctionData, keccak256, parseAbi, toHex, type Hex } from "viem";
import { PREDEPLOYS, rpc } from "./lib/devnet";

const DIR = path.resolve(import.meta.dirname, "..", "docs", "evidence");
const SWAP = keccak256(toHex("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)"));
const SETTLED = keccak256(toHex("Settled(address,uint256,uint256)"));
const TRANSFER = keccak256(toHex("Transfer(address,address,uint256)"));
const Q96 = 2n ** 96n;
const BUFFER_BPS = 500n;

const divUp = (a: bigint, b: bigint) => (a + b - 1n) / b;
/** FrameGasPaymaster._quote, in the same order with the same rounding. */
export const quoteAt = (weiCost: bigint, sqrtPriceX96: bigint) =>
  divUp(divUp(divUp(weiCost * sqrtPriceX96, Q96) * sqrtPriceX96, Q96) * (10_000n + BUFFER_BPS), 10_000n);

interface Log { address: string; topics: Hex[]; data: Hex; blockNumber: Hex; logIndex: Hex; transactionHash: Hex }

async function main() {
  const out: Record<string, unknown> = {};
  for (const file of fs.readdirSync(DIR).filter((f) => /^mempool-comparison-.*\.json$/.test(f))) {
    const d = JSON.parse(fs.readFileSync(path.join(DIR, file), "utf8"));
    const logs: Log[] = d.receipt.logs;
    const settled = logs.find((l) => l.topics[0] === SETTLED)!;
    const [, maxCost] = decodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], settled.data);
    const settleSwap = logs.find((l) => l.topics[0] === SWAP)!;
    const poolId = settleSwap.topics[1]!;
    const block = BigInt(settleSwap.blockNumber);
    // Every swap on this pool up to and including the transaction's block; the one before the settle swap set the price.
    const history: Log[] = await rpc("eth_getLogs", [{ address: PREDEPLOYS.poolManager, topics: [SWAP, poolId], fromBlock: toHex(block - 5_000n), toBlock: toHex(block) }]);
    const before = history.filter((l) => BigInt(l.blockNumber) < block || BigInt(l.logIndex) < BigInt(settleSwap.logIndex)).at(-1);
    if (!before) throw new Error(`no swap before ${d.txHash}`);
    const [, , sqrtPriceX96, , tick] = decodeAbiParameters(
      [{ type: "int128" }, { type: "int128" }, { type: "uint160" }, { type: "uint128" }, { type: "int24" }],
      before.data,
    );
    const quote = quoteAt(maxCost, sqrtPriceX96);

    const sender = d.receipt.from as Hex;
    const fgUSD = logs.find((l) => l.topics[0] === TRANSFER)!.address as Hex;
    const topicOf = (a: Hex) => ("0x" + a.slice(2).toLowerCase().padStart(64, "0")) as Hex;
    const amount = (l: Log) => BigInt(l.data);
    const after = async (fromBlock: bigint) => {
      const out: Log[] = await rpc("eth_getLogs", [{ address: fgUSD, topics: [TRANSFER, topicOf(sender)], fromBlock: toHex(fromBlock), toBlock: "latest" }]);
      const inn: Log[] = await rpc("eth_getLogs", [{ address: fgUSD, topics: [TRANSFER, null, topicOf(sender)], fromBlock: toHex(fromBlock), toBlock: "latest" }]);
      return inn.reduce((s, l) => s + amount(l), 0n) - out.reduce((s, l) => s + amount(l), 0n);
    };
    const data = encodeFunctionData({ abi: parseAbi(["function balanceOf(address) view returns (uint256)"]), functionName: "balanceOf", args: [sender] });
    const now = BigInt(await rpc("eth_call", [{ to: fgUSD, data }, "latest"]));
    const balanceAfter = now - (await after(block + 1n));
    const balanceBefore = now - (await after(block));
    const ethNow = BigInt(await rpc("eth_getBalance", [sender, "latest"]));
    out[d.txHash] = {
      sender,
      token: fgUSD,
      senderTokenBalance: { before: balanceBefore.toString(), after: balanceAfter.toString() },
      senderEthBalanceNow: ethNow.toString(),
      maxCostWei: maxCost.toString(),
      priceFromSwap: { tx: before.transactionHash, block: Number(BigInt(before.blockNumber)), sqrtPriceX96: sqrtPriceX96.toString(), tick },
      quoteTokens: quote.toString(),
    };
    console.log(d.label, d.txHash, `max cost ${maxCost} wei, quote ${quote} at tick ${tick} (from ${before.transactionHash})`);
  }
  fs.writeFileSync(path.join(DIR, "replay-quotes.json"), JSON.stringify(out, null, 2) + "\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
