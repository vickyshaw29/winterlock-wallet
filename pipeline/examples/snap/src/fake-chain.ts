// A stand-in for the devnet's node and sidecar, shaped like fetch: just enough JSON-RPC for one keyed send to be
// admitted, included and decided. Example only: a real Snap would pass the global fetch (endowment:network-access)
// and the devnet's URLs to createPipeline instead. Written with Claude Code (AI) for Vicky.
import { EXPIRY_VERIFIER, EXPIRY_VERIFIER_CODE, NONCE_MANAGER, NONCE_MANAGER_CODE } from "@winterlock/pipeline/core";

export function fakeChain(events: string[]) {
  let head = 100n;
  let included: bigint | null = null;
  const hex = (n: bigint) => `0x${n.toString(16)}`;
  const word = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
  const answer = (method: string, params: any[]): unknown => {
    switch (method) {
      case "eth_chainId": return "0x539"; // 1337
      case "eth_getCode": return params[0].toLowerCase() === NONCE_MANAGER ? NONCE_MANAGER_CODE : params[0].toLowerCase() === EXPIRY_VERIFIER ? EXPIRY_VERIFIER_CODE : "0x";
      case "skandha_getGasPrice": return { maxFeePerGas: "0x77359400", maxPriorityFeePerGas: "0x1" };
      case "eth_blockNumber": return hex(head);
      case "eth_getBlockByNumber": return { number: params[0] === "latest" ? hex(head) : params[0], timestamp: hex(BigInt(Math.floor(Date.now() / 1000))), baseFeePerGas: "0x7" };
      case "eth_getStorageAt": {
        const at = params[2] === "latest" ? head : BigInt(params[2]);
        return word(params[0].toLowerCase() === NONCE_MANAGER && included !== null && at >= included ? 1 : 0);
      }
      case "ethrex_simulateFrameTransaction":
        return { canonicalMempoolValid: true, prefixShape: "SelfVerify", payer: null, maxCost: "0x1", gasUsed: "0x1", frames: null, executionStatus: "success" };
      case "eth_sendFrameTransaction":
        events.push(`send key ${params[0].nonceKeys[0]}`);
        included = head + 1n;
        head += 3n; // included, and two blocks on top
        return word(0xf00d); // the sidecar answers a hash; the pipeline notes one that differs from its own
      case "skandha_frameTransactionStatus": return { status: included === null ? "New" : "OnChain" };
      case "eth_getTransactionReceipt":
      case "eth_getFrameTransactionReceipt":
        return included === null ? null : { blockNumber: hex(included), status: "0x1", payer: null, cumulativeGasUsed: "0x1", frameReceipts: [0, 1, 2].map(() => ({ status: "0x1", gasUsed: "0x1", logs: [] })) };
      case "skandha_explorer_getTransaction": return { admission: { outcome: "included", checks: [{ rule: "PREFIX-001", verdict: "pass" }], frameStatuses: [] } };
      default: throw new Error(`no ${method}`);
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
