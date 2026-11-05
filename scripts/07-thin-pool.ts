/**
 * Gate 2d. Forge cannot model state gas, so this measures tick crossings live, on thin pools built so that buying the
 * reserve crosses a known number of ticks. It records what a settlement that runs out of gas costs the paymaster.
 */
import { encodeAbiParameters, encodeFunctionData, encodePacked, keccak256, parseAbi, parseAbiParameters, parseEther, parseUnits, zeroAddress, type Address, type Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { addressOf, balanceOf, devnetKey, ensureFunded, PREDEPLOYS, read, readDeployments, send } from "./lib/devnet.js";
import { explorerTx, gaslessTx, mined, sign, simulate, toAltMempool } from "./lib/frames.js";
import { deployPaymaster, erc20Abi, LIMITS, settleData, signPermit, submitPermit, validateData } from "./lib/gas-payment.js";

const RECIPIENT: Address = "0x8943545177806ED17B9F23F0a21ee5948eCaa776";
const CAP = parseUnits("5", 6);
const START_TICK_NEAR = -198_500;
const Q96 = 2n ** 96n;

const posmAbi = parseAbi([
  "function initializePool((address,address,uint24,int24,address) key,uint160 sqrtPriceX96) payable returns (int24)",
  "function modifyLiquidities(bytes unlockData,uint256 deadline) payable",
]);
const stateViewAbi = parseAbi(["function getSlot0(bytes32) view returns (uint160,int24,uint24,uint24)"]);

const sqrtAtTick = (tick: number): bigint => BigInt(Math.floor(Math.pow(1.0001, tick / 2) * 2 ** 48)) * 2n ** 48n;

const deployerKey = devnetKey("DEVNET_PRIVATE_KEY");
const me = addressOf(deployerKey);
const fgUSD = readDeployments().fgUSD as Address;

/** A pool whose price sits at the bottom of `segments` single-sided ETH positions, one per tick spacing. */
async function thinPool(fee: number, spacing: number, segments: number, ethPerSegment: bigint): Promise<{ id: Hex; base: number }> {
  const key = [zeroAddress, fgUSD, fee, spacing, zeroAddress] as const;
  const id = keccak256(encodeAbiParameters(parseAbiParameters("address,address,uint24,int24,address"), [...key]));
  const base = Math.ceil(START_TICK_NEAR / spacing) * spacing;
  await send(deployerKey, { to: PREDEPLOYS.positionManager, data: encodeFunctionData({ abi: posmAbi, functionName: "initializePool", args: [key, sqrtAtTick(base) + 2n ** 60n] }) });
  for (let i = 0; i < segments; i++) {
    const lower = base + i * spacing;
    const upper = lower + spacing;
    const sqrtA = sqrtAtTick(lower);
    const sqrtB = sqrtAtTick(upper);
    const liquidity = (((ethPerSegment * sqrtA) / Q96) * sqrtB) / (sqrtB - sqrtA);
    const actions = encodePacked(["uint8", "uint8", "uint8"], [0x02, 0x0d, 0x14]);
    const mint = encodeAbiParameters(
      parseAbiParameters("(address,address,uint24,int24,address) key,int24 lower,int24 upper,uint256 liquidity,uint128 amount0Max,uint128 amount1Max,address owner,bytes hookData"),
      [key, lower, upper, liquidity, (ethPerSegment * 3n) / 2n + 1000n, 1_000_000n, me, "0x"],
    );
    const settle = encodeAbiParameters(parseAbiParameters("address,address"), [zeroAddress, fgUSD]);
    const sweep = encodeAbiParameters(parseAbiParameters("address,address"), [zeroAddress, me]);
    const unlockData = encodeAbiParameters(parseAbiParameters("bytes,bytes[]"), [actions, [mint, settle, sweep]]);
    await send(deployerKey, { to: PREDEPLOYS.positionManager, data: encodeFunctionData({ abi: posmAbi, functionName: "modifyLiquidities", args: [unlockData, BigInt(2 ** 47)] }), value: (ethPerSegment * 3n) / 2n + 1000n });
  }
  return { id, base };
}

async function fundedUser(paymaster: Address): Promise<{ key: Hex; address: Address }> {
  const key = generatePrivateKey();
  const address = addressOf(key);
  await send(deployerKey, { to: fgUSD, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [address, parseUnits("20", 6)] }) });
  await submitPermit(deployerKey, address, fgUSD, paymaster, CAP, await signPermit(key, fgUSD, paymaster, CAP));
  return { key, address };
}

async function attempt(name: string, paymaster: Address, poolId: Hex, settleLimit: bigint, settleState: bigint, callLimit = 16_000n): Promise<void> {
  const user = await fundedUser(paymaster);
  const call = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [RECIPIENT, 1n] });
  const t = await sign(
    gaslessTx({
      sender: user.address, paymaster, nonce: 0n, senderLimit: LIMITS.sender, validateLimit: LIMITS.validateBootstrap, validateData: validateData(),
      settle: { data: settleData(CAP), execution: settleLimit, state: settleState },
      calls: [{ to: fgUSD, data: call, execution: callLimit, state: 0n }],
    }),
    user.key,
  );
  const sim = await simulate(t);
  const simFrames = (sim.frames ?? []).map((f) => [parseInt(f.gasUsed, 16), f.succeeded]);
  console.log(`\n${name}\n  simulation: ${sim.executionStatus}, frames ${JSON.stringify(simFrames)}`);

  const [, tickBefore] = await read<readonly [bigint, number, number, number]>(PREDEPLOYS.stateView, stateViewAbi, "getSlot0", [poolId]);
  const floatBefore = await balanceOf(paymaster);
  const tokensBefore = await read<bigint>(fgUSD, erc20Abi, "balanceOf", [user.address]);
  const out = await toAltMempool(t);
  if (!out.admitted) {
    console.log(`  rejected at admission: ${out.error.slice(0, 200)}`);
    return;
  }
  console.log(`  admitted: ${explorerTx(out.hash)}`);
  let r;
  try {
    r = await mined(out.hash);
  } catch {
    console.log("  still pending after 180s, so no on-chain result for this one");
    return;
  }
  const [, tickAfter] = await read<readonly [bigint, number, number, number]>(PREDEPLOYS.stateView, stateViewAbi, "getSlot0", [poolId]);
  const delta = (await balanceOf(paymaster)) - floatBefore;
  const paid = tokensBefore - (await read<bigint>(fgUSD, erc20Abi, "balanceOf", [user.address]));
  console.log(`  tick ${tickBefore} -> ${tickAfter}`);
  ["sender verify", "validate", "settle", "user call"].forEach((f, i) => {
    const x = r.frames[i]!;
    console.log(`  ${i} ${f.padEnd(14)} status ${x.status}  gas ${String(x.gasUsed).padStart(6)}  state gas ${x.stateGasUsed}`);
  });
  console.log(`  fee ${r.gasUsed * r.effectiveGasPrice} wei, user paid ${paid} fgUSD units (includes 1 unit sent), paymaster ${delta >= 0n ? "+" : ""}${delta} wei`);
}

/** Which limit fails: the same transaction in simulation, lifting one limit at a time, inside the per-transaction cap. */
async function whichLimit(name: string, paymaster: Address): Promise<void> {
  const user = await fundedUser(paymaster);
  const call = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [RECIPIENT, 1n] });
  console.log(`\n${name}: settle frame by limits, in simulation`);
  for (const [execution, state] of [[LIMITS.settle, 0n], [LIMITS.settle, 97_920n], [LIMITS.settle, 200_000n], [350_000n, 200_000n]] as const) {
    const t = await sign(
      gaslessTx({
        sender: user.address, paymaster, nonce: 0n, senderLimit: LIMITS.sender, validateLimit: LIMITS.validateBootstrap, validateData: validateData(),
        settle: { data: settleData(CAP), execution, state },
        calls: [{ to: fgUSD, data: call, execution: 60_000n, state: 0n }],
      }),
      user.key,
    );
    const sim = await simulate(t);
    const f = sim.frames;
    if (!f) {
      console.log(`  execution ${execution}, state ${state}: not valid: ${sim.executionError?.slice(0, 120)}`);
      continue;
    }
    console.log(`  execution ${execution}, state ${state}: settle ${f[2]?.succeeded ? "succeeds" : "fails"}, gas ${parseInt(f[2]?.gasUsed ?? "0", 16)}, user call ${f[3]?.succeeded ? "succeeds" : "fails"}`);
  }
}

async function main() {
  // Stake and float cannot be withdrawn, and the faucet can run dry, so these test paymasters hold very little.
  await ensureFunded(me, parseEther("0.08"));
  const oneSlot = 97_920n;

  // Sized from the reserve: the first swap stays inside a position, and the next runs off the end of it, crossing one tick.
  const one = await thinPool(200, 10, 6, parseEther("0.0006"));
  const onePaymaster = await deployPaymaster(deployerKey, fgUSD, { fee: 200, tickSpacing: 10, floatEth: "0.004" });
  console.log(`one-crossing pool ${one.id}, paymaster ${onePaymaster}`);
  await attempt("first swap, no tick crossed, one new slot declared", onePaymaster, one.id, LIMITS.settle, oneSlot);
  await whichLimit("first-ever crossing", onePaymaster);
  await attempt("first-ever crossing at the floor, with room for the user's call", onePaymaster, one.id, LIMITS.settle, 0n, 60_000n);
  await attempt("first-ever crossing, declaring two new slots", onePaymaster, one.id, LIMITS.settle, 2n * oneSlot);

  const steep = await thinPool(50, 1, 10, parseEther("0.0001"));
  const steepPaymaster = await deployPaymaster(deployerKey, fgUSD, { fee: 50, tickSpacing: 1, floatEth: "0.003" });
  console.log(`\nmany-crossing pool ${steep.id}, paymaster ${steepPaymaster}`);
  await whichLimit("pool too thin to supply the reserve", steepPaymaster);
  await attempt("pool too thin, at the floor, with room for the user's call", steepPaymaster, steep.id, LIMITS.settle, 0n, 60_000n);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
