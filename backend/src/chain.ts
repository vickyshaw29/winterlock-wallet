// What the backend reads from the chain beyond the pipeline's own calls: the account's views (eth_call), the EOA's raw
// legacy transactions, and the chain's identity for the genesis pin. Tests replace the methods of `eth`, as they do
// the pipeline's `node` and `gateway`, so nothing here is ever sent anywhere during a test.
// Written with Claude Code (AI) for Vicky.
import { encodeFunctionData, getAddress, parseAbi, type Address, type Hex } from "viem";
import { DEFAULTS, currentChain, node, rpc, DEVNET, type ChainIdentity } from "../../pipeline/src/index.ts";
import { HttpError } from "./http.ts";

export const eth = {
  sendRawTransaction: (raw: Hex) => rpc<Hex>(DEVNET.node, "eth_sendRawTransaction", [raw]),
  chainIdentity: (): Promise<ChainIdentity> => currentChain(),
};

/** The account's ABI (account/src/IWinterlockAccount.sol): the views and the two admin calls the backend sends. */
export const ACCOUNT_ABI = parseAbi([
  "function root() view returns (bytes32)",
  "function treeSeed() view returns (bytes32)",
  "function height() view returns (uint8)",
  "function epoch() view returns (uint32)",
  "function hotStart() view returns (uint32)",
  "function hotValueCap() view returns (uint256)",
  "function hotFeeCap() view returns (uint256)",
  "function allowedTarget() view returns (address)",
  "function hybridRequired() view returns (bool)",
  "function rotate(bytes32 newRoot, bytes32 newTreeSeed, uint8 newHeight)",
  "function setHotPolicy(uint32 hotStart, uint256 valueCap, uint256 feeCap, address allowedTarget)",
]);

export interface AccountViews {
  root: Hex;
  treeSeed: Hex;
  height: number;
  epoch: number;
  hotStart: number;
  hotValueCap: bigint;
  hotFeeCap: bigint;
  allowedTarget: Address;
  hybridRequired: boolean;
}

type View = "root" | "treeSeed" | "height" | "epoch" | "hotStart" | "hotValueCap" | "hotFeeCap" | "allowedTarget" | "hybridRequired";
const VIEWS: View[] = ["root", "treeSeed", "height", "epoch", "hotStart", "hotValueCap", "hotFeeCap", "allowedTarget", "hybridRequired"];

/** Every view at the latest block, or null when the address has no code (eth_call then answers "0x"). */
export async function accountViews(account: Address): Promise<AccountViews | null> {
  const words = await Promise.all(VIEWS.map((fn) => node.call(account, encodeFunctionData({ abi: ACCOUNT_ABI, functionName: fn }))));
  if (words.some((w) => w === "0x")) return null;
  const at = (fn: View) => {
    const w = words[VIEWS.indexOf(fn)]!;
    if (!/^0x[0-9a-fA-F]{64}$/.test(w)) throw new Error(`${fn}() of ${account} returned ${w.slice(0, 80)}, not one word`);
    return w.toLowerCase() as Hex;
  };
  const small = (fn: View, max: number) => {
    const n = BigInt(at(fn));
    if (n > BigInt(max)) throw new Error(`${fn}() of ${account} returned ${n}, above ${max}`);
    return Number(n);
  };
  const target = at("allowedTarget");
  if (BigInt(target) >> 160n) throw new Error(`allowedTarget() of ${account} is not an address`);
  return {
    root: at("root"), treeSeed: at("treeSeed"), height: small("height", 28), epoch: small("epoch", 0xffff_ffff),
    hotStart: small("hotStart", 0xffff_ffff), hotValueCap: BigInt(at("hotValueCap")), hotFeeCap: BigInt(at("hotFeeCap")),
    allowedTarget: getAddress(`0x${target.slice(26)}`), hybridRequired: BigInt(at("hybridRequired")) === 1n,
  };
}

/**
 * The 503 of Shared interfaces 5: a latest block more than 60 s from the host clock means the chain is stalled (or
 * this host's clock is wrong). Checked before any leaf is spent; sendKeyed checks it again.
 */
export async function requireLiveChain(): Promise<void> {
  const chain = Number(await node.blockTimestamp());
  const host = Math.floor(Date.now() / 1000);
  if (Math.abs(host - chain) > DEFAULTS.maxClockSkewSeconds) {
    throw new HttpError(503, "chain_stalled", `the latest block's timestamp ${chain} is ${host - chain} s from the host clock ${host} (limit ${DEFAULTS.maxClockSkewSeconds} s): the chain looks stalled`);
  }
}

/** No code, no balance, no nonce: a value transfer there creates the account, which costs state gas. */
export async function isEmptyAccount(a: Address): Promise<boolean> {
  const [code, balance, nonce] = await Promise.all([node.code(a), node.balance(a), node.nonce(a, "latest")]);
  return code === "0x" && balance === 0n && nonce === 0n;
}

/** State gas for a SENDER frame that creates its target (spec, frame list). */
export const NEW_ACCOUNT_STATE_GAS = 183_600n;
