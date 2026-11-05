import type { Address, Hex } from "viem";
import { loadConfig } from "./config.js";
import { StepError } from "./output.js";
import { rpc } from "./rpc.js";

export interface ReputationItem {
  address: string;
  status: "ok" | "throttled" | "banned";
  opsSeen: number;
  opsIncluded: number;
  isStaked: boolean;
}
export interface ReputationPage {
  items: ReputationItem[];
  nextCursor?: string;
}
export interface Reputation {
  status: "OK" | "THROTTLED" | "BANNED";
  opsSeen: number;
  opsIncluded: number;
  isStaked: boolean;
}

const defaultPager = (cursor?: string): Promise<ReputationPage> =>
  rpc(loadConfig().gatewayUrl, "skandha_explorer_listReputation", [{ limit: 200, ...(cursor ? { cursor } : {}) }]);

/** The explorer has no per-address lookup, so this walks its pages. An entity the node never saw is OK with zero counters. */
export async function getReputation(address: Address, page: (cursor?: string) => Promise<ReputationPage> = defaultPager): Promise<Reputation> {
  let cursor: string | undefined;
  for (let i = 0; i < 100; i++) {
    const p = await page(cursor);
    const hit = p.items.find((e) => e.address.toLowerCase() === address.toLowerCase());
    if (hit) return { status: hit.status.toUpperCase() as Reputation["status"], opsSeen: hit.opsSeen, opsIncluded: hit.opsIncluded, isStaked: hit.isStaked };
    if (!p.nextCursor) break;
    cursor = p.nextCursor;
  }
  return { status: "OK", opsSeen: 0, opsIncluded: 0, isStaked: false };
}

/**
 * THE SHORTCUT used by step 9: writes an entity's reputation counters directly through the devnet's open
 * `debug_bundler_setReputation`. Real nodes restrict this method. Only ever call it for the participant's own entity.
 */
export async function setReputation(address: Address, opsSeen: number, opsIncluded: number): Promise<void> {
  await rpc(loadConfig().gatewayUrl, "debug_bundler_setReputation", [[{ address, opsSeen, opsIncluded }], loadConfig().entryPoint]);
}


export interface RuleCheck {
  rule: string;
  frameIndex?: number;
  entity?: string;
  verdict: "pass" | "fail" | "skipped";
  detail?: string;
}
export interface AdmissionRecord {
  id: number;
  txHash: string;
  sender: string;
  nonce: string;
  nonceKeys: string[];
  at: number;
  source: string;
  outcome: "rejected" | "accepted" | "included" | "replaced" | "dropped";
  errorCode?: number;
  checks: RuleCheck[];
  frames: unknown[];
  frameStatuses: string[];
}
export interface LifecycleEvent {
  seq: number;
  txHash: string;
  at: number;
  kind: string;
  status?: string;
  reason?: string;
  blockNumber?: number;
}
export interface TransactionDetail {
  hash: string;
  entry: Record<string, unknown> | null;
  admission: AdmissionRecord | null;
  events: LifecycleEvent[];
}
type DetailFetcher = (hash: Hex) => Promise<TransactionDetail | null>;

const defaultDetail: DetailFetcher = async (hash) => {
  try {
    return await rpc(loadConfig().gatewayUrl, "skandha_explorer_getTransaction", [hash]);
  } catch (e) {
    if (e instanceof StepError && /not found/i.test(e.message)) return null;
    throw e;
  }
};

/** The node's rule-by-rule admission report for a tx it saw (accepted or rejected). The explorer history is in memory only. */
export async function getAdmission(hash: Hex, fetchDetail: DetailFetcher = defaultDetail): Promise<AdmissionRecord | null> {
  return (await fetchDetail(hash))?.admission ?? null;
}

export async function getLifecycle(hash: Hex, fetchDetail: DetailFetcher = defaultDetail): Promise<LifecycleEvent[]> {
  return (await fetchDetail(hash))?.events ?? [];
}

export const failedChecks = (a: AdmissionRecord): RuleCheck[] => a.checks.filter((c) => c.verdict === "fail");
