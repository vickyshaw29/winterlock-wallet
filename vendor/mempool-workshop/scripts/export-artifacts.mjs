// Copies ABI + creation bytecode of every contract in contracts/src into contracts/artifacts/<Name>.json.
// The artifacts are committed, so the steps run without foundry installed.
import fs from "node:fs";
import path from "node:path";

const src = "contracts/src";
fs.mkdirSync("contracts/artifacts", { recursive: true });
for (const file of fs.readdirSync(src).filter((f) => f.endsWith(".sol"))) {
  const name = path.basename(file, ".sol");
  const out = `contracts/out/${file}/${name}.json`;
  if (!fs.existsSync(out)) continue; // abstract contracts and libraries have no deployable artifact worth exporting
  const j = JSON.parse(fs.readFileSync(out, "utf8"));
  if (!j.bytecode?.object || j.bytecode.object === "0x") continue;
  fs.writeFileSync(`contracts/artifacts/${name}.json`, JSON.stringify({ abi: j.abi, bytecode: j.bytecode.object }, null, 1) + "\n");
  console.log("exported", name);
}
