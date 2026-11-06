// HTTP answers: the error shape {error, detail} of Shared interfaces 5, input checks, and how pipeline errors map to
// statuses. A detail only ever carries public values: the pipeline's messages hold leaves, keys, hashes and paths,
// never a seed or a ticket secret, and anything unexpected becomes a generic 500.
// Written with Claude Code (AI) for Vicky.
import { getAddress, hexToBytes, isAddress, type Address, type Hex } from "viem";
import {
  LeavesExhausted, PreflightRefused, RetryStopped, RpcError, SendError, SubmissionRefused,
  type AdmissionReport, type FrameTxReceipt, type SimulationResult,
} from "../../pipeline/src/index.ts";
import { message } from "./files.ts";

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, detail: string, readonly extra: Record<string, unknown> = {}) {
    super(detail);
  }
}

export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)), {
    status, headers: { "content-type": "application/json; charset=utf-8" },
  });

export const errorResponse = (e: HttpError) => json(e.status, { error: e.code, detail: e.message, ...e.extra });

const bad = (detail: string) => new HttpError(400, "bad_request", detail);

/** A JSON object with only the named fields; anything else is a typo the caller should hear about. */
export function fields(body: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw bad("the body must be a JSON object");
  const extra = Object.keys(body).filter((k) => !allowed.includes(k));
  if (extra.length) throw bad(`unknown field${extra.length > 1 ? "s" : ""} ${extra.join(", ")}; allowed: ${allowed.join(", ")}`);
  return body as Record<string, unknown>;
}

/** A query string with only the named parameters, each at most once (the lanes plan, Nov 6). */
export function queryFields(query: URLSearchParams, allowed: readonly string[]): Record<string, string | undefined> {
  const out: Record<string, string> = {};
  const extra: string[] = [];
  for (const [k, v] of query) {
    if (!allowed.includes(k)) { extra.push(k); continue; }
    if (k in out) throw bad(`${k} is given more than once`);
    out[k] = v;
  }
  if (extra.length) throw bad(`unknown parameter${extra.length > 1 ? "s" : ""} ${[...new Set(extra)].join(", ")}; allowed: ${allowed.join(", ")}`);
  return out;
}

/** A query value that is a plain whole number, as a number for check.int; anything else stays text, which check.int refuses. */
export const queryNumber = (v: string): number | string => (/^\d{1,15}$/.test(v) ? Number(v) : v);

export const check = {
  address(v: unknown, name: string): Address {
    if (typeof v !== "string" || !isAddress(v, { strict: false }) || (v !== v.toLowerCase() && !isAddress(v))) throw bad(`${name} must be an address (lower case or checksummed)`);
    return getAddress(v);
  },
  /** Amounts are decimal strings of wei (spec, Shared interfaces 5). */
  wei(v: unknown, name: string): bigint {
    if (typeof v !== "string" || !/^(0|[1-9]\d*)$/.test(v)) throw bad(`${name} must be a decimal string of wei`);
    const n = BigInt(v);
    if (n >= 1n << 256n) throw bad(`${name} does not fit in 256 bits`);
    return n;
  },
  int(v: unknown, name: string, min: number, max: number): number {
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw bad(`${name} must be a whole number from ${min} to ${max}`);
    return v;
  },
  bool(v: unknown, name: string): boolean {
    if (typeof v !== "boolean") throw bad(`${name} must be true or false`);
    return v;
  },
  hex(v: unknown, name: string): Hex {
    if (typeof v !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(v)) throw bad(`${name} must be 0x-prefixed hex bytes`);
    return v.toLowerCase() as Hex;
  },
  oneOf<T extends string>(v: unknown, name: string, values: readonly T[]): T {
    if (typeof v !== "string" || !values.includes(v as T)) throw bad(`${name} must be one of ${values.map((x) => `"${x}"`).join(", ")}`);
    return v as T;
  },
  chainId(v: unknown, name: string): bigint {
    if (typeof v === "number" && Number.isSafeInteger(v) && v > 0) return BigInt(v);
    if (typeof v === "string" && /^[1-9]\d{0,19}$/.test(v) && BigInt(v) < 1n << 64n) return BigInt(v);
    throw bad(`${name} must be a positive chain id`);
  },
};

/** The account reverts with one 32-byte ASCII reason (Account.yul fail); anything else is shown as hex. */
export function revertReason(data: Hex | null | undefined): string | null {
  if (!data || data === "0x") return null;
  let bytes: Uint8Array;
  try { bytes = hexToBytes(data); } catch { return null; }
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  const text = bytes.subarray(0, end);
  return text.length && text.every((b) => b >= 0x20 && b < 0x7f) ? new TextDecoder().decode(text) : data;
}

/**
 * GET /tx/:hash's simulation: verifyGas is the self_verify frame's gas (frame 1, after the expiry frame) from the
 * receipt when the transaction is included, else from the dry run; violations are the public mempool's verdict, the
 * execution error, the account's revert reason, the admission report's failed rules, and the JSON-RPC error message
 * of a refusal that came as one (often the only reason given, e.g. by the public pool).
 */
export function simulationView(sim: SimulationResult | null | undefined, receipt: FrameTxReceipt | null | undefined, admission: AdmissionReport | null | undefined, refusal?: unknown) {
  const gas = receipt?.frameReceipts?.[1]?.gasUsed?.execution ?? sim?.frames?.[1]?.gasUsed ?? null;
  const out: string[] = [];
  const canonical = sim ? (sim.canonicalMempoolViolation ?? sim.violation ?? null) : null;
  if (canonical) out.push(canonical);
  if (sim?.executionError) out.push(sim.executionError);
  const reason = revertReason(sim?.revertData);
  if (reason) out.push(`account: ${reason}`);
  for (const f of admission?.failed ?? []) out.push(`${f.rule}${f.frameIndex !== undefined ? ` (frame ${f.frameIndex})` : ""}: ${f.detail ?? "failed"}`);
  if (refusal instanceof RpcError) out.push(refusal.message);
  let verifyGas: string | null = null;
  try { verifyGas = gas === null ? null : BigInt(gas).toString(); } catch { /* not a number: leave it out */ }
  return { verifyGas, violations: [...new Set(out)] };
}

/** True when an RpcError sits anywhere in the cause chain: the node or sidecar could not be read. */
function rpcCause(e: unknown): boolean {
  for (let x: unknown = e, i = 0; x && i < 8; x = (x as Error).cause, i++) if (x instanceof RpcError) return true;
  return false;
}

export type Mode = "keyed" | "hot";

/** The pipeline's errors as HTTP answers (brief, "Error mapping"). Unknown errors return null: the caller logs them. */
export function mapError(e: unknown, mode: Mode = "keyed"): HttpError | null {
  if (e instanceof HttpError) return e;
  if (e instanceof RetryStopped) return e.cause ? mapError(e.cause, mode) : new HttpError(409, "cannot_send", e.message);
  if (e instanceof LeavesExhausted) return new HttpError(409, mode === "hot" ? "tickets_exhausted" : "leaves_exhausted", e.message);
  if (e instanceof PreflightRefused || e instanceof SubmissionRefused) {
    return new HttpError(422, "refused", e.message, {
      txHash: e.txHash, leaf: e.leaf, simulation: simulationView(e.simulation, null, e.admission, e.cause), admission: e.admission,
    });
  }
  const text = message(e);
  if (/is in use by another process/.test(text)) return new HttpError(409, "journal_busy", text);
  if (e instanceof SendError) {
    if (e.stage === "check" && /differ by more than \d+ s/.test(text)) return new HttpError(503, "chain_stalled", text);
    if (rpcCause(e)) return new HttpError(502, "rpc_failed", text);
    return new HttpError(409, "cannot_send", text);
  }
  if (e instanceof RpcError) return new HttpError(502, "rpc_failed", text);
  return null;
}
