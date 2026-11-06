// Exact cost of hashsig_verify on the devnet's own gas schedule: deploys the standalone verifier (the same
// hashsig_verify the account runs) once, then eth_calls measure() on every valid test vector. No transaction,
// no leaf. Fits gas = fixed + perStep x chain steps.
// Written with Claude Code (AI) for Vicky.
//   (cd ../account && scripts/build.sh) && bun ../vectors exists && bun scripts/measure-verifier.ts
import fs from "node:fs";
import os from "node:os";
import { decodeAbiParameters, encodeFunctionData, keccak256, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { DEVNET, node, rpc } from "../src/index.ts";
import { DATA_DIR } from "./lib/wallet.ts";

const bin = `0x${(await Bun.file(`${import.meta.dir}/../../account/build/HashSigVerifier.bin`).text()).trim()}` as Hex;
const stateFile = `${DATA_DIR}/verifier-${DEVNET.chainId}.json`;
const saved = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : {};
// Reuse the deployed verifier only if it was deployed from this exact build AND its code on chain is what that deploy
// left there (fixed Nov 6: a redeploy used to keep the old address and measure the old contract).
const runtimeHash = async (a?: Address) => (a ? keccak256(await node.code(a)) : null);
let verifier: Address | undefined = saved.address;
if (!(saved.codeHash === keccak256(bin) && saved.runtimeHash && (await runtimeHash(verifier)) === saved.runtimeHash)) {
  const key = (await Bun.file(`${os.homedir()}/.winterlock/devnet-eoa.key`).text()).trim() as Hex;
  const eoa = privateKeyToAccount(key);
  const raw = await eoa.signTransaction({ chainId: Number(DEVNET.chainId), nonce: Number(await node.nonce(eoa.address)), to: null, value: 0n, gas: 3_000_000n, gasPrice: 2_000_000_000n, data: bin, type: "legacy" });
  const hash = await rpc<Hex>(DEVNET.node, "eth_sendRawTransaction", [raw]);
  verifier = undefined;
  for (let i = 0; i < 40 && !verifier; i++) {
    const r = await rpc<any>(DEVNET.node, "eth_getTransactionReceipt", [hash]);
    if (r) { if (r.status !== "0x1") throw new Error(`deploy ${hash} reverted`); verifier = r.contractAddress; }
    else await new Promise((res) => setTimeout(res, 3000));
  }
  if (!verifier) throw new Error(`deploy ${hash} not mined in 120 s`);
  const deployedCode = await node.code(verifier);
  if (deployedCode === "0x") throw new Error(`no code at ${verifier} after deploy ${hash}`);
  fs.writeFileSync(stateFile, JSON.stringify({ address: verifier, codeHash: keccak256(bin), runtimeHash: keccak256(deployedCode), deployTx: hash }, null, 2));
  console.log(`deployed the standalone verifier at ${verifier} (tx ${hash})`);
}

const abi = parseAbi(["function measure(bytes32 root, bytes32 treeSeed, uint8 height, uint256 chainId, uint32 leaf, bytes32 msgHash, bytes entry) returns (bool, uint256)"]);
const v = JSON.parse(fs.readFileSync(`${import.meta.dir}/../../vectors/h10.ts.json`, "utf8"));
const points: { steps: number; gas: number; name: string }[] = [];
for (const c of v.cases.filter((c: any) => c.expected)) {
  const data = encodeFunctionData({ abi, functionName: "measure", args: [v.root, v.treeSeed, 10, BigInt(c.chainId), c.leaf, c.message, c.entry] });
  const out = await rpc<Hex>(DEVNET.node, "eth_call", [{ to: verifier!, data }, "latest"]);
  const [ok, gas] = decodeAbiParameters([{ type: "bool" }, { type: "uint256" }], out);
  if (!ok) throw new Error(`${c.name} did not verify on the devnet`);
  points.push({ steps: c.steps, gas: Number(gas), name: c.name });
}
points.sort((a, b) => a.steps - b.steps);
const n = points.length, mx = points.reduce((s, p) => s + p.steps, 0) / n, my = points.reduce((s, p) => s + p.gas, 0) / n;
const slope = points.reduce((s, p) => s + (p.steps - mx) * (p.gas - my), 0) / points.reduce((s, p) => s + (p.steps - mx) ** 2, 0);
const fixed = my - slope * mx;
const resid = Math.max(...points.map((p) => Math.abs(p.gas - (fixed + slope * p.steps))));
console.log(`${n} valid vectors verified on the devnet by eth_call (all true)`);
console.log(`  best ${points[0]!.steps} steps: ${points[0]!.gas} gas; worst ${points.at(-1)!.steps} steps: ${points.at(-1)!.gas} gas`);
console.log(`  hashsig_verify on the devnet = ${fixed.toFixed(0)} + ${slope.toFixed(2)} x chain steps (largest residual ${resid.toFixed(0)})`);
