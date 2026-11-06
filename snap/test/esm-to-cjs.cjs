// A Jest transform for the ES-module-only packages in MetaMask's test stack (@metamask/utils 12 and others since
// Oct 2026), which Jest 29 cannot require: SWC (installed with @metamask/snaps-cli) turns ES module syntax into
// CommonJS. Files without import/export statements pass through untouched. Written with Claude Code (AI) for Vicky.
const { transformSync } = require("@swc/core");

const ESM = /^\s*(import\s*[\w{*'"]|export\s+[\w{*]|export\s*\{)/m;

module.exports = {
  process(source, filename) {
    if (!ESM.test(source)) return { code: source };
    const out = transformSync(source, {
      filename,
      swcrc: false,
      sourceMaps: "inline",
      module: { type: "commonjs", importInterop: "node" },
      jsc: { target: "es2022", parser: { syntax: "ecmascript", importAttributes: true } },
    });
    return { code: out.code };
  },
};
