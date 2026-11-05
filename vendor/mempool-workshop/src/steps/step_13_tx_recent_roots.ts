import { concat, keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { getBlock, getStorageAt, sendLegacy, waitMined } from "../lib/chain.js";
import { loadConfig } from "../lib/config.js";
import { buildWalletTx, signFrameTx, txHash } from "../lib/frameTx/build.js";
import { RECENT_ROOT_ADDRESS, recentRootEntryHash, recentRootSourceId, recentRootStorageKey } from "../lib/frameTx/predeploys.js";
import { accountNonce, explainRejection, explorerLink, sendFrameTx, waitForReceipt } from "../lib/frameTx/send.js";
import { StepError, runStep } from "../lib/output.js";
import { ensureParticipantKey, requireState, writeState } from "../lib/state.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Any 32-byte value will do: this step only shows how a root is committed and declared, nothing reads it.
const SALT: Hex = keccak256(toHex("mempool-workshop"));
const ROOT: Hex = keccak256(toHex("a root worth referencing"));
const NEVER_WRITTEN: Hex = keccak256(toHex("a root nobody committed"));

runStep("step_13_tx_recent_roots", async (ctx) => {
  const cfg = loadConfig();
  const wallet = requireState("wallet", "step_4_wallet_deploy");
  const ownerKey = ensureParticipantKey();
  const owner = privateKeyToAccount(ownerKey).address;
  const sourceId = recentRootSourceId(owner, SALT);

  // 1. Commit a root: call the predeploy with exactly salt || root. The caller and the salt name the source.
  ctx.log(`committing a root to ${RECENT_ROOT_ADDRESS} from ${owner} (a plain transaction, about 127k gas)…`);
  const writeHash = await sendLegacy(ownerKey, { to: RECENT_ROOT_ADDRESS, data: concat([SALT, ROOT]), gas: 300_000n });
  const written = await waitMined(writeHash);
  if (written.status !== "0x1") throw new StepError("TX_REVERTED", `the write ${writeHash} reverted`, { hint: "yarn step_11_debug " + writeHash });
  const slot = BigInt((await getBlock(written.blockNumber)).slotNumber);
  const ref = { sourceId, slot, root: ROOT };

  const stored = await getStorageAt(RECENT_ROOT_ADDRESS, recentRootStorageKey(ref));
  const matches = stored.toLowerCase() === recentRootEntryHash(ref).toLowerCase();

  // 2. A reference must be at least one slot old, so wait for the chain to move on.
  ctx.log(`root committed in slot ${slot}; waiting for a later slot…`);
  const deadline = Date.now() + cfg.txTimeoutSec * 1000;
  while (BigInt((await getBlock("latest")).slotNumber) <= slot) {
    if (Date.now() > deadline) throw new StepError("TX_NOT_MINED", "no later slot appeared", { hint: "the devnet may be stalled; check the explorer" });
    await sleep(2000);
  }

  const send = async (references: (typeof ref)[]) => {
    const tx = await signFrameTx(
      buildWalletTx({ wallet, owner, to: cfg.recipient, value: cfg.transferWei, nonce: await accountNonce(wallet), recentRootReferences: references, chainId: cfg.chainId, maxFeePerGas: cfg.maxFeePerGasWei }),
      ownerKey
    );
    return { tx, hash: await sendFrameTx(tx) };
  };

  // 3. Declare the committed root in the signed envelope. The chain checks it exists and is recent.
  ctx.log("sending a tx that declares the committed root…");
  const good = await send([ref]);
  const goodReceipt = await waitForReceipt(good.hash);
  writeState({ lastTxHash: good.hash });

  // 4. Declare a root nobody committed. The chain refuses it before any frame runs.
  ctx.log("sending a tx that declares a root nobody committed…");
  const bad = { ...ref, root: NEVER_WRITTEN };
  let rejection: ReturnType<typeof explainRejection> | undefined;
  let badHash: Hex | undefined;
  try {
    badHash = (await send([bad])).hash;
  } catch (e) {
    if (!(e instanceof StepError) || !e.code.startsWith("RPC_")) throw e;
    rejection = explainRejection(e.message);
  }

  return {
    ok: matches && rejection !== undefined,
    summary: [
      `root committed: ${writeHash} (slot ${slot}); source ${sourceId}`,
      `predeploy entry matches the expected hash: ${matches ? "yes" : "NO"}`,
      `tx declaring it: ${good.hash} (block ${Number(goodReceipt.blockNumber)}), mined`,
      rejection ? `tx declaring an uncommitted root: rejected: ${rejection.message}` : `tx declaring an uncommitted root was ACCEPTED: ${badHash}`,
      `explorer: ${explorerLink(good.hash)}`,
      "note: nothing in the wallet's validation reads the root. This step only shows how roots are committed and declared.",
    ].join("\n"),
    hint: !matches
      ? "the predeploy entry does not match the expected hash: the layout may differ on this devnet; see `yarn step_11_debug " + good.hash + "`"
      : "the node accepted a reference to a root nobody committed",
    data: { sourceId, slot: slot.toString(), root: ROOT, writeTx: writeHash, referenceTx: good.hash, entryMatches: matches, uncommittedRejected: !!rejection, rejection: rejection ?? null, uncommittedTx: badHash ?? null },
  };
});
