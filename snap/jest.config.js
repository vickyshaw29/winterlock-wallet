// MetaMask's Snaps test environment: each installSnap() runs dist/bundle.js in its simulated, SES-locked Snap runtime.
// npm test builds that bundle with WL_SNAP_FAKE_CHAIN=1, so nothing reaches the devnet. Written with Claude Code (AI) for Vicky.
module.exports = {
  preset: "@metamask/snaps-jest",
  testMatch: ["<rootDir>/test/**/*.test.js"],
  testTimeout: 180000,
  // MetaMask's own test stack ships ES-module-only packages that Jest 29 cannot require (test/esm-to-cjs.cjs).
  transform: { "\\.[cm]?js$": "<rootDir>/test/esm-to-cjs.cjs" },
  transformIgnorePatterns: [],
};
