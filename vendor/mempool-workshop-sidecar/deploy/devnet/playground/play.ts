// Devnet playground: deploys tiny test contracts, then sends frame transactions of many shapes
// (valid, failing, stalling) to the gateway and the miner so the explorer has something to show.
// See README.md in this directory. From the repository root, after `bun run build`:
//   bun deploy/devnet/playground/play.ts setup                 # fund test keys, deploy contracts (idempotent)
//   bun deploy/devnet/playground/play.ts play [--only text] [--pause ms]
import fs from "node:fs";
import { getContractAddress, keccak256, toHex, type Hex } from "viem";
import { privateKeyToAccount, sign } from "viem/accounts";
import { buildUnsignedFrameTx, signFrameTx, toWire, WALLET_INIT_CODE, PAYMASTER_INIT_CODE } from "../../../test/e2e/helpers";
import { FRAME_MODE, SIG_SCHEME, ATOMIC_BATCH_FLAG, type Frame, type FrameTransaction } from "@skandha/types/lib/contracts/FrameTx.js";
import { computeSigHash } from "@skandha/executor/lib/services/FrameTxService/codec.js";

const env = (name: string, fallback: string) => process.env[name] ?? fallback;
const G = env("PLAYGROUND_GATEWAY", "https://altmempoolgateway.forshtat.com/rpc");
const M = env("PLAYGROUND_MINER", "https://altmempool.forshtat.com/rpc");
const ETHREX = env("PLAYGROUND_ETHREX", "https://altmempool.forshtat.com");
const CHAIN_ID = Number(env("PLAYGROUND_CHAIN_ID", "1337"));
const STATE_FILE = env("PLAYGROUND_STATE", "./.playground-state.json");
// The devnet's shared, throwaway funder (see deploy/devnet/devnet-readme.md). Never use it on a real network.
const K0 = env("PLAYGROUND_FUNDER_KEY", "0x06f911c1ecb2053bb443ba0a0e28d630c583c3c0c2f334a9ecdc8c7c6ad4ea15") as Hex;
const key = (name: string): Hex => keccak256(toHex(`skandha-playground:${name}`));
const addr = (name: string) => privateKeyToAccount(key(name)).address;

async function call(url: string, method: string, params: unknown[] = []) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return (await res.json()) as { result?: any; error?: { code?: number; message: string } };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hexN = (n: bigint) => `0x${n.toString(16)}`;

// ------------------------------------------------------------------ contracts
const init = (runtime: string) => {
  const len = (runtime.length / 2).toString(16).padStart(2, "0");
  return `0x60${len}600c60003960${len}6000f3${runtime}` as Hex;
};
const APPROVE_BOTH = "600360006000aa";
const DEAD = "000000000000000000000000000000000000dead";
const CONTRACTS = ["SELF", "SELF2", "OKW", "OKW2", "PAY", "H", "STO", "VALCALL", "VALCALL0", "COD", "BAD_TIMESTAMP", "BAD_NUMBER", "BAD_COINBASE", "BAD_ORIGIN", "BAD_GASPRICE", "REVERTER", "LOOPER", "NOAPPROVE"] as const;
type ContractName = (typeof CONTRACTS)[number];
const FUNDED_KEYS = [...Array.from({ length: 30 }, (_, i) => `s${i + 1}`), "r1"];

function initCodeFor(name: ContractName, addrs: Record<string, Hex>): Hex {
  const h = addrs.H!.slice(2).toLowerCase();
  switch (name) {
    case "SELF": case "SELF2": return init(APPROVE_BOTH);
    case "OKW": case "OKW2": return WALLET_INIT_CODE;
    case "PAY": return PAYMASTER_INIT_CODE;
    case "H": return init("6000545000"); // SLOAD slot 0, POP, STOP
    case "STO": return init(`6000600060006000` + `73${h}` + `61ffff` + `fa` + `50` + APPROVE_BOTH); // STATICCALL H, then approve
    case "VALCALL": return init(`6000600060006000` + `6001` + `73${h}` + `61ffff` + `f1` + `50` + APPROVE_BOTH); // CALL H with value 1
    case "VALCALL0": return init(`6000600060006000` + `6000` + `73${h}` + `61ffff` + `f1` + `50` + APPROVE_BOTH); // CALL H with value 0
    case "COD": return init(`73${DEAD}` + `3b` + `50` + APPROVE_BOTH); // EXTCODESIZE of an empty address
    case "BAD_TIMESTAMP": return init(`42${APPROVE_BOTH}`);
    case "BAD_NUMBER": return init(`43${APPROVE_BOTH}`);
    case "BAD_COINBASE": return init(`41${APPROVE_BOTH}`);
    case "BAD_ORIGIN": return init(`32${APPROVE_BOTH}`);
    case "BAD_GASPRICE": return init(`3a${APPROVE_BOTH}`);
    case "REVERTER": return init("60006000fd");
    case "LOOPER": return init("5b600056");
    case "NOAPPROVE": return init("00");
  }
}

async function setup() {
  const k0 = privateKeyToAccount(K0);
  let nonce = Number((await call(ETHREX, "eth_getTransactionCount", [k0.address, "pending"])).result);
  const state: { contracts: Record<string, Hex> } = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : { contracts: {} };
  const plan: { name: string; to: Hex | null; value: bigint; data: Hex; nonce: number }[] = [];
  for (const k of FUNDED_KEYS) {
    const bal = BigInt((await call(ETHREX, "eth_getBalance", [addr(k), "latest"])).result);
    if (bal < 10_000_000_000_000_000n) plan.push({ name: `fund ${k}`, to: addr(k), value: 100_000_000_000_000_000n, data: "0x", nonce: nonce++ });
  }
  for (const c of CONTRACTS) {
    if (state.contracts[c]) continue;
    state.contracts[c] = getContractAddress({ from: k0.address, nonce: BigInt(nonce) });
    plan.push({ name: `deploy ${c}`, to: null, value: 50_000_000_000_000_000n, data: "0x", nonce: nonce++ });
  }
  for (const p of plan) {
    if (p.name.startsWith("deploy")) p.data = initCodeFor(p.name.split(" ")[1] as ContractName, state.contracts as Record<string, Hex>);
    const raw = await k0.signTransaction({ chainId: CHAIN_ID, nonce: p.nonce, to: p.to, value: p.value, gas: 600_000n, gasPrice: 2_000_000n, data: p.data, type: "legacy" });
    const sent = await call(ETHREX, "eth_sendRawTransaction", [raw]);
    if (sent.error) console.log(p.name.padEnd(24), `ERROR ${sent.error.message}`);
  }
  console.log(`sent ${plan.length} setup transactions; waiting for them to be mined…`);
  for (let i = 0; i < 60; i++) {
    const latest = Number((await call(ETHREX, "eth_getTransactionCount", [k0.address, "latest"])).result);
    if (latest >= nonce) break;
    await sleep(5000);
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  for (const [name, a] of Object.entries(state.contracts)) {
    const code = (await call(ETHREX, "eth_getCode", [a, "latest"])).result;
    if (!code || code === "0x") console.log(name, a, "NO CODE");
  }
  console.log("setup done");
}

// ------------------------------------------------------------------ scenarios
const fees = { maxPriorityFeePerGas: 1_000_000_000n, maxFeePerGas: 2_000_000_000n, maxFeePerBlobGas: 0n };
const frame = (mode: number, flags: number, target: Hex | null, execution: bigint, value = 0n, data: Hex = "0x"): Frame =>
  ({ mode, flags, target, limits: { execution, state: 0n }, value, data }) as Frame;
const selfVerify = (limit = 30_000n) => frame(FRAME_MODE.VERIFY, 3, null, limit);
const transfer = (to: Hex, value = 1n, limit = 50_000n, flags = 0) => frame(FRAME_MODE.SENDER, flags, to, limit, value);
const arbitrary = [{ scheme: SIG_SCHEME.ARBITRARY, signer: "0x", msg: "0x", signature: "0x" }] as FrameTransaction["signatures"];
const eoaSigs = [{ scheme: SIG_SCHEME.SECP256K1, signer: "0x", msg: "0x", signature: "0x" }] as FrameTransaction["signatures"];

const argValue = (flag: string) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const ONLY = argValue("--only")?.toLowerCase();
const PAUSE_MS = Number(argValue("--pause") ?? 400);
const KEYS_FROM = Number(argValue("--keys-from") ?? 0); // rotate the funded keys s1..s30 by this many

async function main() {
  const cmd = process.argv[2];
  if (cmd === "setup") return setup();
  const C = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")).contracts as Record<ContractName, Hex>;

  // The node only accepts a sender's current on-chain nonce, so a sender can have one transaction in flight.
  const chainNonce = async (a: Hex) => BigInt((await call(ETHREX, "eth_getTransactionCount", [a, "latest"])).result);
  const accepted: { name: string; node: string; hash: string }[] = [];
  const RECIP = addr("k2");
  // A funded key with nothing in flight. Scenarios skipped by --only still take a key, so a subset
  // uses the same keys as the full run; --keys-from rotates the range (s1..s30, wrapping) so a rerun
  // avoids keys that are still busy.
  let next = 0;
  const fresh = () => `s${((++next + KEYS_FROM - 1) % 30) + 1}`;

  async function send(name: string, node: "G" | "M", tx: FrameTransaction, signWith?: Hex) {
    if (ONLY && !name.toLowerCase().includes(ONLY)) return;
    const signed = signWith ? await signFrameTx(tx, signWith) : tx;
    let line: string;
    try {
      const r = await call(node === "G" ? G : M, "eth_sendFrameTransaction", [toWire(signed)]);
      if (r.error) {
        line = `${node} REJECTED  ${name.padEnd(38)} ${r.error.code ?? ""} ${(r.error.message ?? JSON.stringify(r.error)).slice(0, 120)}`;
      } else {
        line = `${node} accepted  ${name.padEnd(38)} ${String(r.result).slice(0, 18)}…`;
        accepted.push({ name, node, hash: r.result });
      }
    } catch (e) {
      line = `${node} ERROR     ${name.padEnd(38)} ${String(e).slice(0, 120)}`;
    }
    console.log(line);
    await sleep(PAUSE_MS);
  }
  async function eoa(name: string, node: "G" | "M", k: string, senderFrames: Frame[], over: Partial<FrameTransaction> = {}, signWith?: Hex) {
    const sender = addr(k);
    const tx: FrameTransaction = { chainId: BigInt(CHAIN_ID), nonceKeys: [0n], nonceSeq: await chainNonce(sender), sender, frames: [selfVerify(), ...senderFrames], signatures: eoaSigs, fees, blobVersionedHashes: [], recentRootReferences: [], ...over };
    return send(name, node, tx, signWith ?? key(k));
  }
  async function wallet(name: string, node: "G" | "M", w: ContractName, frames: Frame[], over: Partial<FrameTransaction> = {}) {
    const sender = C[w];
    return send(name, node, { chainId: BigInt(CHAIN_ID), nonceKeys: [0n], nonceSeq: await chainNonce(sender), sender, frames, signatures: arbitrary, fees, blobVersionedHashes: [], recentRootReferences: [], ...over });
  }
  const verifyOnly = (limit = 30_000n) => frame(FRAME_MODE.VERIFY, 2, null, limit);
  const payFrame = (limit = 30_000n) => frame(FRAME_MODE.VERIFY, 1, C.PAY, limit);
  const A = ATOMIC_BATCH_FLAG;
  const slowFee = (max: bigint, prio: bigint) => ({ fees: { maxPriorityFeePerGas: prio, maxFeePerGas: max, maxFeePerBlobGas: 0n } });

  console.log("== accepted: ordinary shapes");
  await eoa("eoa transfer", "G", fresh(), [transfer(RECIP)]);
  await eoa("eoa transfer", "M", fresh(), [transfer(RECIP)]);
  await eoa("eoa 3 transfers", "G", fresh(), [transfer(RECIP), transfer(addr("k3")), transfer(addr("k4"))]);
  await eoa("eoa atomic batch of 2 + tail", "M", fresh(), [transfer(RECIP, 1n, 50_000n, A), transfer(addr("k3"), 1n, 50_000n, A), transfer(addr("k4"))]);
  await eoa("eoa 20 KB calldata", "G", fresh(), [frame(FRAME_MODE.SENDER, 0, RECIP, 400_000n, 0n, `0x${"ab".repeat(20_000)}`)]);
  await eoa("eoa 40 frames", "M", fresh(), Array.from({ length: 39 }, (_, i) => transfer(RECIP, BigInt(i + 1))));
  await wallet("contract wallet self-pay", "G", "SELF", [frame(FRAME_MODE.VERIFY, 3, null, 30_000n), transfer(RECIP)]);
  await wallet("contract wallet self-pay", "M", "SELF2", [frame(FRAME_MODE.VERIFY, 3, null, 30_000n), transfer(RECIP)]);
  await wallet("paymaster-sponsored", "M", "OKW", [verifyOnly(), payFrame(), transfer(RECIP)]);
  await wallet("paymaster-sponsored, 3 senders", "G", "OKW2", [verifyOnly(), payFrame(), transfer(RECIP), transfer(addr("k3")), transfer(addr("k4"))]);

  console.log("== accepted, but the execution goes wrong");
  await eoa("sender frame reverts", "G", fresh(), [transfer(C.REVERTER, 1n, 100_000n)]);
  await eoa("sender frame runs out of gas", "M", fresh(), [transfer(C.LOOPER, 0n, 60_000n)]);
  await eoa("atomic batch, middle frame reverts", "G", fresh(), [transfer(RECIP, 1n, 50_000n, A), transfer(C.REVERTER, 1n, 100_000n, A), transfer(RECIP)]);
  await eoa("sender calls the approving wallet", "M", fresh(), [transfer(C.OKW, 1n, 100_000n)]);
  await eoa("value more than the balance", "G", fresh(), [transfer(RECIP, 10n ** 18n)]);

  console.log("== accepted, but likely never mined (stalled)");
  await eoa("fee below the base fee (1 wei)", "G", fresh(), [transfer(RECIP)], slowFee(1n, 0n));
  await eoa("fee just above the base fee (8 wei)", "M", fresh(), [transfer(RECIP)], slowFee(8n, 0n));
  await eoa("absurd fee (10 000 ETH cap)", "G", fresh(), [transfer(RECIP)], slowFee(10n ** 22n, 1_000_000_000n));

  console.log("== replacement and duplicates (one key, same nonce)");
  const kr = fresh();
  await eoa("replace: first (2 gwei)", "M", kr, [transfer(RECIP)]);
  await eoa("replace: bump to 4 gwei", "M", kr, [transfer(addr("k4"), 2n)], slowFee(4_000_000_000n, 2_000_000_000n));
  await eoa("replace: bump to 1 wei above (too small?)", "M", kr, [transfer(addr("k4"), 3n)], slowFee(4_000_000_001n, 2_000_000_001n));
  await eoa("replace: cheaper (rejected?)", "M", kr, [transfer(addr("k4"), 4n)], slowFee(1_000_000_000n, 1_000_000_000n));
  const kd = fresh();
  const dupTx: FrameTransaction = { chainId: BigInt(CHAIN_ID), nonceKeys: [0n], nonceSeq: await chainNonce(addr(kd)), sender: addr(kd), frames: [selfVerify(), transfer(RECIP, 5n)], signatures: eoaSigs, fees, blobVersionedHashes: [], recentRootReferences: [] };
  const dupSigned = await signFrameTx(dupTx, key(kd));
  await send("same tx to the gateway…", "G", dupSigned);
  await send("…and at once to the miner", "M", dupSigned);
  await send("…and to the gateway again", "G", dupSigned);
  console.log("== a burst from six different keys");
  for (let i = 0; i < 6; i++) await eoa(`burst ${i + 1}/6`, i % 2 ? "M" : "G", fresh(), [transfer(RECIP, BigInt(i + 1))]);

  console.log("== rejected: prefix and structure");
  const R = "r1";
  await send("no validation frame at all", "G", { chainId: BigInt(CHAIN_ID), nonceKeys: [0n], nonceSeq: await chainNonce(addr(R)), sender: addr(R), frames: [transfer(RECIP)], signatures: eoaSigs, fees, blobVersionedHashes: [], recentRootReferences: [] }, key(R));
  await eoa("verify frame targets a stranger", "M", R, [], { frames: [frame(FRAME_MODE.VERIFY, 3, RECIP, 30_000n), transfer(RECIP)] });
  await eoa("atomic flag on the verify frame", "G", R, [transfer(RECIP)], { frames: [frame(FRAME_MODE.VERIFY, 3 | A, null, 30_000n), transfer(RECIP)] });
  await eoa("atomic flag on the last frame", "M", R, [transfer(RECIP, 1n, 50_000n, A)]);
  await eoa("verify frame after the prefix", "G", R, [transfer(RECIP), frame(FRAME_MODE.VERIFY, 2, null, 30_000n)]);
  await eoa("65 frames (max is 64)", "M", R, Array.from({ length: 64 }, () => transfer(RECIP)));
  await eoa("no frames", "G", R, [], { frames: [] });
  await eoa("wrong chain id", "M", R, [transfer(RECIP)], { chainId: 9n });
  await eoa("validation gas above the cap (120k)", "G", R, [transfer(RECIP)], { frames: [selfVerify(120_000n), transfer(RECIP)] });
  await eoa("unknown frame mode (7)", "M", R, [frame(7, 0, RECIP, 50_000n, 1n)]);
  await eoa("no signature entry", "G", R, [transfer(RECIP)], { signatures: [] });

  console.log("== rejected: signature and simulation");
  await eoa("signed by the wrong key", "G", R, [transfer(RECIP)], {}, key("k9"));
  await eoa("sender has no funds", "M", "k9", [transfer(RECIP)]);
  await eoa("nonce already used", "G", "k11", [transfer(RECIP)], { nonceSeq: 0n });
  await eoa("nonce in the future", "M", R, [transfer(RECIP)], { nonceSeq: (await chainNonce(addr(R))) + 3n });
  await wallet("validation runs out of gas (100 gas)", "G", "SELF", [frame(FRAME_MODE.VERIFY, 3, null, 100n), transfer(RECIP)]);
  await wallet("validation loops forever", "M", "LOOPER", [frame(FRAME_MODE.VERIFY, 3, null, 30_000n), transfer(RECIP)]);
  await wallet("validation never approves", "G", "NOAPPROVE", [frame(FRAME_MODE.VERIFY, 3, null, 30_000n), transfer(RECIP)]);
  await wallet("validation reverts", "M", "REVERTER", [frame(FRAME_MODE.VERIFY, 3, null, 30_000n), transfer(RECIP)]);

  console.log("== rejected: ERC-7562 rules (banned opcodes, storage, code access)");
  for (const [i, c] of (["BAD_TIMESTAMP", "BAD_NUMBER", "BAD_COINBASE", "BAD_ORIGIN", "BAD_GASPRICE"] as ContractName[]).entries()) {
    await wallet(`banned opcode: ${c.slice(4)}`, i % 2 ? "M" : "G", c, [frame(FRAME_MODE.VERIFY, 3, null, 30_000n), transfer(RECIP)]);
  }
  await wallet("reads another contract's storage", "M", "STO", [frame(FRAME_MODE.VERIFY, 3, null, 60_000n), transfer(RECIP)]);
  await wallet("calls out with value", "G", "VALCALL", [frame(FRAME_MODE.VERIFY, 3, null, 60_000n), transfer(RECIP)]);
  await wallet("touches code of an empty address", "M", "COD", [frame(FRAME_MODE.VERIFY, 3, null, 30_000n), transfer(RECIP)]);

  console.log("\nwaiting 50 s, then reading the outcome from both nodes…");
  await sleep(50_000);
  const finals: string[] = [];
  for (const a of accepted) {
    const s = await call(M, "skandha_frameTransactionStatus", [a.hash]);
    const g = await call(G, "skandha_frameTransactionStatus", [a.hash]);
    finals.push(`${a.name.padEnd(40)} to ${a.node}  miner: ${(s.result?.status ?? s.error?.message ?? "?").toString().padEnd(10)} gateway: ${g.result?.status ?? g.error?.message ?? "?"}`);
  }
  console.log("\n" + finals.join("\n"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
