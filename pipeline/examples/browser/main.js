// The in-browser example: everything below runs in this page, from dist/core.js (the installable core). Plain
// JavaScript, no build step for this file. Written with Claude Code (AI) for Vicky.
import {
  DEFAULTS, GRIND, MAX_VERIFY_GAS, Keyring, MemoryJournal, createPipeline, entryLength, frameTxHash, grind, keyringSigner,
  placeholders, prefixBudget, signFrameTx, toWire, verifyEntry,
} from "./core.js";

const CHAIN = 1337n;
const HEIGHT = 10;
const HOT_START = 1008; // the cold band is [1, 1008) (plan section 8)
const VERIFY_GAS = 90_000n;
const SENDER = "0x00000000000000000000000000000000000acc01"; // example
const TO = "0x000000000000000000000000000000000000bEEF"; // example

const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n).toLocaleString("en-US");
const bytes = (hex) => Uint8Array.from(hex.slice(2).match(/../g) ?? [], (h) => parseInt(h, 16));
const hex = (u8) => `0x${Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("")}`;
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
const rows = (id, pairs) => {
  const dl = $(id);
  dl.replaceChildren();
  for (const [k, v] of pairs) {
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    if (v instanceof Node) dd.append(v); else dd.textContent = v;
    dl.append(dt, dd);
  }
};
const verdict = (ok, yes, no) => Object.assign(document.createElement("span"), { className: ok ? "ok" : "no", textContent: ok ? yes : no });
const bar = (part, whole, label) => {
  const wrap = document.createElement("div");
  wrap.append(label);
  const b = Object.assign(document.createElement("div"), { className: "bar" });
  b.setAttribute("role", "img");
  b.setAttribute("aria-label", `${Math.round((100 * part) / whole)} percent`);
  b.append(Object.assign(document.createElement("span"), { style: `width:${Math.min(100, (100 * part) / whole)}%` }));
  wrap.append(b);
  return wrap;
};

async function run() {
  $("run").disabled = true;
  $("status").textContent = "Building the key tree (1,024 leaves, 67 hash chains each)…";
  await nextFrame();

  // 1. A throwaway seed and its tree, in memory only.
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const t0 = performance.now();
  const keyring = new Keyring({ seed, generation: 0, height: HEIGHT, chains: [CHAIN] });
  const root = keyring.root();
  const treeMs = performance.now() - t0;
  const signer = keyringSigner(keyring);
  $("status").textContent = "Grinding and signing…";
  await nextFrame();

  // 2. A leaf from a journal kept in memory: the leaf is the nonce key, at sequence 0.
  const journal = MemoryJournal.open(null, { wallet: SENDER, chainId: CHAIN, epoch: 0, height: HEIGHT, treeSeed: signer.treeSeed }, { create: true, ephemeral: true, label: "this page's journal" }); // throwaway seed: nothing to keep
  const { leaf, nonceKey } = journal.reserveNext({ from: 1, to: HOT_START });
  const slots = [{ kind: "hash", signer, leaf }];

  // 3. Build, grind the fee one wei at a time until the WOTS+ chain work fits the 90k verify limit, then sign two-pass.
  const p = createPipeline({ chainId: CHAIN, nodeUrl: "http://127.0.0.1:1", gatewayUrl: "http://127.0.0.1:1" }); // never called here
  const deadline = Math.floor(Date.now() / 1000) + DEFAULTS.expirySeconds;
  const build = (maxFeePerGas) => p.buildFrameTx({
    sender: SENDER, nonce: { keys: [nonceKey], seq: 0n }, verifyGas: VERIFY_GAS, deadline,
    calls: [{ to: TO, value: 10n ** 15n }], fees: { maxFeePerGas, maxPriorityFeePerGas: 1_000_000_000n }, signatures: placeholders(slots),
  });
  const t1 = performance.now();
  const g = grind((i) => ({ value: 2_000_000_000n + BigInt(i), tx: build(2_000_000_000n + BigInt(i)) }), { ...GRIND.cold, verifyGasLimit: VERIFY_GAS });
  const { tx, sigHash } = await signFrameTx(g.tx, slots);
  const signMs = performance.now() - t1;
  journal.mark(leaf, "burned", { note: "signed in the example page, never sent" });

  // 4. Check the entry against the tree, as the account's verify frame would.
  const entry = bytes(tx.signatures[0].signature);
  const check = verifyEntry({ entry, msg: bytes(sigHash), root, treeSeed: keyring.treeSeed, height: HEIGHT, chainId: CHAIN, leaf });
  const budget = prefixBudget(tx);

  rows("env", [
    ["process global", typeof globalThis.process === "undefined" ? "none (not Node)" : "present"],
    ["Bun global", typeof globalThis.Bun === "undefined" ? "none (not Bun)" : "present"],
    ["network", "blocked for this page (connect-src 'none')"],
  ]);
  rows("tree", [
    ["tree", `height ${HEIGHT} + 4 slot levels, ${fmt(2 ** HEIGHT)} leaves for chain ${CHAIN}, built in ${fmt(Math.round(treeMs))} ms`],
    ["root", hex(root)],
    ["leaf", `${leaf} (the lowest unused cold leaf)`],
    ["nonce key", `0x${nonceKey.toString(16)} = (epoch 0 << 32) | leaf ${leaf}, sequence 0`],
    ["journal", `leaf ${leaf}: ${journal.get(leaf).status} (${journal.get(leaf).note})`],
  ]);
  rows("gas", [
    ["chain steps", bar(g.steps, g.maxSteps, `${fmt(g.steps)} of at most ${fmt(g.maxSteps)} (cold leaf, 90k declared behind the proxy)`)],
    ["grind", `${fmt(g.tries.length)} ${g.tries.length === 1 ? "try" : "tries"} of maxFeePerGas, ${fmt(Math.round(signMs))} ms with signing`],
    ["prefix budget", bar(Number(budget), Number(MAX_VERIFY_GAS), `${fmt(budget)} of ${fmt(MAX_VERIFY_GAS)}: expiry ${fmt(DEFAULTS.expiryFrameGas)} + verify ${fmt(VERIFY_GAS)} + entry 100`)],
  ]);
  rows("sig", [
    ["sig hash", sigHash],
    ["entry", `${fmt(entry.length)} bytes = version 1 + slot 1 + WOTS+ 2,144 + path ${fmt(32 * (HEIGHT + 4))} (expected ${fmt(entryLength(HEIGHT))})`],
    ["off-chain verify", verdict(check.ok, "valid against the root", `refused: ${check.reason}`)],
    ["tx hash", frameTxHash(tx)],
    ["would appear at", p.explorerTxUrl(frameTxHash(tx))],
  ]);
  const wire = JSON.stringify(toWire(tx), null, 2);
  $("wire").textContent = wire;
  $("copy").onclick = () => navigator.clipboard.writeText(wire).then(() => { $("copy").textContent = "Copied"; });
  $("out").hidden = false;
  $("status").textContent = `Done: signed leaf ${leaf}, ${check.ok ? "valid" : "INVALID"}. Nothing was sent.`;
  $("run").disabled = false;
  $("run").textContent = "Again, with a new seed";
  document.body.dataset.done = check.ok ? "valid" : "invalid";
}

$("run").addEventListener("click", () => run().catch((e) => {
  $("status").textContent = `Failed: ${e.message}`;
  $("run").disabled = false;
  document.body.dataset.done = "error";
}));
