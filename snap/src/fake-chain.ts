// A stand-in for the devnet's node and sidecar, shaped like fetch, for npm test only (a bundle built with
// WL_SNAP_FAKE_CHAIN=1): just enough JSON-RPC for the account checks and one keyed send to be admitted, included and
// decided. Copied from pipeline/examples/snap and extended with the genesis block, the factory, the account's code and
// views, and balances. Written with Claude Code (AI) for Vicky.
import { EXPIRY_VERIFIER, EXPIRY_VERIFIER_CODE, NONCE_MANAGER, NONCE_MANAGER_CODE, nonceManagerSlot, proxyRuntimeCode } from "@winterlock/pipeline/core";

type Hex = `0x${string}`;
/** In every bundle built with the stand-in chain, and in no devnet bundle: the tests refuse any other bundle. */
export const FAKE_CHAIN_MARK = "the Winterlock stand-in chain";
export interface FakeTree { root?: Hex; treeSeed?: Hex; factory: Hex; implementation: Hex; account: () => Hex | undefined }

export function fakeChain(t: FakeTree) {
  let head = 100n;
  // As the chain does: one nonce-manager slot per (sender, nonce key), set to 1 in the block that includes its
  // transaction; one hash and receipt per transaction. Each send is included in the next block, two more on top.
  const consumed = new Map<string, bigint>();
  const included = new Map<string, bigint>();
  const hex = (n: bigint) => `0x${n.toString(16)}`;
  const word = (n: number | bigint) => `0x${n.toString(16).padStart(64, "0")}`;
  const isAccount = (a: string) => a.toLowerCase() === t.account()?.toLowerCase();
  const answer = (method: string, params: any[]): unknown => {
    switch (method) {
      case "eth_chainId": return "0x539"; // 1337
      case "eth_getCode": {
        const a = params[0].toLowerCase();
        if (a === NONCE_MANAGER) return NONCE_MANAGER_CODE;
        if (a === EXPIRY_VERIFIER) return EXPIRY_VERIFIER_CODE;
        if (a === t.factory) return "0x6080";
        return isAccount(a) ? proxyRuntimeCode(t.implementation) : "0x";
      }
      case "eth_call": {
        const { to, data } = params[0];
        if (to.toLowerCase() === t.factory && data === "0x5c60da1b") return `0x${t.implementation.slice(2).padStart(64, "0")}`;
        if (isAccount(to) && data === "0xebf0c717") return t.root;
        if (isAccount(to) && data === "0x6f9875b4") return t.treeSeed;
        throw new Error(`no eth_call ${to} ${data}`);
      }
      case "eth_getBalance": return isAccount(params[0]) ? hex(10n ** 18n) : "0x0";
      case "eth_getTransactionCount": return "0x0";
      case "skandha_getGasPrice": return { maxFeePerGas: "0x77359400", maxPriorityFeePerGas: "0x1" };
      case "eth_blockNumber": return hex(head);
      case "eth_getBlockByNumber": return {
        number: params[0] === "latest" ? hex(head) : params[0], hash: params[0] === "0x0" ? word(0x6e6e) : word(head),
        timestamp: hex(BigInt(Math.floor(Date.now() / 1000))), baseFeePerGas: "0x7",
      };
      case "eth_getStorageAt": {
        const at = params[2] === "latest" ? head : BigInt(params[2]);
        const block = params[0].toLowerCase() === NONCE_MANAGER ? consumed.get(params[1].toLowerCase()) : undefined;
        return word(block !== undefined && at >= block ? 1 : 0);
      }
      case "ethrex_simulateFrameTransaction":
        return { canonicalMempoolValid: true, prefixShape: "SelfVerify", payer: null, maxCost: "0x1", gasUsed: "0x1", frames: null, executionStatus: "success" };
      case "eth_sendFrameTransaction": {
        const tx = params[0];
        const block = head + 1n;
        consumed.set(nonceManagerSlot(tx.sender, BigInt(tx.nonceKeys[0])).toLowerCase(), block);
        // the sidecar answers a hash; the pipeline notes one that differs from its own and follows both
        const hash = word(0xf00d00 + included.size + 1);
        included.set(hash, block);
        head += 3n;
        return hash;
      }
      case "skandha_frameTransactionStatus": return { status: included.has(params[0]) || included.size ? "OnChain" : "New" };
      case "eth_getTransactionReceipt":
      case "eth_getFrameTransactionReceipt": {
        const block = included.get(params[0]);
        return block === undefined ? null : { blockNumber: hex(block), status: "0x1", payer: null, cumulativeGasUsed: "0x1", frameReceipts: [0, 1, 2].map(() => ({ status: "0x1", gasUsed: "0x1", logs: [] })) };
      }
      case "skandha_explorer_getTransaction": return { admission: { outcome: "included", checks: [{ rule: "PREFIX-001", verdict: "pass" }], frameStatuses: [] } };
      default: throw new Error(`no ${method} on ${FAKE_CHAIN_MARK}`);
    }
  };
  // A Snap has no Response class: the pipeline's rpc() reads only status and text().
  return (async (_url: unknown, init?: { body?: unknown }) => {
    const { method, params, id } = JSON.parse(String(init?.body));
    let body: unknown;
    try { body = { jsonrpc: "2.0", id, result: answer(method, params) }; } catch (e) { body = { jsonrpc: "2.0", id, error: { code: -32601, message: (e as Error).message } }; }
    return { status: 200, text: async () => JSON.stringify(body) };
  }) as unknown as typeof fetch;
}
