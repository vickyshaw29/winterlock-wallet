// Writes vectors/h10.ts.json (format of spec, Shared interfaces 1) with the TypeScript signer: valid cases and mutations, for
// account/test/HashSigVectors.t.sol to check against our Yul verifier and Quip's WOTSPlus.sol.
// Every case has the same fields (Foundry decodes JSON into one struct type); a mutation keeps the valid case's
// key material and changes the entry, leaf, chain id or message. The master seed is a throwaway.
// Written with Claude Code (AI) for Vicky.
//   bun scripts/gen-vectors.ts [count of extra random leaves, default 24]
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex } from "viem";
import { Keyring, entryLength, verifyEntry } from "../src/hashsig/keyring.ts";
import { wotsVerifySteps } from "../src/wots.ts";

const HEIGHT = 10;
const CHAINS = [1337n, 1n]; // slot 0 = the devnet, slot 1 = another chain; slots 2-15 hold EMPTY_SUBTREE
const extra = Number(process.argv[2] ?? 24);
const seed = keccak_256(new TextEncoder().encode("winterlock throwaway test vector seed, h10"));
const k = new Keyring({ seed, generation: 0, height: HEIGHT, chains: CHAINS });
const root = k.root();
const hex = (b: Uint8Array) => bytesToHex(b);
const H = (s: string) => keccak_256(new TextEncoder().encode(s));

type Case = {
  name: string; chainId: number; slot: number; leaf: number; publicSeed: string; publicKeyHash: string; message: string;
  signature: string; authPath: string[]; entry: string; expected: boolean; steps: number;
};
const cases: Case[] = [];
const msgs: { tag: string; msg: Uint8Array }[] = [];

function add(chainId: bigint, leaf: number, msg: Uint8Array, tag: string) {
  const pub = k.publicKey(chainId, leaf);
  const s = k.sign(chainId, leaf, msg);
  const base = {
    chainId: Number(chainId), slot: s.slot, leaf, publicSeed: hex(pub.publicSeed), publicKeyHash: hex(pub.publicKeyHash),
    message: hex(msg), signature: hex(Buffer.concat(s.signature)), authPath: s.authPath.map(hex), steps: wotsVerifySteps(hex(msg)),
  };
  const valid: Case = { ...base, name: `${tag}-valid`, entry: hex(s.entry), expected: true };
  // the TypeScript verifier must agree before anything is written
  if (!verifyEntry({ entry: s.entry, msg, root, treeSeed: k.treeSeed, height: HEIGHT, chainId, leaf }).ok) throw new Error(`${tag} does not verify in TS`);
  cases.push(valid);
  const flip = (pos: number) => { const e = Uint8Array.from(s.entry); e[pos] = e[pos]! ^ 0x01; return hex(e); };
  const other = (Number(chainId) === 1337 ? 1 : 1337);
  cases.push(
    { ...base, name: `${tag}-flipped-signature-byte`, entry: flip(2 + 32 * 30 + 7), expected: false },
    { ...base, name: `${tag}-wrong-leaf-index`, leaf: leaf ^ 1, entry: hex(s.entry), expected: false },
    { ...base, name: `${tag}-bad-version`, entry: hex(Uint8Array.from(s.entry, (b, i) => (i === 0 ? 0x02 : b))), expected: false },
    { ...base, name: `${tag}-wrong-path-element`, entry: flip(2 + 2144 + 32 * 3 + 31), expected: false },
    { ...base, name: `${tag}-wrong-slot`, entry: hex(Uint8Array.from(s.entry, (b, i) => (i === 1 ? b ^ 1 : b))), expected: false },
    { ...base, name: `${tag}-wrong-message`, message: hex(H(`${tag} other message`)), entry: hex(s.entry), expected: false },
    { ...base, name: `${tag}-wrong-chain`, chainId: other, entry: hex(s.entry), expected: false },
    { ...base, name: `${tag}-truncated-entry`, entry: hex(s.entry.subarray(0, entryLength(HEIGHT) - 1)), expected: false },
  );
}

const last = 2 ** HEIGHT - 1;
add(1337n, 0, H("leaf 0 message"), "leaf0");
add(1337n, last, H("last leaf message"), "leafLast");
add(1337n, 512, H("middle leaf message"), "leafMiddle");
add(1n, 7, H("slot 1 message"), "slot1");
add(1337n, 3, new Uint8Array(32), "worstMessage"); // all digits 0: 990 chain steps
add(1337n, 4, new Uint8Array(32).fill(0xff), "bestMessage"); // all digits 15: 45 steps
for (let i = 0; i < extra; i++) {
  const leaf = Number(BigInt(hex(H(`random leaf ${i}`))) % BigInt(last + 1));
  add(i % 5 === 0 ? 1n : 1337n, leaf, H(`random message ${i}`), `random${i}`);
}

const out = {
  version: 2,
  params: { hash: "keccak256", n: 32, w: 16, chains: 67, height: HEIGHT, slotBits: 4, chainIds: CHAINS.map(Number) },
  generator: "pipeline/scripts/gen-vectors.ts (TypeScript signer, pipeline/src/hashsig)",
  masterSeed: hex(seed), treeSeed: hex(k.treeSeed), root: hex(root),
  cases,
};
// vectors/h<height>.json itself is the Rust CLI's file (spec); this one sits beside it, and the tests check both.
await Bun.write(`${import.meta.dir}/../../vectors/h${HEIGHT}.ts.json`, JSON.stringify(out, null, 1) + "\n");
console.log(`vectors/h${HEIGHT}.ts.json: ${cases.length} cases (${cases.filter((c) => c.expected).length} valid), root ${hex(root).slice(0, 18)}…`);
