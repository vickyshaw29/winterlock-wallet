// Compiles contracts/fork/*.sol with the EIP-8141 solc fork (https://github.com/chiranjeev13/solidity) and checks
// that the EIP-8141 opcodes are really in the bytecode. Offline; it never touches the devnet.
//
//   yarn compile:fork /path/to/solc     (default: `solc` from PATH, which must be the fork)
//
// Output goes to contracts/fork/out/<Name>.json ({ abi, bytecode }), which is not committed.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const solc = process.argv[2] ?? "solc";
const dir = "contracts/fork";
const outDir = path.join(dir, "out");

const version = execFileSync(solc, ["--version"], { encoding: "utf8" }).split("\n").find((l) => l.startsWith("Version:"));
console.log(`${solc}: ${version}`);

const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sol"));
const input = {
  language: "Solidity",
  sources: Object.fromEntries(files.map((f) => [f, { content: fs.readFileSync(path.join(dir, f), "utf8") }])),
  settings: {
    evmVersion: "cancun+eip8141",
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.opcodes"] } },
  },
};
const out = JSON.parse(execFileSync(solc, ["--standard-json"], { input: JSON.stringify(input), encoding: "utf8", maxBuffer: 1 << 26 }));
const errors = (out.errors ?? []).filter((e) => e.severity === "error");
if (errors.length) {
  console.error(errors.map((e) => e.formattedMessage).join("\n"));
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
const expected = { ForkSolcWallet: ["SIGPARAM", "APPROVE", "TXPARAM"] };
for (const [file, contracts] of Object.entries(out.contracts)) {
  for (const [name, c] of Object.entries(contracts)) {
    const ops = c.evm.deployedBytecode.opcodes;
    for (const op of expected[name] ?? []) {
      if (!new RegExp(`\\b${op}\\b`).test(ops)) throw new Error(`${name}: ${op} is not in the runtime bytecode`);
    }
    fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify({ abi: c.abi, bytecode: `0x${c.evm.bytecode.object}` }, null, 1) + "\n");
    console.log(`ok ${file}:${name}  (${(expected[name] ?? []).join(", ")} present)`);
  }
}
