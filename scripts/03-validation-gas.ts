/**
 * Gate 2b evidence. Shows from a trace that the staked paymaster really reads PoolManager storage, shows an unstaked
 * contract rejected for that read alone, measures declared against used validation gas, and tests the 100k cap live.
 */
import { encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, parseAbiParameters, parseEther, parseUnits, type Address, type Hex } from "viem";
import { addressOf, artifact, balanceOf, deploy, devnetKey, PREDEPLOYS, read, readDeployments, recordDeployments, rpc, send } from "./lib/devnet.js";
import { executes, explorerTx, mined, paymasterTx, sign, simulate, toAltMempool, type FrameTx } from "./lib/frames.js";

const RECIPIENT: Address = "0x8943545177806ED17B9F23F0a21ee5948eCaa776";
const CAP = parseUnits("2", 6);
const SECP256K1_COST = 2_800n;
const MAX_VERIFY_GAS = 100_000n;
const erc20Abi = parseAbi(["function transfer(address,uint256) returns (bool)", "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"]);

const nonceOf = async (a: Address): Promise<bigint> => BigInt(await rpc("eth_getTransactionCount", [a, "latest"]));

/** The smallest limit in [low, high] for which `build(limit)` executes in simulation. */
async function minimumLimit(build: (limit: bigint) => Promise<FrameTx>, low: bigint, high: bigint): Promise<bigint> {
  const top = await simulate(await build(high));
  if (!executes(top)) throw new Error(`fails even at ${high}: ${top.executionError}`);
  while (low < high) {
    const mid = (low + high) / 2n;
    if (executes(await simulate(await build(mid)))) high = mid;
    else low = mid + 1n;
  }
  return low;
}

async function main() {
  const deployments = readDeployments();
  const fgUSD = deployments.fgUSD as Address;
  const paymaster = deployments.stakedPaymasterValidationOnly as Address;
  const poolId = (deployments.pool as { id: Hex }).id;
  const deployerKey = devnetKey("DEVNET_PRIVATE_KEY");
  const userKey = devnetKey("FRAMEGAS_USER_KEY");
  const user = addressOf(userKey);
  const validate = encodeFunctionData({ abi: artifact("FrameGasPaymaster").abi, functionName: "validate", args: [CAP] });

  const eoaTx = async (senderLimit: bigint, paymasterLimit: bigint) =>
    sign(paymasterTx({ sender: user, paymaster, paymasterData: validate, to: RECIPIENT, nonce: await nonceOf(user), senderLimit, paymasterLimit }), userKey);

  // ---- 1. What the admitted transaction shape actually reads -------------------------------------------------
  const expectedSlot = keccak256(encodeAbiParameters(parseAbiParameters("bytes32,uint256"), [poolId, 6n])); // pools mapping, slot 6
  const traced = await simulate(await eoaTx(30_000n, 60_000n), true);
  console.log(`\n1. trace of the paymaster frame (execution ${traced.executionStatus}, canonical verdict: ${traced.canonicalMempoolViolation ?? "valid"})`);
  console.log(`   expected PoolManager slot0 slot: ${expectedSlot}`);
  console.log(`   trace error: ${traced.erc7562TraceError ?? "none"}`);
  const poolRead = JSON.stringify(traced.erc7562Trace).toLowerCase().includes(expectedSlot.toLowerCase());
  console.log(`   trace contains the PoolManager slot read: ${poolRead}`);
  if (!poolRead) throw new Error("the trace does not show the PoolManager read");

  // ---- 2. Unstaked contract whose only foreign access is the PoolManager read -----------------------------------
  const probe = await deploy(deployerKey, "PoolReadProbe", [PREDEPLOYS.poolManager, poolId], parseEther("0.002"), 9_000_000n);
  const probeTx = await sign(paymasterTx({ sender: user, paymaster: probe, paymasterData: "0x", to: RECIPIENT, nonce: await nonceOf(user), senderLimit: 30_000n, paymasterLimit: 60_000n }), userKey);
  const probed = await toAltMempool(probeTx);
  console.log(`\n2. unstaked probe ${probe}, PoolManager read only:`);
  console.log(probed.admitted ? `   UNEXPECTEDLY ADMITTED ${probed.hash}` : `   rejected: ${probed.error}`);
  if (probed.admitted) throw new Error("the unstaked probe was admitted");

  // ---- 3. Declared against used, EOA sender ------------------------------------------------------------------
  const eoaSenderMin = await minimumLimit((l) => eoaTx(l, 60_000n), 0n, 30_000n);
  const paymasterMin = await minimumLimit((l) => eoaTx(30_000n, l), 20_000n, 60_000n);
  console.log(`\n3. minimum limits with an EOA sender: sender frame ${eoaSenderMin}, paymaster frame ${paymasterMin}`);

  // ---- 4. Contract wallet sender ----------------------------------------------------------------------------
  const wallet = await deploy(deployerKey, "OwnerWallet", [user], 0n, 9_000_000n);
  const sponsor = await deploy(deployerKey, "UnconditionalPaymaster", [], parseEther("0.002"), 9_000_000n);
  await send(deployerKey, { to: fgUSD, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [wallet, parseUnits("100", 6)] }) });
  const approveData = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [paymaster, CAP] });
  const setup = await sign(paymasterTx({ sender: wallet, signer: user, paymaster: sponsor, paymasterData: "0x", to: fgUSD, nonce: await nonceOf(wallet), senderLimit: 40_000n, paymasterLimit: 30_000n, executionLimit: 80_000n, executionState: 200_000n, data: approveData }), userKey);
  const setupResult = await toAltMempool(setup);
  if (!setupResult.admitted) throw new Error(`wallet setup rejected: ${setupResult.error}`);
  const setupMined = await mined(setupResult.hash);
  if (setupMined.status !== "0x1" || setupMined.frames.some((f) => f.status !== "0x1")) throw new Error(`wallet setup failed in ${setupResult.hash}`);

  const walletTx = async (senderLimit: bigint, paymasterLimit: bigint) =>
    sign(paymasterTx({ sender: wallet, signer: user, paymaster, paymasterData: validate, to: RECIPIENT, nonce: await nonceOf(wallet), senderLimit, paymasterLimit }), userKey);
  const walletMin = await minimumLimit((l) => walletTx(l, 60_000n), 1_000n, 60_000n);
  const paymasterWithWalletMin = await minimumLimit((l) => walletTx(40_000n, l), 20_000n, 60_000n);
  console.log(`\n4. contract wallet ${wallet}: minimum sender frame ${walletMin}, paymaster frame ${paymasterWithWalletMin}`);

  const tightWallet = await toAltMempool(await walletTx(walletMin, paymasterWithWalletMin));
  console.log(tightWallet.admitted ? `   admitted at the minimums: ${explorerTx(tightWallet.hash)}` : `   rejected at the minimums: ${tightWallet.error}`);
  if (tightWallet.admitted) {
    const r = await mined(tightWallet.hash);
    r.frames.forEach((f, i) => console.log(`   frame ${i}: status ${f.status}, gas used ${f.gasUsed}`));
  }

  // ---- 5. The cap, live, at its exact boundary, from a staked entity ------------------------------------------
  const senderLimit = 30_000n;
  const atCap = MAX_VERIFY_GAS - SECP256K1_COST - senderLimit;
  console.log(`\n5. cap test, staked paymaster: sender ${senderLimit} + signature ${SECP256K1_COST} + paymaster limit`);
  const over = await toAltMempool(await eoaTx(senderLimit, atCap + 1n));
  console.log(over.admitted ? `   ${atCap + 1n}: ADMITTED ${over.hash}` : `   ${atCap + 1n} (one over): rejected: ${over.error}`);
  if (over.admitted) await mined(over.hash);
  const far = await toAltMempool(await eoaTx(senderLimit, 300_000n));
  console.log(far.admitted ? `   300000: ADMITTED ${far.hash}` : `   300000 (within ERC-8421's staked 1M): rejected: ${far.error}`);
  if (far.admitted) await mined(far.hash);
  const exact = await toAltMempool(await eoaTx(senderLimit, atCap));
  console.log(exact.admitted ? `   ${atCap} (exactly at cap): admitted ${explorerTx(exact.hash)}` : `   ${atCap} (exactly at cap): rejected: ${exact.error}`);
  if (exact.admitted) await mined(exact.hash);

  recordDeployments({ gasMeasurement: { wallet: wallet, probe, sponsor } });
  console.log(`\nuser ETH ${await balanceOf(user)}, paymaster ETH ${await balanceOf(paymaster)}, user fgUSD ${await read<bigint>(fgUSD, erc20Abi, "balanceOf", [user])}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
