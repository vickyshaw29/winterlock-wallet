// mm-snap build: bundles src/index.tsx with MetaMask's Snaps CLI, then evaluates the bundle in its SES sandbox.
// mm-snap watch serves it at http://localhost:15191, the Snap id local:http://localhost:15191 that Flask installs.
// polyfills false: the pipeline's core needs no Node polyfill. WL_SNAP_FAKE_CHAIN=1 (npm test only) builds a bundle that
// talks to the stand-in chain in src/fake-chain.ts instead of the devnet. Written with Claude Code (AI) for Vicky.
import type { SnapConfig } from "@metamask/snaps-cli";
import { resolve } from "path";

const config: SnapConfig = {
  input: resolve(__dirname, "src/index.tsx"),
  server: { port: 15191 },
  polyfills: false,
  stats: { buffer: false },
  environment: { WL_SNAP_FAKE_CHAIN: process.env.WL_SNAP_FAKE_CHAIN ?? "" },
};

export default config;
