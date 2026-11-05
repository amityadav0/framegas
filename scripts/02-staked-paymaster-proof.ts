/**
 * Gate 2b. The key proof: a separate, staked contract paymaster reads PoolManager storage in a VERIFY frame and the
 * alt-mempool admits the transaction. Two controls show what the result depends on: the same transaction shape
 * against an unstaked twin, and the same staked transaction against the canonical mempool.
 */
import { encodeFunctionData, parseAbi, parseEther, parseUnits, type Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { addressOf, artifact, balanceOf, deploy, devnetKey, PREDEPLOYS, read, readDeployments, recordDeployments, rpc, send } from "./lib/devnet.js";
import { admissionReport, explorerTx, hashOf, mined, paymasterTx, sign, toAltMempool, toCanonicalMempool } from "./lib/frames.js";

const FEE = 3000;
const TICK_SPACING = 60;
const MAX_DEVIATION = 1000; // about 10.5%, wide enough that ordinary swaps do not evict pending transactions
const BUFFER_BPS = 500n;
const STAKE = parseEther("0.012");
const FLOAT = parseEther("0.02");
const UNSTAKE_DELAY = 86_400;
const MAX_TOKEN_COST = parseUnits("2", 6);
const RECIPIENT: Address = "0x8943545177806ED17B9F23F0a21ee5948eCaa776";

const erc20Abi = parseAbi([
  "function transfer(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function nonces(address) view returns (uint256)",
  "function permit(address owner,address spender,uint256 value,uint256 deadline,uint8 v,bytes32 r,bytes32 s)",
]);
const registryAbi = parseAbi(["function getDepositInfo(address) view returns (uint256,uint32,uint64)"]);

const paymasterAbi: Abi = artifact("FrameGasPaymaster").abi;
const validateData = (cap: bigint): Hex => encodeFunctionData({ abi: paymasterAbi, functionName: "validate", args: [cap] });

async function deployPaymaster(key: Hex, fgUSD: Address, stake: bigint): Promise<Address> {
  const args = [PREDEPLOYS.poolManager, PREDEPLOYS.stakingRegistry, fgUSD, FEE, TICK_SPACING, MAX_DEVIATION, BUFFER_BPS, stake, UNSTAKE_DELAY];
  return deploy(key, "FrameGasPaymaster", args, stake + FLOAT, 9_000_000n);
}

/** Sets the user's allowance with a signed permit that the deployer submits, so the user never needs ETH. */
async function permitFor(deployerKey: Hex, userKey: Hex, fgUSD: Address, spender: Address, value: bigint): Promise<void> {
  const user = privateKeyToAccount(userKey);
  const nonce = await read<bigint>(fgUSD, erc20Abi, "nonces", [user.address]);
  const deadline = 2n ** 256n - 1n;
  const signature = await user.signTypedData({
    domain: { name: "FrameGas USD", version: "1", chainId: 1337, verifyingContract: fgUSD },
    types: { Permit: [
      { name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" },
      { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
    ] },
    primaryType: "Permit",
    message: { owner: user.address, spender, value, nonce, deadline },
  });
  const r = `0x${signature.slice(2, 66)}` as Hex;
  const s = `0x${signature.slice(66, 130)}` as Hex;
  const v = parseInt(signature.slice(130, 132), 16);
  await send(deployerKey, { to: fgUSD, data: encodeFunctionData({ abi: erc20Abi, functionName: "permit", args: [user.address, spender, value, deadline, v, r, s] }) });
}

async function main() {
  const deployerKey = devnetKey("DEVNET_PRIVATE_KEY");
  const fgUSD = readDeployments().fgUSD as Address;

  const paymaster = await deployPaymaster(deployerKey, fgUSD, STAKE);
  const unstaked = await deployPaymaster(deployerKey, fgUSD, 0n);
  recordDeployments({ stakedPaymasterValidationOnly: paymaster, unstakedPaymasterControl: unstaked });
  const [stake, delay, withdrawTime] = await read<readonly [bigint, number, bigint]>(PREDEPLOYS.stakingRegistry, registryAbi, "getDepositInfo", [paymaster]);
  console.log(`staked paymaster   ${paymaster}\n  registry: stake ${stake}, delay ${delay}, withdrawTime ${withdrawTime}`);
  console.log(`unstaked control   ${unstaked}`);
  if (stake !== STAKE || delay !== UNSTAKE_DELAY) throw new Error("the registry did not record the contract's stake");

  const userKey = devnetKey("FRAMEGAS_USER_KEY");
  const user = addressOf(userKey);
  if ((await read<bigint>(fgUSD, erc20Abi, "balanceOf", [user])) < MAX_TOKEN_COST) {
    await send(deployerKey, { to: fgUSD, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [user, parseUnits("100", 6)] }) });
  }
  await permitFor(deployerKey, userKey, fgUSD, paymaster, MAX_TOKEN_COST);
  await permitFor(deployerKey, userKey, fgUSD, unstaked, MAX_TOKEN_COST);
  console.log(`user ${user}: ${await balanceOf(user)} wei, allowance ${await read<bigint>(fgUSD, erc20Abi, "allowance", [user, paymaster])}`);

  const nonce = BigInt(await rpc("eth_getTransactionCount", [user, "latest"]));
  const build = (target: Address) =>
    sign(paymasterTx({ sender: user, paymaster: target, paymasterData: validateData(MAX_TOKEN_COST), to: RECIPIENT, nonce, senderLimit: 30_000n, paymasterLimit: 60_000n }), userKey);

  console.log("\ncontrol 1: unstaked paymaster, alt-mempool");
  const c1 = await toAltMempool(await build(unstaked));
  console.log(c1.admitted ? `  UNEXPECTEDLY ADMITTED ${c1.hash}` : `  rejected: ${c1.error}`);

  const stakedTx = await build(paymaster);
  console.log("\ncontrol 2: staked paymaster, canonical mempool");
  const c2 = await toCanonicalMempool(stakedTx);
  console.log(c2.admitted ? `  UNEXPECTEDLY ADMITTED ${c2.hash}` : `  rejected: ${c2.error}`);
  if (c1.admitted || c2.admitted) throw new Error("a control was admitted, so this run proves nothing");

  console.log("\nproof: staked paymaster, alt-mempool");
  const floatBefore = await balanceOf(paymaster);
  const proof = await toAltMempool(stakedTx);
  if (!proof.admitted) throw new Error(`rejected: ${proof.error}`);
  const receipt = await mined(proof.hash);
  const floatAfter = await balanceOf(paymaster);
  console.log(`  admitted ${proof.hash}\n  ${explorerTx(proof.hash)}`);
  console.log(`  block ${receipt.block}, status ${receipt.status}`);
  receipt.frames.forEach((f, i) => console.log(`  frame ${i}: status ${f.status}, gas used ${f.gasUsed}`));
  console.log(`  user ETH ${await balanceOf(user)}, paymaster ${floatBefore} -> ${floatAfter}`);
  const report = await admissionReport(proof.hash);
  console.log(`  outcome ${report?.admission?.outcome ?? report?.outcome}`);
  console.log(JSON.stringify(report, (_k, v) => (typeof v === "bigint" ? v.toString() : v)).slice(0, 1500));
  recordDeployments({ keyProofTx: proof.hash, keyProofTxHash: hashOf(stakedTx) });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
