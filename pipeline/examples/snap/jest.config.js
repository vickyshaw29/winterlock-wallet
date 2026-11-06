// MetaMask's Snaps test environment: each installSnap() runs dist/bundle.js in its simulated, SES-locked Snap runtime.
module.exports = {
  preset: "@metamask/snaps-jest",
  testMatch: ["<rootDir>/test/**/*.test.js"],
  testTimeout: 180000,
  // MetaMask's own test stack ships ES-module-only packages that Jest 29 cannot require (test/esm-to-cjs.cjs).
  transform: { "\\.[cm]?js$": "<rootDir>/test/esm-to-cjs.cjs" },
  transformIgnorePatterns: [],
};
