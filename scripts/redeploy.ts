/**
 * Everything the demo needs, in one run, so a devnet reset costs minutes. It ends by sending real transactions through
 * the SDK, and fails unless they work. Devnet ETH cannot be recovered from a pool position or a paymaster's stake.
 */
import fs from "node:fs";
import { createFrameGas } from "@framegas/sdk";
import { encodeAbiParameters, encodeFunctionData, encodePacked, formatEther, formatUnits, keccak256, parseAbi, parseAbiParameters, parseEther, parseUnits, zeroAddress, type Address, type Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { addressOf, balanceOf, deploy, devnetKey, ensureFunded, PREDEPLOYS, read, send } from "./lib/devnet.js";
import { DEMO_MIN_LIQUIDITY, deployPaymaster, erc20Abi } from "./lib/gas-payment.js";

const MAINNET_RPC = "https://ethereum-rpc.publicnode.com";
const MAINNET_STATE_VIEW = "0x7fFE42C4a5DEeA5b0feC41C94C136Cf115597227";
const MAINNET_ETH_USDC_POOL = "0xdce6394339af00981949f5f3baf27e3610c76326a700af57e4b3e3ae4977f78d"; // native ETH / USDC, 0.3%
const FALLBACK_SQRT_PRICE = 3870497721706919791279764n; // about 2,386 USDC per ETH, for when mainnet cannot be reached

const FEE = 3000;
const TICK_SPACING = 60;
const RANGE_TICKS = 6000; // about +82% / -45% around the start price
const SUPPLY = parseUnits("1000000", 6);
const STAKE = parseEther("0.012");
const Q96 = 2n ** 96n;
const FAR_FUTURE = 2 ** 47;
const RECIPIENT: Address = "0x8943545177806ED17B9F23F0a21ee5948eCaa776";

const stateViewAbi = parseAbi([
  "function getSlot0(bytes32) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32) view returns (uint128)",
]);
const registryAbi = parseAbi(["function getDepositInfo(address) view returns (uint256,uint32,uint64)"]);
const tokenAbi = parseAbi(["function approve(address,uint256) returns (bool)"]);
const permit2Abi = parseAbi(["function approve(address token,address spender,uint160 amount,uint48 expiration)"]);
const posmAbi = parseAbi([
  "function initializePool((address,address,uint24,int24,address) key,uint160 sqrtPriceX96) payable returns (int24)",
  "function modifyLiquidities(bytes unlockData,uint256 deadline) payable",
]);

const flag = (name: string) => process.argv.includes(name);
const option = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function mainnetSqrtPrice(): Promise<bigint> {
  try {
    const data = encodeFunctionData({ abi: stateViewAbi, functionName: "getSlot0", args: [MAINNET_ETH_USDC_POOL] });
    const res = await fetch(MAINNET_RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: MAINNET_STATE_VIEW, data }, "latest"] }),
      signal: AbortSignal.timeout(10_000),
    });
    const { result } = (await res.json()) as { result: Hex };
    const sqrtPrice = BigInt(result.slice(0, 66));
    if (sqrtPrice === 0n) throw new Error("empty");
    return sqrtPrice;
  } catch {
    console.log("  mainnet could not be reached, so the pool starts at a fixed price");
    return FALLBACK_SQRT_PRICE;
  }
}

const sqrtAtTick = (tick: number): bigint => BigInt(Math.floor(Math.pow(1.0001, tick / 2) * 2 ** 48)) * 2n ** 48n;

async function main() {
  const out = option("--out") ?? "deployments/devnet.json";
  if (fs.existsSync(out) && !flag("--fresh")) throw new Error(`${out} exists. Pass --fresh to replace it, or --out for another file`);
  const seedEth = parseEther(option("--seed-eth") ?? "0.05");
  const floatEth = option("--float-eth") ?? "0.02";

  const key = devnetKey("DEVNET_PRIVATE_KEY");
  const me = addressOf(key);
  const needed = seedEth + STAKE + parseEther(floatEth);
  await ensureFunded(me, needed + parseEther("0.001"));
  const start = await balanceOf(me);
  console.log(`deployer ${me}: ${formatEther(start)} ETH, this run locks up about ${formatEther(needed)}`);

  // 1. Token.
  const token = await deploy(key, "FgUSD", [SUPPLY]);
  console.log(`token    ${token}`);

  // 2. Pool, at mainnet's price.
  const poolKey = [zeroAddress, token, FEE, TICK_SPACING, zeroAddress] as const;
  const poolId = keccak256(encodeAbiParameters(parseAbiParameters("address,address,uint24,int24,address"), [...poolKey]));
  const sqrtPriceX96 = await mainnetSqrtPrice();
  await send(key, { to: PREDEPLOYS.positionManager, data: encodeFunctionData({ abi: posmAbi, functionName: "initializePool", args: [poolKey, sqrtPriceX96] }) });
  const [sqrtP, tick] = await read<readonly [bigint, number, number, number]>(PREDEPLOYS.stateView, stateViewAbi, "getSlot0", [poolId]);
  console.log(`pool     ${poolId}, tick ${tick}`);

  // 3. Liquidity.
  const base = Math.floor(tick / TICK_SPACING) * TICK_SPACING;
  const lower = base - RANGE_TICKS;
  const upper = base + RANGE_TICKS;
  const sqrtL = sqrtAtTick(lower);
  const sqrtU = sqrtAtTick(upper);
  const liquidity = (((seedEth * sqrtP) / Q96) * sqrtU) / (sqrtU - sqrtP);
  const amount1 = (liquidity * (sqrtP - sqrtL)) / Q96;
  await send(key, { to: token, data: encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [PREDEPLOYS.permit2, 2n ** 256n - 1n] }) });
  await send(key, { to: PREDEPLOYS.permit2, data: encodeFunctionData({ abi: permit2Abi, functionName: "approve", args: [token, PREDEPLOYS.positionManager, 2n ** 160n - 1n, FAR_FUTURE] }) });
  const actions = encodePacked(["uint8", "uint8", "uint8"], [0x02, 0x0d, 0x14]); // MINT_POSITION, SETTLE_PAIR, SWEEP
  const mint = encodeAbiParameters(
    parseAbiParameters("(address,address,uint24,int24,address) key,int24 lower,int24 upper,uint256 liquidity,uint128 amount0Max,uint128 amount1Max,address owner,bytes hookData"),
    [poolKey, lower, upper, liquidity, (seedEth * 101n) / 100n, (amount1 * 101n) / 100n, me, "0x"],
  );
  const settlePair = encodeAbiParameters(parseAbiParameters("address,address"), [zeroAddress, token]);
  const sweep = encodeAbiParameters(parseAbiParameters("address,address"), [zeroAddress, me]);
  const unlockData = encodeAbiParameters(parseAbiParameters("bytes,bytes[]"), [actions, [mint, settlePair, sweep]]);
  await send(key, { to: PREDEPLOYS.positionManager, data: encodeFunctionData({ abi: posmAbi, functionName: "modifyLiquidities", args: [unlockData, BigInt(FAR_FUTURE)] }), value: (seedEth * 101n) / 100n });
  const active = await read<bigint>(PREDEPLOYS.stateView, stateViewAbi, "getLiquidity", [poolId]);
  if (active < DEMO_MIN_LIQUIDITY) throw new Error(`active liquidity ${active} is below the threshold ${DEMO_MIN_LIQUIDITY}`);
  console.log(`liquidity ${active} active, from ${formatEther(seedEth)} ETH`);

  // 4. Paymaster and stake. The constructor stakes as the contract itself.
  const paymaster = await deployPaymaster(key, token, { floatEth });
  const [stake, delay, withdrawTime] = await read<readonly [bigint, number, bigint]>(PREDEPLOYS.stakingRegistry, registryAbi, "getDepositInfo", [paymaster]);
  if (stake !== STAKE || withdrawTime !== 0n) throw new Error(`the registry shows stake ${stake}, withdrawal ${withdrawTime}`);
  console.log(`paymaster ${paymaster}, staked ${formatEther(stake)} ETH, delay ${delay}s`);

  // 5. Registration. There is no owner to register with on chain: one paymaster serves one token, and this is the list.
  const deployment = {
    chainId: 1337,
    fgUSD: token,
    paymaster,
    pool: { id: poolId, currency0: zeroAddress, currency1: token, fee: FEE, tickSpacing: TICK_SPACING, hooks: zeroAddress },
    paymasters: { [token]: paymaster },
    tokens: {
      fgUSD: {
        address: token,
        decimals: 6,
        paymaster,
        poolId,
        minLiquidity: DEMO_MIN_LIQUIDITY.toString(),
        minLiquidityNote: "Demo threshold. Production needs about 7e14, roughly 4 ETH of depth, where griefing is unprofitable",
      },
    },
  };
  fs.writeFileSync(out, `${JSON.stringify(deployment, null, 2)}\n`);
  console.log(`recorded ${out}`);

  // 6. Smoke test through the SDK, from a new key holding no ETH.
  const userKey = generatePrivateKey();
  const user = addressOf(userKey);
  await send(key, { to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [user, parseUnits("100", 6)] }) });
  const framegas = createFrameGas({ privateKey: userKey, paymasters: deployment.paymasters });
  const call = { to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [RECIPIENT, parseUnits("1", 6)] }) };

  for (const label of ["first", "second"]) {
    const quote = await framegas.quote({ payToken: token, calls: [call] });
    const r = await framegas.send({ payToken: token, maxTokenCost: (quote.requiredTokens * 102n) / 100n, calls: [call] });
    const net = r.tokensPaid - r.tokensRefunded;
    console.log(`smoke ${label}: ${r.mode}, ${r.explorerUrl}`);
    console.log(`  paid ${formatUnits(net, 6)} fgUSD net, ${r.success ? "every frame succeeded" : "A FRAME FAILED"}${r.warnings.length ? `, ${r.warnings.join("; ")}` : ""}`);
    if (!r.success || net <= 0n) throw new Error(`the ${label} smoke transaction did not settle: ${JSON.stringify(r.frames.map((f) => [f.name, f.success]))}`);
    if ((await balanceOf(user)) !== 0n) throw new Error("the smoke user holds ETH");
  }

  console.log(`done. spent ${formatEther(start - (await balanceOf(me)))} ETH, deployer holds ${formatEther(await balanceOf(me))} ETH`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
