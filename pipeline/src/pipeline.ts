// createPipeline: the send path bound to one network of its own (Nov 6). For a browser page or a Snap: nothing is read
// from the environment and nothing global is changed, so two pipelines (two chains, two wallets) can live side by side.
// Written with Claude Code (AI) for Vicky.
//
//   const p = createPipeline({ chainId: 1337n, nodeUrl, gatewayUrl });
//   const journal = MemoryJournal.open(stored, { wallet, chainId: p.chainId, epoch, height, treeSeed }, { store });
//   await p.sendKeyed({ journal, band, sender: wallet, calls, verifyGas, signatures, grind: GRIND.cold, preflight: true });
//
// Each function is the module-level one with this pipeline's network filled in; everything else (journal, signer,
// leaves, grind) is the caller's. The guarantees of the send path are the same (submit.ts header).
import type { Address, Hex } from "viem";
import { DEFAULTS } from "./config.ts";
import { buildFrameTx, type BuildParams } from "./builder.ts";
import { NETWORK_TIMEOUT_MS, createNetwork, type Network, type NetworkOptions } from "./network.ts";
import { checkSystemContracts, pinnedKeyState, sendKeyed, sendWithRetry, settleSubmitted, waitForInclusion, type FollowParams, type RetryParams, type SendKeyedParams } from "./submit.ts";
import { estimateCalls, type EstimateParams } from "./estimate.ts";
import { admissionReport } from "./admission.ts";
import { currentChain } from "./chain-pin.ts";
import { relayConfig } from "./lanes.ts";
import type { Journal } from "./journal.ts";

export type PipelineConfig = NetworkOptions;
type Bound<P> = Omit<P, "network">;

export function createPipeline(config: PipelineConfig) {
  const network: Network = createNetwork(config);
  const transport = { ...(config.fetch ? { fetch: config.fetch } : {}), timeoutMs: config.timeoutMs ?? NETWORK_TIMEOUT_MS };
  return Object.freeze({
    network,
    chainId: network.chainId,
    gateway: network.gateway,
    node: network.node,
    explorerTxUrl: network.explorerTxUrl,
    /** buildFrameTx with this pipeline's chain id */
    buildFrameTx: (p: Omit<BuildParams, "chainId">) => buildFrameTx({ ...p, chainId: network.chainId }),
    checkSystemContracts: () => checkSystemContracts(network),
    pinnedKeyState: (sender: Address, nonceKey: bigint, confirmations: number = DEFAULTS.confirmations) => pinnedKeyState(sender, nonceKey, confirmations, network),
    waitForInclusion: (txHash: Hex, p: Bound<FollowParams>) => waitForInclusion(txHash, { ...p, network }),
    sendKeyed: (p: Bound<SendKeyedParams>) => sendKeyed({ ...p, network }),
    sendWithRetry: (p: Bound<RetryParams>) => sendWithRetry({ ...p, network }),
    settleSubmitted: (journal: Journal, opts: Bound<NonNullable<Parameters<typeof settleSubmitted>[1]>> = {}) => settleSubmitted(journal, { ...opts, network }),
    estimateCalls: (p: Bound<EstimateParams>) => estimateCalls({ ...p, network }),
    admissionReport: (txHash: Hex) => admissionReport(txHash, network),
    currentChain: () => currentChain(network),
    relayConfig: () => relayConfig(config.gatewayUrl, transport),
  });
}

export type Pipeline = ReturnType<typeof createPipeline>;
