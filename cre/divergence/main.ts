/**
 * FrameGas price watch. Every 5 minutes: reads mainnet's native ETH/USDC v4 pool with an EVM read, reads the devnet
 * fgUSD pool through the alt-mempool gateway over HTTP (falling back to the snapshot taken from
 * deployments/devnet.json when the devnet is halted or unreachable), and compares the two ETH prices. Above the
 * threshold it logs an alert and prepares the paymaster's `syncReference()` call with a tick bound around mainnet.
 * The write is mocked: the payload is logged, nothing is sent.
 */
import {
  bytesToHex,
  consensusIdenticalAggregation,
  cre,
  type CronPayload,
  encodeCallMsg,
  getNetwork,
  hexToBase64,
  type HTTPSendRequester,
  LAST_FINALIZED_BLOCK_NUMBER,
  ok,
  Runner,
  type Runtime,
  text,
} from "@chainlink/cre-sdk";
import { decodeFunctionResult, encodeFunctionData, type Hex, parseAbi, toHex, zeroAddress } from "viem";
import { z } from "zod";

const configSchema = z.object({
  schedule: z.string(),
  thresholdBps: z.number().int().positive(),
  boundTicks: z.number().int().positive(),
  staleSeconds: z.number().int().positive(),
  mainnet: z.object({ chainSelectorName: z.string(), stateView: z.string(), poolId: z.string() }),
  devnet: z.object({
    gatewayUrl: z.string(),
    stateView: z.string(),
    poolId: z.string(),
    paymaster: z.string(),
    fallback: z.object({ sqrtPriceX96: z.string(), tick: z.number().int(), block: z.number().int(), source: z.string() }),
  }),
});
type Config = z.infer<typeof configSchema>;

const stateViewAbi = parseAbi(["function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)"]);
const paymasterAbi = parseAbi(["function syncReference()"]);

const Q192 = 2n ** 192n;
/** Both pools are native ETH (18 decimals) against a 6-decimal dollar token, ETH being currency0: price = sqrtP² / 2^192 × 10^12. */
const priceE6 = (sqrtPriceX96: bigint): bigint => (sqrtPriceX96 * sqrtPriceX96 * 10n ** 18n) / Q192;
const usd = (e6: bigint): string => `${e6 / 10n ** 6n}.${(e6 % 10n ** 6n).toString().padStart(6, "0").slice(0, 2)}`;

interface Slot0 {
  sqrtPriceX96: bigint;
  tick: number;
}

function readMainnet(runtime: Runtime<Config>): Slot0 {
  const { chainSelectorName, stateView, poolId } = runtime.config.mainnet;
  const network = getNetwork({ chainFamily: "evm", chainSelectorName, isTestnet: false });
  if (!network) throw new Error(`unknown chain ${chainSelectorName}`);
  const evm = new cre.capabilities.EVMClient(network.chainSelector.selector);
  const reply = evm
    .callContract(runtime, {
      call: encodeCallMsg({ from: zeroAddress, to: stateView as Hex, data: encodeFunctionData({ abi: stateViewAbi, functionName: "getSlot0", args: [poolId as Hex] }) }),
      blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
    })
    .result();
  const [sqrtPriceX96, tick] = decodeFunctionResult({ abi: stateViewAbi, functionName: "getSlot0", data: bytesToHex(reply.data) });
  return { sqrtPriceX96, tick };
}

const rpcBody = (method: string, params: unknown[]): string => hexToBase64(toHex(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })));

/**
 * One node's view of the devnet: `ok|sqrtPriceX96|tick|blockNumber|blockTimestamp`, or `down|reason`. A string, so
 * nodes agree on it with identical aggregation.
 */
const fetchDevnet = (http: HTTPSendRequester, config: Config): string => {
  const post = (method: string, params: unknown[]) => {
    const res = http.sendRequest({ url: config.devnet.gatewayUrl, method: "POST", headers: { "content-type": "application/json" }, body: rpcBody(method, params) }).result();
    if (!ok(res)) throw new Error(`${method}: HTTP ${res.statusCode}`);
    const body = JSON.parse(text(res)) as { result?: unknown; error?: { message: string } };
    if (body.error || body.result === undefined || body.result === null) throw new Error(`${method}: ${body.error?.message ?? "no result"}`);
    return body.result;
  };
  try {
    const block = post("eth_getBlockByNumber", ["latest", false]) as { number: Hex; timestamp: Hex };
    const data = encodeFunctionData({ abi: stateViewAbi, functionName: "getSlot0", args: [config.devnet.poolId as Hex] });
    const out = post("eth_call", [{ to: config.devnet.stateView, data }, block.number]) as Hex;
    const [sqrtPriceX96, tick] = decodeFunctionResult({ abi: stateViewAbi, functionName: "getSlot0", data: out });
    if (sqrtPriceX96 === 0n) return "down|pool not initialised on this chain (devnet reset?)";
    return `ok|${sqrtPriceX96}|${tick}|${BigInt(block.number)}|${BigInt(block.timestamp)}`;
  } catch (e) {
    return `down|${e instanceof Error ? e.message : String(e)}`;
  }
};

function readDevnet(runtime: Runtime<Config>): Slot0 & { source: string } {
  const http = new cre.capabilities.HTTPClient();
  const answer = http.sendRequest(runtime, fetchDevnet, consensusIdenticalAggregation<string>())(runtime.config).result();
  const fb = runtime.config.devnet.fallback;
  const fallback = (why: string) => {
    runtime.log(`devnet: ${why}; using the snapshot from ${fb.source} (block ${fb.block})`);
    return { sqrtPriceX96: BigInt(fb.sqrtPriceX96), tick: fb.tick, source: `fallback: ${fb.source}` };
  };
  const [status, ...rest] = answer.split("|");
  if (status !== "ok") return fallback(`unavailable (${rest.join("|")})`);
  const [sqrt, tick, block, timestamp] = rest;
  const age = Math.floor(runtime.now().getTime() / 1000) - Number(timestamp);
  if (age > runtime.config.staleSeconds) return fallback(`halted: latest block ${block} is ${age}s old`);
  runtime.log(`devnet: live at block ${block}, ${age}s old`);
  return { sqrtPriceX96: BigInt(sqrt!), tick: Number(tick), source: `gateway, block ${block}` };
}

const onCron = (runtime: Runtime<Config>, _payload: CronPayload): string => {
  const c = runtime.config;
  const main = readMainnet(runtime);
  const dev = readDevnet(runtime);
  const mainPrice = priceE6(main.sqrtPriceX96);
  const devPrice = priceE6(dev.sqrtPriceX96);
  const diff = devPrice > mainPrice ? devPrice - mainPrice : mainPrice - devPrice;
  const divergenceBps = Number((diff * 10_000n) / mainPrice);

  runtime.log(`mainnet ETH/USDC: ${usd(mainPrice)} USDC, tick ${main.tick} (finalized)`);
  runtime.log(`devnet ETH/fgUSD: ${usd(devPrice)} fgUSD, tick ${dev.tick} (${dev.source})`);
  runtime.log(`divergence: ${(divergenceBps / 100).toFixed(2)}% (threshold ${(c.thresholdBps / 100).toFixed(2)}%)`);

  const summary = { mainnetPrice: usd(mainPrice), devnetPrice: usd(devPrice), mainnetTick: main.tick, devnetTick: dev.tick, divergenceBps, devnetSource: dev.source };
  if (divergenceBps <= c.thresholdBps) {
    runtime.log("within bound: no action");
    return JSON.stringify({ ...summary, alert: false });
  }

  // The bound a sanity check would accept: mainnet's tick plus or minus boundTicks. syncReference() itself moves the
  // paymaster's reference toward the devnet pool by at most MAX_DEVIATION, so the bound travels with it for a guard.
  const payload = {
    chain: "devnet 1337",
    to: c.devnet.paymaster,
    data: encodeFunctionData({ abi: paymasterAbi, functionName: "syncReference" }),
    bound: { lowTick: main.tick - c.boundTicks, highTick: main.tick + c.boundTicks, devnetTickInside: Math.abs(dev.tick - main.tick) <= c.boundTicks },
  };
  runtime.log(`ALERT: devnet price diverges ${(divergenceBps / 100).toFixed(2)}% from mainnet`);
  runtime.log(`prepared write (mocked, not sent): ${JSON.stringify(payload)}`);
  return JSON.stringify({ ...summary, alert: true, payload });
};

const initWorkflow = (config: Config) => {
  const cron = new cre.capabilities.CronCapability();
  return [cre.handler(cron.trigger({ schedule: config.schedule }), onCron)];
};

export async function main() {
  const runner = await Runner.newRunner<Config>({ configSchema });
  await runner.run(initWorkflow);
}

await main();
