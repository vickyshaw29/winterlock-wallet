// The browser- and MetaMask Snap-safe entry of the pipeline (Nov 6): no Node or Bun API, no `process`, no file system
// anywhere in what this file imports. Build, grind and two-pass sign a frame transaction, keep a journal in memory or
// in the host's store (MemoryJournal), and send through a pipeline bound to a network of its own (createPipeline).
// The backend and scripts import index.ts (Bun), which is this plus the file journal, the genesis pin file, the seed file, the leaf cache
// on disk, the CLI signer and the ticket device. test/core-bundle.test.ts checks the bundle and runs it under SES.
// Written with Claude Code (AI) for Vicky.
export * from "./config.ts";
export * from "./rpc.ts";
export * from "./network.ts";
export * from "./pipeline.ts";
export * from "./builder.ts";
export * from "./signer.ts";
export * from "./journal.ts";
export * from "./submit.ts";
export * from "./wots.ts";
export * from "./grind.ts";
export * from "./admission.ts";
export * from "./account.ts";
export * from "./chain-pin.ts";
export * from "./estimate.ts";
export * from "./lanes.ts";
export * from "./userop.ts";
export {
  ENTRY_VERSION, HashSigError, Keyring, MAX_HEIGHT, decodeEntry, encodeEntry, entryLength, keyringSigner, verifyEntry,
  type KeyringParams, type LeafCache,
} from "./hashsig/keyring-core.ts";
export { computeSigHash, encodeRawFrameTx } from "./codec/codec.ts";
// The vendored file also exports EXPIRY_VERIFIER and NONCE_MANAGER (same values); config.ts holds the Day-0-checked ones.
export { FRAME_MODE, APPROVE_SCOPE, SIG_SCHEME, ATOMIC_BATCH_FLAG, ENTRY_POINT, FRAME_TX_TYPE } from "./codec/FrameTx.ts";
export type { FrameTransaction, Frame, FrameLimits, SignatureEntry, FeeParams, RecentRootReference, FrameMode, SigScheme, ApproveScope } from "./codec/FrameTx.ts";
