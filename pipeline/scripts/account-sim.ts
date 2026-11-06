// Devnet test suite for the account's verify path. Every check in yul/Account.yul is hit by a transaction
// built to break exactly that rule, run through ethrex_simulateFrameTransaction (free: nothing is sent), and
// the refusal must carry the rule's own reason. Then real sends: a cold transfer, an admin call that switches
// hybrid on, the hybrid cases, a hot ticket, and the kill switch. The account is reset to its starting state
// (hybrid off, hot cap as deployed) before and after, so the suite can run again. The admin rules (refusals in
// rotate, setHybrid, setHotPolicy, setOwner) use no EIP-8141 opcode, so account/test/Account.t.sol covers them on
// the same bytecode; eth_call cannot stand in for a SENDER frame, because ethrex refuses a contract as sender (EIP-3607).
// Written with Claude Code (AI) for Vicky. Needs a placeholder-verifier deployment record.
//   WL_GATEWAY_URL=https://altmempool.forshtat.com/rpc bun scripts/account-sim.ts .data/deployment-1337.placeholder.json
//
// With the placeholder verifier a "signature" is just the message hash, so signing several simulated
// transactions with one leaf is harmless here. With the real signer every simulation exposes a real
// one-time signature: only ever simulate the exact transaction you then send.
import os from "node:os";
import { concat, encodeFunctionData, hexToBytes, keccak256, parseAbi, toHex, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, sign } from "viem/accounts";
import {
  DEVNET, FRAME_MODE, buildFrameTx, gateway, nonceKeyFor, node, placeholderSigner, placeholders, rpc, sendKeyed, signFrameTx,
  type Call, type FrameTransaction, type HashSigner, type SignatureSlot,
} from "../src/index.ts";
import { loadDeployment, openJournal, requirePlaceholder } from "./lib/wallet.ts";

const deployment = loadDeployment(process.argv[2]);
requirePlaceholder(deployment, "account-sim.ts"); // it simulates many transactions per leaf, outside the journal
const ACCOUNT: Address = deployment.account;
const TARGET: Address = deployment.params.allowedTarget;
const HOT_START: number = deployment.params.hotStart;
const HOT_CAP = BigInt(deployment.params.hotValueCap);
const FEE_CAP = BigInt(deployment.params.hotFeeCap);
const OTHER: Address = "0x000000000000000000000000000000000000dEaD";
const key = (await Bun.file(`${os.homedir()}/.winterlock/devnet-eoa.key`).text()).trim() as Hex;
const owner = privateKeyToAccount(key);
const ACCOUNT_ABI = parseAbi([
  "function setHybrid(bool on)", "function setHotPolicy(uint32 hotStart, uint256 valueCap, uint256 feeCap, address allowedTarget)",
  "function hybridRequired() view returns (bool)", "function hotValueCap() view returns (uint256)",
]);

const ENTRY_LEN = 2_594;

// Leaves: real sends take cold leaves from [1, 500) and hot from [HOT_START, 1020) through the journal;
// simulations use leaves outside those bands, so a simulated key is never one a real send has consumed.
const COLD_BAND = { from: 1, to: 500 }, HOT_BAND = { from: HOT_START, to: 1020 };
const COLD = 600, HOT = 1020;

/** Placeholder-format entry: version 0x01, slot 0x00, then the message hash, then zeros. */
const hashSigner: HashSigner = placeholderSigner({ treeSeed: deployment.params.treeSeed });
const ecdsaOwner: SignatureSlot = { kind: "ecdsa", privateKey: key, signer: owner.address };
const hashSlot = (leaf: number): SignatureSlot => ({ kind: "hash", signer: hashSigner, leaf });

const gp = await gateway.gasPrice();
const FEES = { maxFeePerGas: BigInt(gp.maxFeePerGas), maxPriorityFeePerGas: BigInt(gp.maxPriorityFeePerGas) };
const deadline = () => Math.floor(Date.now() / 1000) + 90;

// ---------------------------------------------------------------- simulated cases
interface Case {
  name: string;
  expect: string | RegExp;
  keys?: bigint[]; seq?: bigint; leaf?: number; epoch?: number;
  slots?: SignatureSlot[];
  calls?: Call[];
  fees?: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
  /** change the transaction after building, before signing (frames) */
  shape?: (tx: FrameTransaction) => FrameTransaction;
  /** change the signed transaction */
  tamper?: (tx: FrameTransaction) => FrameTransaction | Promise<FrameTransaction>;
}

async function build(c: Case): Promise<FrameTransaction> {
  const leaf = c.leaf ?? COLD;
  const slots = c.slots ?? [hashSlot(leaf)];
  let tx = buildFrameTx({
    chainId: DEVNET.chainId, sender: ACCOUNT, verifyGas: 60_000n, deadline: deadline(), fees: c.fees ?? FEES,
    nonce: { keys: c.keys ?? [nonceKeyFor(c.epoch ?? 0, leaf)], seq: c.seq ?? 0n },
    calls: c.calls ?? [{ to: TARGET, value: 1n }],
    signatures: placeholders(slots),
  });
  if (c.shape) tx = c.shape(tx);
  const signed = (await signFrameTx(tx, slots)).tx;
  return c.tamper ? await c.tamper(signed) : signed;
}

/** The refusal reason: the account's 32-byte revert string, or the protocol's own message. */
async function verdict(tx: FrameTransaction): Promise<string> {
  let sim: any;
  try { sim = await node.simulate(tx, false); } catch (e) { return `rpc: ${(e as Error).message}`; }
  if (sim.canonicalMempoolValid && sim.executionStatus === "success") return "valid";
  if (sim.revertData && sim.revertData !== "0x") {
    const text = new TextDecoder().decode(hexToBytes(sim.revertData)).replace(/\0+$/, "");
    if (/^[\x20-\x7e]+$/.test(text)) return text;
  }
  return `${sim.canonicalMempoolViolation ?? sim.executionError ?? sim.executionStatus}${sim.haltReason ? ` (${sim.haltReason}, frame ${sim.failedFrameIndex})` : ""}`;
}

let pass = 0, fail = 0;
async function run(cases: Case[]) {
  for (const c of cases) {
    const got = await verdict(await build(c)).catch((e) => `build error: ${(e as Error).message}`);
    const ok = typeof c.expect === "string" ? got === c.expect : c.expect.test(got);
    ok ? pass++ : fail++;
    console.log(`${ok ? "OK" : "XX"} ${c.name.padEnd(52)} ${got}${ok ? "" : `   (expected: ${c.expect})`}`);
  }
}
const setBytes = (sigIndex: number, edit: (b: Uint8Array) => Uint8Array) => (tx: FrameTransaction): FrameTransaction => ({
  ...tx, signatures: tx.signatures.map((s, i) => (i === sigIndex ? { ...s, signature: toHex(edit(hexToBytes(s.signature as Hex))) } : s)),
});
const withByte = (pos: number, v: number) => (b: Uint8Array) => { const c = b.slice(); c[pos] = v; return c; };
/** Entry 0 becomes the owner's valid signature over some other 32-byte digest (msg set explicitly). */
const ownerSignsOtherDigest = async (tx: FrameTransaction): Promise<FrameTransaction> => {
  const digest = keccak256(toHex("not this transaction"));
  const s = await sign({ hash: digest, privateKey: key });
  const packed = concat([toHex(s.yParity!, { size: 1 }), s.r, s.s]);
  return { ...tx, signatures: tx.signatures.map((e, i) => (i === 0 ? { ...e, msg: digest, signature: packed } : e)) };
};

// ---------------------------------------------------------------- real sends
const journal = openJournal(deployment);
async function send(label: string, calls: Call[], band: { from: number; to: number }, hybrid: boolean) {
  const r = await sendKeyed({
    journal, band, sender: ACCOUNT, calls, verifyGas: 60_000n, preflight: true,
    signatures: (leaf) => (hybrid ? [ecdsaOwner, hashSlot(leaf)] : [hashSlot(leaf)]),
  });
  const verifyGas = r.receipt ? BigInt(r.receipt.frameReceipts[1]!.gasUsed.execution) : 0n;
  console.log(`   ${label}: leaf ${r.leaf}, ${r.outcome} in block ${r.receipt ? BigInt(r.receipt.blockNumber) : "-"}, verify frame ${verifyGas} gas, ${r.explorerUrl}`);
  if (r.outcome !== "OnChain") throw new Error(`${label}: ${r.outcome}`);
  return r;
}
const view = async (fn: "hybridRequired" | "hotValueCap") =>
  BigInt(await rpc<Hex>(DEVNET.node, "eth_call", [{ to: ACCOUNT, data: encodeFunctionData({ abi: ACCOUNT_ABI, functionName: fn }) }, "latest"]));
const setHybridCall = (on: boolean): Call => ({ to: ACCOUNT, data: encodeFunctionData({ abi: ACCOUNT_ABI, functionName: "setHybrid", args: [on] }) });
/** setHotPolicy writes slot 3; turning a zero slot nonzero costs 97,920 state gas, so the frame declares state gas. */
const hotPolicyCall = (cap: bigint): Call => ({
  to: ACCOUNT, stateGas: 100_000n,
  data: encodeFunctionData({ abi: ACCOUNT_ABI, functionName: "setHotPolicy", args: [HOT_START, cap, FEE_CAP, TARGET] }),
});
async function resetAccount(when: string) {
  const hybrid = (await view("hybridRequired")) === 1n;
  if ((await view("hotValueCap")) !== HOT_CAP) await send(`${when}: hot value cap back to ${HOT_CAP}`, [hotPolicyCall(HOT_CAP)], COLD_BAND, hybrid);
  if (hybrid) await send(`${when}: hybrid off`, [setHybridCall(false)], COLD_BAND, true);
}

// ================================================================ the suite
console.log(`account ${ACCOUNT}, verifier: ${deployment.verifier}`);
await resetAccount("reset");

console.log(`\n== hybrid off: simulations`);
await run([
  { name: "valid cold transfer", expect: "valid" },
  { name: "valid cold, any call (a self admin call)", expect: "valid", calls: [setHybridCall(true)] },
  { name: "valid hot ticket under the caps", expect: "valid", leaf: HOT, calls: [{ to: TARGET, value: HOT_CAP / 2n }] },
  { name: "two nonce keys", expect: "nonce: key count", keys: [nonceKeyFor(0, COLD), nonceKeyFor(0, COLD + 1)] },
  { name: "the legacy nonce [0]", expect: "nonce: legacy key", keys: [0n], seq: await node.nonce(ACCOUNT, "latest") },
  { name: "key from another epoch", expect: "nonce: epoch", epoch: 1 },
  { name: "leaf beyond 2^height", expect: "nonce: leaf range", leaf: 1024 },
  { name: "two entries while hybrid is off", expect: "sig: count", slots: [ecdsaOwner, hashSlot(COLD)] },
  { name: "ECDSA entry only, no hash-based entry", expect: "sig: entry scheme", slots: [ecdsaOwner] },
  { name: "hash-based entry with an explicit msg", expect: "sig: entry msg", tamper: (tx) => ({ ...tx, signatures: tx.signatures.map((s) => ({ ...s, msg: keccak256("0x01") })) }) },
  { name: "entry one byte short", expect: "sig: entry length", tamper: setBytes(0, (b) => b.slice(0, ENTRY_LEN - 1)) },
  { name: "entry version 0x02", expect: "sig: entry version", tamper: setBytes(0, withByte(0, 2)) },
  { name: "chain slot 16", expect: "sig: entry slot", tamper: setBytes(0, withByte(1, 16)) },
  { name: "entry signs another message", expect: "sig: hash-based check", tamper: setBytes(0, withByte(2, 0xff)) },
  { name: "hot: pays another target", expect: "hot: frame target", leaf: HOT, calls: [{ to: OTHER, value: 1n }] },
  { name: "hot: one payment over the value cap", expect: "hot: value cap", leaf: HOT, calls: [{ to: TARGET, value: HOT_CAP + 1n }] },
  { name: "hot: two payments summing over the cap", expect: "hot: value cap", leaf: HOT, calls: [{ to: TARGET, value: HOT_CAP / 2n + 1n }, { to: TARGET, value: HOT_CAP / 2n }] },
  { name: "hot: payment with calldata", expect: "hot: frame data", leaf: HOT, calls: [{ to: TARGET, value: 1n, data: "0x01" }] },
  { name: "hot: a DEFAULT frame after verify", expect: "hot: frame mode", leaf: HOT, shape: (tx) => ({ ...tx, frames: [...tx.frames.slice(0, -1), { ...tx.frames.at(-1)!, mode: FRAME_MODE.DEFAULT, value: 0n }] }) },
  { name: "hot: maximum cost over the fee cap", expect: "hot: fee cap", leaf: HOT, fees: { maxFeePerGas: 50_000_000_000n, maxPriorityFeePerGas: 1n } },
  { name: "hot: values that overflow 2^256", expect: "hot: value overflow", leaf: HOT, calls: [{ to: TARGET, value: 1n << 255n }, { to: TARGET, value: 1n << 255n }] },
]);

console.log(`\n== real sends`);
const first = await send("cold transfer", [{ to: TARGET, value: 1n }], COLD_BAND, false);
await run([
  { name: "used key again at sequence 0 (the protocol refuses)", expect: /nonce/i, leaf: first.leaf },
  { name: "used key at sequence 1 (the account refuses)", expect: "nonce: sequence", leaf: first.leaf, seq: 1n },
]);
await send("admin: setHybrid(true)", [setHybridCall(true)], COLD_BAND, false);
console.log(`   hybridRequired() = ${(await view("hybridRequired")) === 1n}`);

const strangerKey = generatePrivateKey();
console.log(`\n== hybrid on: simulations`);
await run([
  { name: "valid cold: owner ECDSA + hash-based entry", expect: "valid", slots: [ecdsaOwner, hashSlot(COLD)] },
  { name: "cold without the owner's signature", expect: "sig: count" },
  { name: "cold signed by someone else", expect: "sig: owner", slots: [{ kind: "ecdsa", privateKey: strangerKey, signer: privateKeyToAccount(strangerKey).address }, hashSlot(COLD)] },
  { name: "owner signed an explicit digest, not the tx", expect: "sig: owner msg", slots: [ecdsaOwner, hashSlot(COLD)], tamper: ownerSignsOtherDigest },
  { name: "entry 0 is not ECDSA", expect: "sig: owner scheme", slots: [hashSlot(COLD), hashSlot(COLD)] },
  { name: "hot ticket still needs no classical key", expect: "valid", leaf: HOT, calls: [{ to: TARGET, value: 1n }] },
]);

console.log(`\n== hot ticket and kill switch`);
await send("hot ticket", [{ to: TARGET, value: HOT_CAP / 10n }], HOT_BAND, false);
await send("admin: hot value cap 0 (kill switch)", [hotPolicyCall(0n)], COLD_BAND, true);
await run([{ name: "hot ticket after the kill switch", expect: "hot: disabled", leaf: HOT, calls: [{ to: TARGET, value: 1n }] }]);

console.log(`\n== back to the starting state`);
await resetAccount("restore");
console.log(`   hybridRequired() = ${(await view("hybridRequired")) === 1n}, hotValueCap() = ${await view("hotValueCap")}`);
console.log(`\n${pass} as expected, ${fail} not`);
