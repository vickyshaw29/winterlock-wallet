// mm-snap build: bundles src/index.ts with MetaMask's Snaps CLI, then evaluates the bundle in its SES sandbox.
// polyfills false: the pipeline's core needs no Node polyfill (no Buffer, no process).
import type { SnapConfig } from "@metamask/snaps-cli";
import { resolve } from "path";

const config: SnapConfig = {
  input: resolve(__dirname, "src/index.ts"),
  server: { port: 15191 },
  polyfills: false,
  stats: { buffer: false },
};

export default config;
