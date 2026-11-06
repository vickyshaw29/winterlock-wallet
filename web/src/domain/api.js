// A client for every backend endpoint (spec, Shared interfaces 5, extended Nov 6), typed with JSDoc; a failed call
// throws ApiError carrying the spec's {error, detail} shape and any extra fields (a 422 adds txHash, leaf, simulation).
// Written with Claude Code (AI) for Vicky. Gas view types added with Codex (OpenAI) for Vicky.

/**
 * @typedef {Object} WalletSummary GET /api/wallets
 * @property {string} address
 * @property {number} epoch
 * @property {number} height
 * @property {string} balanceWei decimal wei
 */

/**
 * @typedef {Object} Tickets the wallet's ticket device for the current epoch
 * @property {number} exported tickets cut
 * @property {number} used
 * @property {number} left
 * @property {number} [unjournaled] tickets cut whose device journal is missing: the backend signs none of them and cuts
 *   no more (409 device_unusable) until the journal is recovered; then used and left are 0
 */

/**
 * @typedef {Object} WalletView GET /api/wallets/:address, read from the chain and the journals
 * @property {string} address
 * @property {string} root
 * @property {string} treeSeed
 * @property {number} height
 * @property {number} epoch
 * @property {number} leavesUsed leaves the cold journal holds, exported tickets included
 * @property {number} leafCount 2^height
 * @property {number} lanesInFlight
 * @property {boolean} hybrid
 * @property {boolean} locked
 * @property {string} balanceWei
 * @property {number} hotStart first hot leaf
 * @property {string} hotValueCapWei
 * @property {string} hotFeeCapWei
 * @property {string} allowedTarget
 * @property {Tickets} tickets
 * @property {boolean} rotationPending
 * @property {Leaves} [leaves] the current epoch's leaves by state, for the key register (spec, Nov 6)
 */

/**
 * @typedef {Object} Leaves GET /api/wallets/:address's leaves (spec, Shared interfaces 5, Nov 6): leaf numbers by state,
 *   from the cold journal and the ticket device's journal. A ticket in none of the lists is still on the phone; any
 *   other leaf in none of them is unused.
 * @property {number[]} onChain keys the chain consumed
 * @property {number[]} burned burned by the signer: expired, refused, an estimate, never sent
 * @property {number[]} inFlight reserved or submitted, not decided
 * @property {{ from: number, to: number } | null} tickets the band cut to the ticket device, to inclusive
 */

/**
 * @typedef {Object} AdmissionCheck
 * @property {string} rule
 * @property {"pass" | "fail" | "skipped"} verdict
 * @property {string} [detail]
 * @property {number} [frameIndex]
 * @property {string} [entity]
 */

/**
 * @typedef {Object} AdmissionReport the sidecar's per-rule verdict
 * @property {string} txHash
 * @property {string} outcome accepted, rejected, included, replaced or dropped
 * @property {number} [errorCode]
 * @property {AdmissionCheck[]} checks
 * @property {AdmissionCheck[]} failed
 * @property {string[]} frameStatuses
 * @property {string} summary
 */

/**
 * @typedef {Object} FrameReceipt
 * @property {string} status success, reverted or skipped
 * @property {{ execution: string, state: string }} gasUsed hex
 */

/**
 * @typedef {Object} Receipt
 * @property {string} blockNumber hex
 * @property {"success" | "reverted"} status
 * @property {string} payer
 * @property {string} cumulativeGasUsed hex
 * @property {FrameReceipt[]} frameReceipts
 * @property {string} [gasUsed] hex, the node's receipt only
 */

/**
 * @typedef {"Submitted" | "OnChain" | "Reverted" | "Included" | "Expired" | "Refused" | "Unknown"} TxStatus
 */

/**
 * @typedef {Object} TxRecord GET /api/tx/:hash, and each item of GET /api/wallets/:address/txs. A lane only a
 *   journal knows (one a script sent) has kind, mempool, to and valueWei null.
 * @property {string} txHash
 * @property {TxStatus} status
 * @property {string} explorerUrl
 * @property {Receipt | null} receipt
 * @property {{ verifyGas: string | null, violations: string[] }} simulation verifyGas is the self_verify frame's gas
 * @property {string} wallet
 * @property {"send" | "rotate" | "hot-policy" | null} kind
 * @property {number} leaf
 * @property {string} nonceKey 0x hex: the lane
 * @property {string} nonceSeq
 * @property {"keyed" | "hot"} mode
 * @property {"alt" | "public" | null} mempool
 * @property {string | null} to
 * @property {string | null} valueWei
 * @property {number | null} deadline unix seconds
 * @property {AdmissionReport | null} admission
 * @property {{ status: string, at: string }[]} timeline
 * @property {string | null} retryOf
 * @property {string | null} retriedAs
 * @property {string | null} detail why it was refused, or what is not known about it
 * @property {string} createdAt ISO
 * @property {string} updatedAt ISO
 * @property {string | null} [maxCostWei] decimal wei: what the sidecar sets aside for the lane while it is pending
 *   (spec, Nov 6), when the backend reports it
 * @property {unknown} [wire] the exact JSON sent (GET /api/tx/:hash only)
 * @property {{ declaredVerifyGas: string | null, verifyGas: string | null, intrinsicGas: string | null, floorGas: string | null, billedBytes: number | null, gasUsed: string | null } | null} [gas] backend-computed gas columns; unknown values remain null
 * @property {{ field: "maxFeePerGas" | "lastFrameGas", steps: number, maxSteps: number, tries: number[] } | null} [grind] hash work of the messages tried before the one signature was made
 */

/**
 * @typedef {Object} SendBody POST /api/wallets/:address/send
 * @property {string} to
 * @property {string} [valueWei]
 * @property {string} [data]
 * @property {"keyed" | "hot"} [mode]
 * @property {number} [expirySeconds]
 * @property {number} [firstAttemptExpirySeconds] the first attempt's deadline only (the stuck payment's 4 s); retries
 *   keep expirySeconds
 * @property {"alt" | "public"} [mempool]
 * @property {string} [maxFeePerGasWei] first attempt only; the screens never send it (a low fee cannot stick on this devnet)
 * @property {number} [retries] fresh-leaf attempts after an expiry, 0 to 3
 */

/**
 * @typedef {Object} SendAnswer
 * @property {string} txHash
 * @property {number} leaf
 * @property {string[]} nonceKeys
 * @property {string} nonceSeq
 * @property {"Submitted"} status
 */

/**
 * @typedef {Object} CreateWalletBody POST /api/wallets
 * @property {number} [height]
 * @property {string} spendLimitWei the hot value cap
 * @property {boolean} [hybrid]
 * @property {(number | string)[]} [chainIds]
 * @property {number} [hotStart]
 * @property {string} [hotFeeCapWei]
 * @property {string} [allowedTarget]
 */

/** @typedef {{ address: string, root: string, epoch: number, funded: boolean }} CreateWalletAnswer */
/** @typedef {{ hotStart: number, valueCapWei: string, feeCapWei: string, allowedTarget: string }} HotPolicyBody */
/** @typedef {{ txHash: string, status: "Submitted" }} HotPolicyAnswer */
/** @typedef {{ txHash: string, newRoot: string, epoch: number }} RotateAnswer */
/** @typedef {{ from: number, to: number, count: number }} TicketCut to is inclusive */
/** @typedef {{ n: number, mode: "keyed" | "hot", valueWei: string, to: string }} PlanQuery n lanes of valueWei each to `to` */
/** @typedef {{ backendUrl: string }} WebConfig GET /web/config, from serve.ts */

/** A failed call: HTTP status (0 when the web server could not be reached), the backend's code and detail, the whole body. */
export class ApiError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} detail
   * @param {Record<string, any>} body
   */
  constructor(status, code, detail, body) {
    super(detail);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.body = body;
  }
}

/** @typedef {(input: string, init: RequestInit) => Promise<Response>} Fetch */

/**
 * @param {{ base?: string, fetch?: Fetch }} [opts] base is "" in the pages (same origin); tests pass the server's URL
 */
export function createApi(opts = {}) {
  const base = (opts.base ?? "").replace(/\/+$/, "");
  /** @type {Fetch} */
  const doFetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const seg = encodeURIComponent;

  /**
   * @param {string} method
   * @param {string} path
   * @param {unknown} [body]
   * @returns {Promise<any>}
   */
  async function call(method, path, body) {
    /** @type {Record<string, string>} */
    const headers = { accept: "application/json" };
    /** @type {RequestInit} */
    const init = { method, headers };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await doFetch(`${base}${path}`, init);
    } catch (e) {
      throw new ApiError(0, "unreachable", `the web server could not be reached: ${e instanceof Error ? e.message : String(e)}`, {});
    }
    const text = await res.text();
    /** @type {any} */
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!res.ok) {
      const code = data && typeof data.error === "string" ? data.error : `http_${res.status}`;
      const detail = data && typeof data.detail === "string" ? data.detail : (text.slice(0, 300) || res.statusText);
      throw new ApiError(res.status, code, detail, data && typeof data === "object" ? data : {});
    }
    if (data === null) throw new ApiError(res.status, "bad_answer", `${method} ${path} did not answer JSON`, {});
    return data;
  }

  return {
    base,
    /** @returns {Promise<WalletSummary[]>} */
    listWallets: () => call("GET", "/api/wallets"),
    /** @param {CreateWalletBody} body @returns {Promise<CreateWalletAnswer>} */
    createWallet: (body) => call("POST", "/api/wallets", body),
    /** @param {string} address @returns {Promise<WalletView>} */
    wallet: (address) => call("GET", `/api/wallets/${seg(address)}`),
    /** @param {string} address @returns {Promise<TxRecord[]>} newest first */
    txs: (address) => call("GET", `/api/wallets/${seg(address)}/txs`),
    /** @param {string} hash @returns {Promise<TxRecord>} */
    tx: (hash) => call("GET", `/api/tx/${seg(hash)}`),
    /** @param {string} address @param {SendBody} body @returns {Promise<SendAnswer>} */
    send: (address, body) => call("POST", `/api/wallets/${seg(address)}/send`, body),
    /** @param {string} address @param {{ height: number }} body @returns {Promise<RotateAnswer>} */
    rotate: (address, body) => call("POST", `/api/wallets/${seg(address)}/rotate`, body),
    /** @param {string} address @param {HotPolicyBody} body @returns {Promise<HotPolicyAnswer>} */
    hotPolicy: (address, body) => call("POST", `/api/wallets/${seg(address)}/hot-policy`, body),
    /** @param {string} address @param {{ count: number }} body @returns {Promise<TicketCut>} */
    tickets: (address, body) => call("POST", `/api/wallets/${seg(address)}/tickets`, body),
    /**
     * GET /api/status, which the backend may add later: null while it answers 404.
     * @returns {Promise<Record<string, any> | null>}
     */
    status: async () => {
      try { return await call("GET", "/api/status"); } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      }
    },
    /**
     * GET /api/wallets/:address/lanes/plan (spec, Nov 6): the parallel-lanes plan before a burst; it reserves no leaf
     * and signs nothing. Null while a backend without the route answers 404 not_found (an unknown wallet's 404 throws).
     * @param {string} address
     * @param {PlanQuery} q
     * @returns {Promise<Record<string, any> | null>}
     */
    lanesPlan: async (address, q) => {
      const query = new URLSearchParams({ n: String(q.n), mode: q.mode, valueWei: q.valueWei, to: q.to });
      try { return await call("GET", `/api/wallets/${seg(address)}/lanes/plan?${query}`); } catch (e) {
        if (e instanceof ApiError && e.status === 404 && e.code === "not_found") return null;
        throw e;
      }
    },
    /** @returns {Promise<WebConfig>} */
    config: () => call("GET", "/web/config"),
  };
}

/** @typedef {ReturnType<typeof createApi>} Api */
