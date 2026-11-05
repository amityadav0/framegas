/** Shared plumbing for devnet scripts: key handling, RPC, legacy transactions, artifacts and deployment records. */
import fs from "node:fs";
import { rpc as libRpc } from "@forshtat/hegota-support/rpc";
import { encodeDeployData, encodeFunctionData, type Abi, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const root = new URL("../../", import.meta.url);
const envFile = new URL(".env", root);
const deploymentsFile = new URL("deployments/devnet.json", root);

export const GATEWAY = "https://altmempoolgateway.forshtat.com/rpc";
export const EXPLORER = "https://explorer.altmempool.wtf";
export const CHAIN_ID = 1337;

/** Addresses of the devnet's predeploys, from the sidecar's `deployments/devnet.md`. */
export const PREDEPLOYS = {
  poolManager: "0x6bF9Aa9c04fd001385742d61f6818C3236429848",
  positionManager: "0x5bF24B2CD6f4cc0057F4BeD53264d591620Af57B",
  stateView: "0xd89a052862AaA34f0B6cc7f3B6a9D080584a43FB",
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  stakingRegistry: "0xd51c04d7a0b01124e84de152f4e56d9eecb22d2f",
} as const satisfies Record<string, Address>;

const LEGACY_GAS_PRICE = 2_000_000n; // 0.002 gwei; the devnet base fee is 7 wei

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Calls `url`, retrying only when the endpoint could not be reached. A node's answer, even an error, is final. */
export async function rpcAt(url: string, method: string, params: unknown[] = [], attempts = 6): Promise<any> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await libRpc(url, method, params);
    } catch (e) {
      if ((e as { code?: string }).code !== "RPC_UNREACHABLE" || attempt >= attempts) throw e;
      await sleep(5_000);
    }
  }
}

export const rpc = (method: string, params: unknown[] = []): Promise<any> => rpcAt(GATEWAY, method, params);

function readEnv(): Record<string, string> {
  if (!fs.existsSync(envFile)) return {};
  const lines = fs.readFileSync(envFile, "utf8").split("\n");
  return Object.fromEntries(
    lines.filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
  );
}

/** A named devnet-only key from the git-ignored `.env`, generated on first use. Never reuse one on a real network. */
export function devnetKey(name: string): Hex {
  const existing = readEnv()[name];
  if (existing) return existing as Hex;
  const key = generatePrivateKey();
  fs.appendFileSync(envFile, `${name}=${key}\n`, { mode: 0o600 });
  return key;
}

export const addressOf = (key: Hex): Address => privateKeyToAccount(key).address;

export async function waitMined(hash: Hex, timeoutMs = 180_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const receipt = await rpc("eth_getTransactionReceipt", [hash]);
    if (receipt) return receipt;
    await sleep(2_000);
  }
  throw new Error(`${hash} not mined within ${timeoutMs / 1000}s`);
}

export const balanceOf = async (address: Address): Promise<bigint> => BigInt(await rpc("eth_getBalance", [address, "latest"]));

/** Tops `to` up from the node's faucet when it holds less than `min`. The faucet allows one request per address per hour. */
export async function ensureFunded(to: Address, min: bigint): Promise<void> {
  if ((await balanceOf(to)) >= min) return;
  const { txHash } = await rpc("skandha_explorer_faucet", [to]);
  const receipt = await waitMined(txHash);
  if (receipt.status !== "0x1") throw new Error(`faucet transfer ${txHash} reverted`);
}

/** Sends a legacy transaction, waits for it and throws when it reverted. Gas is estimated with a margin unless given. */
export async function send(key: Hex, tx: { to: Address | null; data?: Hex; value?: bigint; gas?: bigint }): Promise<any> {
  const account = privateKeyToAccount(key);
  const value = tx.value ?? 0n;
  const data = tx.data ?? "0x";
  const gas =
    tx.gas ??
    (BigInt(
      await rpc("eth_estimateGas", [{ from: account.address, to: tx.to ?? undefined, data, value: `0x${value.toString(16)}` }, "latest"]),
    ) * 15n) / 10n;
  const nonce = Number(await rpc("eth_getTransactionCount", [account.address, "pending"]));
  const raw = await account.signTransaction({ chainId: CHAIN_ID, nonce, to: tx.to, value, data, gas, gasPrice: LEGACY_GAS_PRICE, type: "legacy" });
  const hash = await rpc("eth_sendRawTransaction", [raw]);
  const receipt = await waitMined(hash);
  if (receipt.status !== "0x1") throw new Error(`transaction ${hash} reverted`);
  return receipt;
}

export function artifact(name: string): { abi: Abi; bytecode: Hex } {
  const file = new URL(`contracts/out/${name}.sol/${name}.json`, root);
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  return { abi: json.abi, bytecode: json.bytecode.object };
}

export async function deploy(key: Hex, name: string, args: unknown[] = [], value = 0n, gas?: bigint): Promise<Address> {
  const { abi, bytecode } = artifact(name);
  const receipt = await send(key, { to: null, data: encodeDeployData({ abi, bytecode, args }), value, gas });
  return receipt.contractAddress;
}

export async function read<T>(to: Address, abi: Abi, functionName: string, args: unknown[] = []): Promise<T> {
  const { decodeFunctionResult } = await import("viem");
  const data = encodeFunctionData({ abi, functionName, args });
  const out = await rpc("eth_call", [{ to, data }, "latest"]);
  return decodeFunctionResult({ abi, functionName, data: out }) as T;
}

export type Deployments = Record<string, unknown>;

export function readDeployments(): Deployments {
  return fs.existsSync(deploymentsFile) ? JSON.parse(fs.readFileSync(deploymentsFile, "utf8")) : {};
}

/** Public addresses and pool parameters, committed so anyone can inspect the demo on the explorer. No secrets. */
export function recordDeployments(update: Deployments): void {
  fs.writeFileSync(deploymentsFile, `${JSON.stringify({ ...readDeployments(), ...update }, null, 2)}\n`);
}
