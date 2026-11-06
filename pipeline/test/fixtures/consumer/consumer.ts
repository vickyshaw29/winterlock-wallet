// A project that installed the packed @winterlock/pipeline and uses only its core (test/package.test.ts).
// Written with Claude Code (AI) for Vicky.
import { GRIND, Keyring, buildFrameTx, createPipeline, entryLength, grind, keyedNonce, keyringSigner, placeholders, signFrameTx, verifyEntry, type SignatureSlot } from "@winterlock/pipeline/core";
const k = new Keyring({ seed: new Uint8Array(32).fill(7), generation: 0, height: 2, chains: [1337n] });
const signer = keyringSigner(k);
const slots: SignatureSlot[] = [{ kind: "hash", signer, leaf: 1 }];
const at = (fee: bigint) => buildFrameTx({ chainId: 1337n, sender: "0x00000000000000000000000000000000000acc01", nonce: keyedNonce(0, 1), verifyGas: 90_000n, deadline: 1_800_000_000, calls: [{ to: "0x000000000000000000000000000000000000bEEF", value: 1n }], fees: { maxFeePerGas: fee, maxPriorityFeePerGas: 1n }, signatures: placeholders(slots) });
const g = grind((i) => ({ value: 1n + BigInt(i), tx: at(1n + BigInt(i)) }), { ...GRIND.cold, verifyGasLimit: 90_000n });
const { tx, sigHash } = await signFrameTx(g.tx, slots);
const entry = tx.signatures[0]!.signature;
const bytes = Uint8Array.from((entry.slice(2).match(/../g) ?? []).map((h) => parseInt(h, 16)));
const msg = Uint8Array.from((sigHash.slice(2).match(/../g) ?? []).map((h) => parseInt(h, 16)));
const p = createPipeline({ chainId: 1337n, nodeUrl: "http://127.0.0.1:1", gatewayUrl: "http://127.0.0.1:1" });
console.log(JSON.stringify({ sigHash, entryBytes: bytes.length, expected: entryLength(2), ok: verifyEntry({ entry: bytes, msg, root: k.root(), treeSeed: k.treeSeed, height: 2, chainId: 1337n, leaf: 1 }).ok, chainId: String(p.chainId) }));
