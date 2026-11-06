// Isolation first: fakechain code loads only when the pipeline points at this machine, and no fetch leaves it.
// Written with Claude Code (AI) for Vicky.
//
// Import this before anything else of fakechain that uses the pipeline. The pipeline reads its endpoints once, when
// pipeline/src/config.ts is first evaluated; if that happened with the real devnet's URLs, DEVNET holds them and this
// guard refuses to load, so a fake run can never sign or send toward the real devnet.
import { DEVNET } from "../../pipeline/src/config.ts";
import { CHAIN_ID } from "./constants.ts";

const LOCAL_URL = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i;
export const isLocalUrl = (url: string) => LOCAL_URL.test(url);

/** Every pipeline endpoint on this machine, and the fake's chain id. */
export function assertPipelineIsLocal(): void {
  const endpoints = [["WL_NODE_URL", DEVNET.node], ["WL_GATEWAY_URL", DEVNET.gateway], ["WL_EXPLORER_URL", DEVNET.explorer]] as const;
  for (const [name, url] of endpoints) {
    if (!isLocalUrl(url)) {
      throw new Error(`fakechain: the pipeline's ${name} is ${url}, not this machine. Set the WL_* variables to the fake chain ` +
        "before anything loads the pipeline (fakechain/run.ts and the tests do); fakechain never runs beside the real devnet.");
    }
  }
  if (DEVNET.chainId !== CHAIN_ID) throw new Error(`fakechain: the pipeline's chain id is ${DEVNET.chainId}, not the fake's ${CHAIN_ID} (set WL_CHAIN_ID=${CHAIN_ID})`);
}

/** Wraps fetch so this process can only reach 127.0.0.1, localhost or [::1]. Idempotent. */
export function installFetchGuard(): void {
  const g = globalThis as { __fakechainFetchGuard?: boolean };
  if (g.__fakechainFetchGuard) return;
  const real = globalThis.fetch;
  const guarded = (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!isLocalUrl(url)) return Promise.reject(new Error(`fakechain fetch guard: ${url} is not on this machine; nothing leaves it`));
    return real(input, init);
  };
  globalThis.fetch = Object.assign(guarded, { preconnect: real.preconnect }) as typeof fetch;
  g.__fakechainFetchGuard = true;
}

installFetchGuard();
assertPipelineIsLocal();
