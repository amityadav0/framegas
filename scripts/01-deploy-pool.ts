/**
 * Gate 2a. Deploys fgUSD, then creates and funds a native-ETH/fgUSD pool on the devnet's PoolManager.
 * The pool starts at mainnet's live ETH/USDC price so quotes look like production ones.
 */
import { encodeAbiParameters, encodeFunctionData, encodePacked, parseAbi, parseAbiParameters, parseEther, keccak256, zeroAddress, type Address } from "viem";
import { addressOf, deploy, devnetKey, ensureFunded, PREDEPLOYS, read, readDeployments, recordDeployments, send } from "./lib/devnet.js";

const MAINNET_RPC = "https://ethereum-rpc.publicnode.com";
const MAINNET_STATE_VIEW = "0x7fFE42C4a5DEeA5b0feC41C94C136Cf115597227";
const MAINNET_ETH_USDC_POOL = "0xdce6394339af00981949f5f3baf27e3610c76326a700af57e4b3e3ae4977f78d"; // native ETH / USDC, 0.3%

const FEE = 3000;
const TICK_SPACING = 60;
const RANGE_TICKS = 6000; // about +82% / -45% around the start price
const SUPPLY = 1_000_000_000_000n; // 1,000,000 fgUSD
const SEED_ETH = parseEther("0.3");
const Q96 = 2n ** 96n;

const stateViewAbi = parseAbi([
  "function getSlot0(bytes32) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32) view returns (uint128)",
]);
const erc20Abi = parseAbi(["function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"]);
const permit2Abi = parseAbi(["function approve(address token,address spender,uint160 amount,uint48 expiration)"]);
const posmAbi = parseAbi([
  "function initializePool((address,address,uint24,int24,address) key,uint160 sqrtPriceX96) payable returns (int24)",
  "function modifyLiquidities(bytes unlockData,uint256 deadline) payable",
]);

async function mainnetSqrtPrice(): Promise<bigint> {
  const data = encodeFunctionData({ abi: stateViewAbi, functionName: "getSlot0", args: [MAINNET_ETH_USDC_POOL] });
  const res = await fetch(MAINNET_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: MAINNET_STATE_VIEW, data }, "latest"] }),
  });
  const { result } = (await res.json()) as { result: `0x${string}` };
  return BigInt(result.slice(0, 66));
}

const sqrtAtTick = (tick: number): bigint => BigInt(Math.floor(Math.pow(1.0001, tick / 2) * 2 ** 48)) * 2n ** 48n;

async function main() {
  const key = devnetKey("DEVNET_PRIVATE_KEY");
  const me = addressOf(key);
  await ensureFunded(me, parseEther("0.5"));
  console.log(`deployer ${me}`);

  const existing = readDeployments().fgUSD as Address | undefined;
  const fgUSD = existing ?? (await deploy(key, "FgUSD", [SUPPLY]));
  recordDeployments({ chainId: 1337, fgUSD });
  console.log(`fgUSD ${fgUSD}`);

  const poolKey = [zeroAddress, fgUSD, FEE, TICK_SPACING, zeroAddress] as const;
  const poolId = keccak256(encodeAbiParameters(parseAbiParameters("address,address,uint24,int24,address"), [...poolKey]));
  const [current] = await read<readonly [bigint, number, number, number]>(PREDEPLOYS.stateView, stateViewAbi, "getSlot0", [poolId]);

  if (current === 0n) {
    const sqrtPriceX96 = await mainnetSqrtPrice();
    await send(key, { to: PREDEPLOYS.positionManager, data: encodeFunctionData({ abi: posmAbi, functionName: "initializePool", args: [poolKey, sqrtPriceX96] }) });
    console.log(`pool initialised at mainnet sqrtPriceX96 ${sqrtPriceX96}`);
  }
  const [sqrtP, tick] = await read<readonly [bigint, number, number, number]>(PREDEPLOYS.stateView, stateViewAbi, "getSlot0", [poolId]);

  const liquidityBefore = await read<bigint>(PREDEPLOYS.stateView, stateViewAbi, "getLiquidity", [poolId]);
  if (liquidityBefore === 0n) {
    const base = Math.floor(tick / TICK_SPACING) * TICK_SPACING;
    const lower = base - RANGE_TICKS;
    const upper = base + RANGE_TICKS;
    const sqrtL = sqrtAtTick(lower);
    const sqrtU = sqrtAtTick(upper);
    const liquidity = (((SEED_ETH * sqrtP) / Q96) * sqrtU) / (sqrtU - sqrtP);
    const amount1 = (liquidity * (sqrtP - sqrtL)) / Q96;
    const amount0Max = (SEED_ETH * 101n) / 100n;
    const amount1Max = (amount1 * 101n) / 100n;

    await send(key, { to: fgUSD, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [PREDEPLOYS.permit2, 2n ** 256n - 1n] }) });
    const farFuture = 2 ** 47;
    await send(key, { to: PREDEPLOYS.permit2, data: encodeFunctionData({ abi: permit2Abi, functionName: "approve", args: [fgUSD, PREDEPLOYS.positionManager, 2n ** 160n - 1n, farFuture] }) });

    const actions = encodePacked(["uint8", "uint8", "uint8"], [0x02, 0x0d, 0x14]); // MINT_POSITION, SETTLE_PAIR, SWEEP
    const mint = encodeAbiParameters(
      parseAbiParameters("(address,address,uint24,int24,address) key,int24 lower,int24 upper,uint256 liquidity,uint128 amount0Max,uint128 amount1Max,address owner,bytes hookData"),
      [poolKey, lower, upper, liquidity, amount0Max, amount1Max, me, "0x"],
    );
    const settle = encodeAbiParameters(parseAbiParameters("address,address"), [zeroAddress, fgUSD]);
    const sweep = encodeAbiParameters(parseAbiParameters("address,address"), [zeroAddress, me]);
    const unlockData = encodeAbiParameters(parseAbiParameters("bytes,bytes[]"), [actions, [mint, settle, sweep]]);
    const data = encodeFunctionData({ abi: posmAbi, functionName: "modifyLiquidities", args: [unlockData, BigInt(farFuture)] });
    await send(key, { to: PREDEPLOYS.positionManager, data, value: amount0Max });
    console.log(`minted position ${lower}..${upper}, liquidity ${liquidity}`);
  }

  const liquidity = await read<bigint>(PREDEPLOYS.stateView, stateViewAbi, "getLiquidity", [poolId]);
  if (liquidity === 0n) throw new Error("pool has no liquidity after seeding");
  const ethPrice = (Number(sqrtP) / 2 ** 96) ** 2 * 1e12;
  recordDeployments({ pool: { id: poolId, currency0: zeroAddress, currency1: fgUSD, fee: FEE, tickSpacing: TICK_SPACING, hooks: zeroAddress } });
  console.log(`pool ${poolId}\n  tick ${tick}, liquidity ${liquidity}, 1 ETH = ${ethPrice.toFixed(2)} fgUSD`);
  console.log(`  fgUSD left with deployer: ${await read<bigint>(fgUSD, erc20Abi, "balanceOf", [me])}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
