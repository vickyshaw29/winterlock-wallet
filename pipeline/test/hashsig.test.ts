import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bytesToHex, encodePacked, hexToBytes, keccak256, toHex, type Hex } from "viem";
import { chain, publicSeedOf, randomization, secretOf, treeSeedOf, wotsPublicKeyFromSignature, wotsSign, leafSecrets, publicKeyOf, publicKeyHashOf } from "../src/hashsig/scheme.ts";
import { EMPTY_SUBTREE, leafNodeOf, rootFromPath } from "../src/hashsig/tree.ts";
import { HashSigError, Keyring, decodeEntry, entryLength, keyringSigner, loadOrCreateSeed, verifyEntry } from "../src/hashsig/keyring.ts";

const SEED = hexToBytes(keccak256(toHex("hashsig unit test seed")));
const msg = (s: string) => hexToBytes(keccak256(toHex(s)));
const hx = (b: Uint8Array) => bytesToHex(b);

describe("derivation, recomputed independently with viem's encodePacked (spec, Key derivation)", () => {
  test("T = keccak256(0x02 ‖ S ‖ uint32(g))", () => {
    expect(hx(treeSeedOf(SEED, 3))).toBe(keccak256(encodePacked(["bytes1", "bytes32", "uint32"], ["0x02", hx(SEED), 3])));
  });
  test("P_i = keccak256(T ‖ uint32(i))", () => {
    const T = treeSeedOf(SEED, 0);
    expect(hx(publicSeedOf(T, 70_000))).toBe(keccak256(encodePacked(["bytes32", "uint32"], [hx(T), 70_000])));
  });
  test("sk_{i,j} = keccak256(0x01 ‖ S ‖ uint32(g) ‖ uint32(i) ‖ uint8(j))", () => {
    expect(hx(secretOf(SEED, 1, 1025, 66))).toBe(keccak256(encodePacked(["bytes1", "bytes32", "uint32", "uint32", "uint8"], ["0x01", hx(SEED), 1, 1025, 66])));
  });
  test("r_k = keccak256(0x03 ‖ P ‖ uint16(k)), Quip's prf", () => {
    const P = publicSeedOf(treeSeedOf(SEED, 0), 5);
    const r = randomization(P);
    expect(r.length).toBe(16);
    for (const k of [0, 1, 15]) expect(hx(r[k]!)).toBe(keccak256(encodePacked(["bytes1", "bytes32", "uint16"], ["0x03", hx(P), k])));
  });
  test("leaf node = keccak256(P ‖ uint256(chainId) ‖ pkHash); EMPTY_SUBTREE from the spec's string", () => {
    const P = msg("P"), pk = msg("pk");
    expect(hx(leafNodeOf(P, 1337n, pk))).toBe(keccak256(encodePacked(["bytes32", "uint256", "bytes32"], [hx(P), 1337n, hx(pk)])));
    expect(hx(EMPTY_SUBTREE)).toBe(keccak256(toHex("nonce-bound-pq-wallet/empty-slot")));
  });
  test("a new generation shares nothing with the old one", () => {
    expect(hx(treeSeedOf(SEED, 0))).not.toBe(hx(treeSeedOf(SEED, 1)));
    expect(hx(secretOf(SEED, 0, 9, 0))).not.toBe(hx(secretOf(SEED, 1, 9, 0)));
  });
});

describe("WOTS+ chains", () => {
  const r = randomization(publicSeedOf(treeSeedOf(SEED, 0), 9));
  test("composable: chain(chain(x, 0, a), a, b) = chain(x, 0, a + b)", () => {
    const x = msg("x");
    for (const [a, b] of [[0, 15], [3, 12], [7, 8], [14, 1], [15, 0]] as const) {
      expect(hx(chain(chain(x, r, 0, a), r, a, b))).toBe(hx(chain(x, r, 0, a + b)));
    }
  });
  test("cannot run past position 15", () => {
    expect(() => chain(msg("x"), r, 10, 6)).toThrow("past the end");
  });
  test("sign then verify gives the public key, for many messages; any other message does not", () => {
    const sk = leafSecrets(SEED, 0, 9);
    const pkHash = hx(publicKeyHashOf(publicKeyOf(sk, r)));
    for (let i = 0; i < 20; i++) {
      const m = msg(`message ${i}`);
      const sig = wotsSign(m, sk, r);
      expect(hx(publicKeyHashOf(wotsPublicKeyFromSignature(m, sig, r)))).toBe(pkHash);
      expect(hx(publicKeyHashOf(wotsPublicKeyFromSignature(msg(`other ${i}`), sig, r)))).not.toBe(pkHash);
    }
  });
});

describe("tree and keyring", () => {
  // a small tree: height 2, two chains, so every leaf of both listed slots can be checked
  const k = new Keyring({ seed: SEED, generation: 0, height: 2, chains: [1337n, 1n] });
  const root = k.root();

  test("every leaf of both listed chains verifies to the root through its path", () => {
    for (const [slot, chainId] of [[0, 1337n], [1, 1n]] as const) {
      for (let leaf = 0; leaf < 4; leaf++) {
        const index = slot * 4 + leaf;
        expect(hx(rootFromPath(k.publicKey(chainId, leaf).leafNode, index, k.authPath(chainId, leaf)))).toBe(hx(root));
      }
    }
  });

  test("signatures verify for the right leaf, chain and message only", () => {
    const m = msg("tx");
    const { entry } = k.sign(1337n, 2, m);
    const base = { entry, msg: m, root, treeSeed: k.treeSeed, height: 2, chainId: 1337n, leaf: 2 };
    expect(verifyEntry(base)).toEqual({ ok: true, reason: null });
    expect(verifyEntry({ ...base, leaf: 3 }).ok).toBe(false);
    expect(verifyEntry({ ...base, chainId: 1n }).ok).toBe(false);
    expect(verifyEntry({ ...base, msg: msg("other") }).ok).toBe(false);
    expect(verifyEntry({ ...base, root: msg("root") }).ok).toBe(false);
  });

  test("entry layout: version, slot, 67 elements, h + 4 path nodes", () => {
    const { entry, signature, authPath } = k.sign(1n, 1, msg("layout"));
    expect(entry.length).toBe(entryLength(2));
    const d = decodeEntry(entry, 2);
    expect([d.version, d.slot]).toEqual([1, 1]);
    expect(d.signature.map(hx)).toEqual(signature.map(hx));
    expect(d.authPath.map(hx)).toEqual(authPath.map(hx));
    expect(entryLength(10)).toBe(2_594);
    expect(entryLength(20)).toBe(2_914);
  });

  test("verifyEntry refuses malformed entries with a reason", () => {
    const m = msg("tx");
    const { entry } = k.sign(1337n, 0, m);
    const base = { entry, msg: m, root, treeSeed: k.treeSeed, height: 2, chainId: 1337n, leaf: 0 };
    const set = (i: number, v: number) => { const e = Uint8Array.from(entry); e[i] = v; return e; };
    expect(verifyEntry({ ...base, entry: set(0, 2) }).reason).toBe("bad_version");
    expect(verifyEntry({ ...base, entry: set(1, 16) }).reason).toBe("bad_slot");
    expect(verifyEntry({ ...base, entry: entry.subarray(1) }).reason).toBe("bad_entry_length");
    expect(verifyEntry({ ...base, leaf: 4 }).reason).toBe("leaf_out_of_range");
    expect(verifyEntry({ ...base, msg: m.subarray(1) }).reason).toBe("bad_msg_length");
  });

  test("input checks", () => {
    expect(() => new Keyring({ seed: new Uint8Array(31), generation: 0, height: 2, chains: [1n] })).toThrow(HashSigError);
    expect(() => new Keyring({ seed: SEED, generation: 0, height: 0, chains: [1n] })).toThrow("bad_height");
    expect(() => new Keyring({ seed: SEED, generation: 0, height: 29, chains: [1n] })).toThrow("bad_height");
    expect(() => new Keyring({ seed: SEED, generation: 0, height: 2, chains: [1n, 1n] })).toThrow("listed twice");
    expect(() => k.sign(5n, 0, msg("m"))).toThrow("bad_chain");
    expect(() => k.sign(1337n, 4, msg("m"))).toThrow("leaf_out_of_range");
    expect(() => k.sign(1337n, 0, new Uint8Array(31))).toThrow("bad_msg_length");
  });

  test("deterministic: the same seed and generation give the same root; another generation does not", () => {
    expect(hx(new Keyring({ seed: SEED, generation: 0, height: 2, chains: [1337n, 1n] }).root())).toBe(hx(root));
    expect(hx(new Keyring({ seed: SEED, generation: 1, height: 2, chains: [1337n, 1n] }).root())).not.toBe(hx(root));
  });

  test("the leaf cache gives the same root and signatures", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hashsig-cache-"));
    const a = new Keyring({ seed: SEED, generation: 0, height: 3, chains: [1337n], cacheDir: dir });
    const rootA = hx(a.root());
    expect(fs.readdirSync(dir).length).toBe(1);
    const b = new Keyring({ seed: SEED, generation: 0, height: 3, chains: [1337n], cacheDir: dir });
    expect(hx(b.root())).toBe(rootA);
    expect(hx(b.sign(1337n, 5, msg("c")).entry)).toBe(hx(a.sign(1337n, 5, msg("c")).entry));
  });

  test("the pipeline signer returns the entry as hex", async () => {
    const m = msg("pipeline");
    const entry = await keyringSigner(k).sign({ chainId: 1337n, leaf: 1, msg: bytesToHex(m) as Hex });
    expect(verifyEntry({ entry: hexToBytes(entry), msg: m, root, treeSeed: k.treeSeed, height: 2, chainId: 1337n, leaf: 1 }).ok).toBe(true);
  });
});

describe("seed file", () => {
  test("created once with 32 random bytes, readable only by its owner, never overwritten", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "seed-")), "account.seed");
    const s1 = loadOrCreateSeed(file);
    expect(s1.length).toBe(32);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(hx(loadOrCreateSeed(file))).toBe(hx(s1));
  });
});

// Cross-implementation check (Nov 6): vectors/h10.json is the Rust signer's file (PR #4, the spec's producer). Our
// TypeScript signer must rebuild its tree from its seed, and our verifier must give every case its expected answer.
// Skipped until that file is on this branch; checked by hand on Nov 6 against PR #4: same tree, 22 of 22 cases.
const RUST_VECTORS = path.resolve(import.meta.dir, "../../vectors/h10.json");
describe.skipIf(!fs.existsSync(RUST_VECTORS))("the Rust signer's vectors (vectors/h10.json)", () => {
  const v = fs.existsSync(RUST_VECTORS) ? JSON.parse(fs.readFileSync(RUST_VECTORS, "utf8")) : { cases: [], params: {} };
  test("our TypeScript signer builds the same tree from the same seed", () => {
    const k = new Keyring({ seed: hexToBytes(v.masterSeed), generation: v.params.generation ?? 0, height: v.params.height, chains: v.params.chainIds.map(BigInt) });
    expect(bytesToHex(k.treeSeed)).toBe(v.treeSeed.toLowerCase());
    expect(bytesToHex(k.root())).toBe(v.root.toLowerCase());
  });
  test("our verifier gives every case its expected answer", () => {
    for (const c of v.cases) {
      const got = verifyEntry({ root: hexToBytes(v.root), treeSeed: hexToBytes(v.treeSeed), height: v.params.height, chainId: BigInt(c.chainId), leaf: c.leaf, msg: hexToBytes(c.message), entry: hexToBytes(c.entry) }).ok;
      expect([c.name, got]).toEqual([c.name, c.expected]);
    }
  });
});
