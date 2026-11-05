import { privateKeyToAccount } from "viem/accounts";
import { getStorageAt } from "../lib/chain.js";
import { loadConfig } from "../lib/config.js";
import { buildWalletTx, signFrameTx, txHash } from "../lib/frameTx/build.js";
import { NONCE_MANAGER, keyedNonceSlot } from "../lib/frameTx/predeploys.js";
import { accountNonce, explorerLink, sendFrameTx, waitForReceipt } from "../lib/frameTx/send.js";
import { rpc } from "../lib/rpc.js";
import { runStep } from "../lib/output.js";
import { ensureParticipantKey, requireState, writeState } from "../lib/state.js";

const KEY_A = 1n;
const KEY_B = 2n;

runStep("step_12_tx_keyed_nonces", async (ctx) => {
  const cfg = loadConfig();
  const wallet = requireState("wallet", "step_4_wallet_deploy");
  const ownerKey = ensureParticipantKey();
  const owner = privateKeyToAccount(ownerKey).address;

  // The next sequence number of a key lives in the NONCE_MANAGER predeploy: 0 until the key is first used.
  const seqOf = async (key: bigint) => BigInt(await getStorageAt(NONCE_MANAGER, keyedNonceSlot(wallet, key)));
  const [seqA, seqB, accountNonceBefore] = [await seqOf(KEY_A), await seqOf(KEY_B), await accountNonce(wallet)];

  const build = (nonceKey: bigint, nonceSeq: bigint) =>
    signFrameTx(
      buildWalletTx({ wallet, owner, to: cfg.recipient, value: cfg.transferWei, nonce: nonceSeq, nonceKeys: [nonceKey], chainId: cfg.chainId, maxFeePerGas: cfg.maxFeePerGasWei }),
      ownerKey
    );
  const [txA, txB] = [await build(KEY_A, seqA), await build(KEY_B, seqB)];

  ctx.log(`two txs from the same wallet ${wallet}: key ${KEY_A} (seq ${seqA}) and key ${KEY_B} (seq ${seqB}), sent back to back…`);
  const hashA = await sendFrameTx(txA);
  const hashB = await sendFrameTx(txB);
  // The first tx was still waiting for a block when the second was accepted: they were pending side by side.
  const aStillPending = (await rpc(cfg.gatewayUrl, "eth_getTransactionReceipt", [hashA])) === null;

  const [receiptA, receiptB] = [await waitForReceipt(hashA), await waitForReceipt(hashB)];
  writeState({ lastTxHash: hashB });

  const [afterA, afterB, accountNonceAfter] = [await seqOf(KEY_A), await seqOf(KEY_B), await accountNonce(wallet)];
  return {
    summary: [
      `key ${KEY_A}: ${hashA} (block ${Number(receiptA.blockNumber)})`,
      `key ${KEY_B}: ${hashB} (block ${Number(receiptB.blockNumber)})`,
      aStillPending ? "the first tx was still pending when the second was accepted: both sat in the mempool together" : "the first tx was mined before the second was accepted (the devnet was quick), so they did not overlap this time",
      `NONCE_MANAGER next seq: key ${KEY_A} ${seqA} -> ${afterA}, key ${KEY_B} ${seqB} -> ${afterB}`,
      `the wallet's ordinary account nonce: ${accountNonceBefore} -> ${accountNonceAfter} (keyed txs do not touch it)`,
      `explorer: ${explorerLink(hashB)}`,
      "next: yarn step_13_tx_recent_roots",
    ].join("\n"),
    ok: afterA === seqA + 1n && afterB === seqB + 1n && accountNonceAfter === accountNonceBefore,
    hint: "the keys did not advance as expected: run `yarn step_11_debug " + hashB + "`",
    data: {
      wallet, keys: [KEY_A.toString(), KEY_B.toString()], txHashes: [hashA, hashB], blocks: [Number(receiptA.blockNumber), Number(receiptB.blockNumber)],
      overlappedInMempool: aStillPending, seqBefore: [seqA.toString(), seqB.toString()], seqAfter: [afterA.toString(), afterB.toString()],
      accountNonceBefore: accountNonceBefore.toString(), accountNonceAfter: accountNonceAfter.toString(),
    },
  };
});
