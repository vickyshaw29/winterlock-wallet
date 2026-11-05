/** What each step prints before it runs (text mode only; `--json` stays one object). Plain prose for workshop participants. */
export interface Explanation {
  title: string;
  /** What is going on, in a few sentences. */
  story: string;
  /** The parts of the system this step touches. */
  components: string;
  /** What to look at in the output. */
  watch: string;
  /** Why this is worth knowing. */
  why: string;
}

export const EXPLANATIONS: Record<string, Explanation> = {
  step_1_check: {
    title: "Step 1: is the devnet there, and do I have money?",
    story:
      "Every request in this workshop goes to one HTTP endpoint, the gateway. This step checks that it answers on chain 1337, creates a throwaway key for you in .workshop-state.json, and asks the devnet's faucet to send it test ETH. It also resets the workshop: addresses and finished steps from earlier runs are forgotten.",
    components:
      "The gateway is a sidecar node (a mempool node that validates frame transactions and gossips them to the block builder). It forwards chain reads to ethrex, the execution client. The explorer is a web page and API on the same node.",
    watch:
      "Your address and balance, and the warning if the explorer API is off (steps 7 to 11 need it). If the faucet refuses, it allows each address once an hour.",
    why: "Everything later depends on this one endpoint. If it is down or the devnet was replaced, every step fails the same way, and this is where you find out.",
  },
  step_2_tx_first: {
    title: "Step 2: your first frame transaction",
    story:
      "An EIP-8141 frame transaction is a list of frames instead of one call. Here it has two: a VERIFY frame that proves who is sending and agrees to pay, and a SENDER frame that makes the transfer. Your key signs once; the protocol checks the signature during the VERIFY frame.",
    components:
      "buildSelfRelayTx (src/lib/frameTx) builds the two frames, the hegota-support package encodes and signs them, and the sidecar's eth_sendFrameTransaction takes the JSON form. ethrex mines it.",
    watch:
      "'frames: 2 (all succeeded)' in the output: each frame has its own receipt. The tx goes to the standard alt-mempool first, and the sidecar hands it on to the block builder.",
    why: "No account abstraction contract was needed. Verification and payment are separate from execution, and that split is what the rest of the workshop plays with.",
  },
  step_3_tx_paymaster: {
    title: "Step 3: someone else pays the gas",
    story:
      "A brand-new key with no ETH sends a transaction. It has three frames: the sender approves execution, a paymaster contract approves payment, and then the transfer runs. The paymaster is deployed now, funded with 0.01 ETH through its creation value.",
    components:
      "SponsorPaymaster.sol inherits HegotaSupport, which gives Solidity the frame opcodes (here approve(Scope.PAYMENT)). The VERIFY frame that targets the paymaster runs its fallback function.",
    watch:
      "The sender balance stays 0 and the paymaster balance drops by the gas. The paymaster does not check its own balance on purpose: BALANCE is a banned opcode in validation for an unstaked contract.",
    why: "Sponsored transactions are a protocol feature here, not an ERC-4337 bundle. The banned-opcode rule is the first sign that validation code is restricted so mempools can check it cheaply.",
  },
  step_4_wallet_deploy: {
    title: "Step 4: a wallet that is a smart contract",
    story:
      "You deploy ExampleWallet with yourself as owner and 0.01 ETH of creation value. The wallet has no signature-checking code. The protocol already verified your signature; the wallet only asks which signer was verified and approves if that is its owner.",
    components:
      "ExampleWallet.sol, HegotaSupport's sigparam (reads the verified signer) and approve (grants execution and payment). Deployment is an ordinary transaction and needs about 6M gas on this devnet.",
    watch:
      "The wallet address in the output. Its first nonce is 8, not 1: HegotaSupport creates seven helper contracts when the wallet is created.",
    why: "It shows how little a validating account needs. Fund contracts only through creation value; a plain transfer would run the validation code outside a frame and fail.",
  },
  step_5_tx_wallet: {
    title: "Step 5: the wallet validates and pays",
    story:
      "The same kind of transfer as step 2, but the sender is now your wallet contract. Its VERIFY frame runs the wallet's code, the wallet approves, and the wallet pays the gas from its own balance. You signed with the owner key, not the wallet's address.",
    components:
      "buildWalletTx sets a signature entry whose signer is the owner. ExampleWallet's fallback checks it with sigparam and calls approve.",
    watch: "The wallet balance falls by the transfer and the gas. The EOA key paid nothing.",
    why: "This is the account-abstraction promise delivered by the protocol: any contract that can approve can be a sender. The next steps make this wallet misbehave.",
  },
  step_6_tx_violating_canonical: {
    title: "Step 6: a rule-breaking transaction is refused",
    story:
      "ViolatingWallet looks like ExampleWallet, but when the VERIFY frame carries data it reads another contract's storage during validation. You send that transaction to the canonical mempool (ethrex's own rules). It is refused. While the wallet is unstaked, the standard alt-mempool refuses it too, and you see both messages.",
    components:
      "ViolatingWallet.sol and Foreign.sol (the contract it reads). Canonical: eth_sendRawTransaction, forwarded by the gateway to ethrex. Standard alt-mempool: the sidecar, using ERC-7562-style rules.",
    watch:
      "Exit code 0 means the rejection happened. ethrex says StorageReadNonSender; the sidecar says 'unstaked payer accessed ... slot'. They name the same rule (STO) in different words.",
    why: "Mempools only accept transactions whose validation they can cheaply predict. Reading someone else's storage lets a third party invalidate your transaction after it was accepted, which is a denial-of-service route.",
  },
  step_7_stake: {
    title: "Step 7: put money behind the wallet",
    story:
      "Staking makes an entity accountable, so the standard alt-mempool trusts it with more. The wallet stakes itself: a SENDER frame calls the staking registry's addStake with 0.012 ETH. In a self-relay transaction the SENDER frame acts as the wallet, so no special staking code is needed.",
    components:
      "The NaiveStakingRegistry predeploy, buildStakeTx, and the explorer's isStaked flag. The wallet's VERIFY data is empty here, so the transaction is clean and admissible while the wallet is still unstaked.",
    watch: "The registry shows 0.012 ETH and an unstake delay. The minimum stake on this devnet is 0.01 ETH.",
    why: "Stake is the collateral behind relaxed rules. It can be lost in a real deployment, and reputation (steps 9 and 10) is how a node decides to stop trusting a staked entity.",
  },
  step_8_tx_violating_alt: {
    title: "Step 8: the same transaction, now accepted",
    story:
      "You send the same transaction as step 6 (same frames, same wallet) to the standard alt-mempool. Only the nonce differs, because the stake transaction in step 7 used one. The wallet is staked now, so the storage read is allowed. The sidecar admits it, the block builder includes it, and it is mined.",
    components:
      "The sidecar's rule engine (the 'staked entity' branch) and the block builder, which runs the same sidecar. ethrex would still refuse this transaction on its public mempool.",
    watch:
      "A mined receipt for a transaction that step 6 could not get accepted. Run step_11_debug on it to see which checks passed and which were relaxed because of the stake.",
    why: "One transaction, two verdicts. Which mempool you target decides whether your validation logic is allowed, and a transaction admitted only by the alt-mempool reaches only the nodes and builders that run it.",
  },
  step_9_reputation_burn: {
    title: "Step 9: getting banned (a declared shortcut)",
    story:
      "Reputation counts how many of an entity's transactions a node saw versus how many were included. An entity that keeps getting transactions admitted but never included is throttled, then banned. Reaching that honestly is slow and unreliable on this devnet, so this step writes the counters directly for your own wallet.",
    components:
      "The devnet's open debug_bundler_setReputation method and the explorer's reputation list. Real nodes do not expose this method.",
    watch:
      "Status BANNED with opsSeen 10000 and opsIncluded 0. The step prints a cheat notice on purpose. 'yarn reset_reputation' undoes it.",
    why: "Staking buys freedom and reputation takes it back. Without a ban rule, a staked entity could flood the pool with transactions it knows will be invalidated.",
  },
  step_10_tx_violating_alt_banned: {
    title: "Step 10: staked, but banned",
    story:
      "The wallet is still staked and the transaction is still the one from step 8, but the wallet's reputation is BANNED. The sidecar refuses the transaction. The error text looks like the unstaked error from step 6, so the step also reads the explorer to show the real cause.",
    components: "The sidecar's reputation service and the explorer's reputation list (getReputation).",
    watch:
      "Compare the error message with the reputation line: the message is generic, the status is not. A THROTTLED entity would still be admitted, only capped at 4 mempool entries.",
    why: "A rejection message can hide its real cause. When a transaction is refused, check the node's view of your entity, not just the text.",
  },
  step_12_tx_keyed_nonces: {
    title: "Step 12 (bonus): two transactions from one wallet, side by side",
    story:
      "Normally a sender has one nonce, so its transactions queue up in order. EIP-8250 lets a transaction name a nonce key instead. Each key has its own counter, so transactions on different keys do not wait for each other. This step sends two transactions from your wallet back to back, one on key 1 and one on key 2, both with sequence number 0.",
    components:
      "The NONCE_MANAGER predeploy at 0x...8250 stores each (sender, key) counter. The nonce_keys field in the transaction envelope selects the key, and the usual wallet VERIFY frame approves. The node's mempool only lets a sender have several transactions pending when its validation reads none of its own storage, which ExampleWallet does not.",
    watch:
      "Both transactions pending at the same time, and often mined in the same block. The NONCE_MANAGER counters move from 0 to 1, while the wallet's ordinary account nonce does not move at all.",
    why: "Parallel transactions from one smart account, with no ordering between them. The ordinary nonce domain (key 0) stays separate, which is why a pending keyed transaction and a pending ordinary one from the same sender are never mixed.",
  },
  step_13_tx_recent_roots: {
    title: "Step 13 (bonus): declaring a recent root",
    story:
      "EIP-8272 lets a transaction cite a recent commitment (a root) in its signed envelope, so validation code could rely on it without reading someone else's mutable storage. This step only demonstrates the mechanism. It commits a root, waits one slot, sends a transaction that declares it, and then sends one that declares a root nobody committed.",
    components:
      "The RECENT_ROOT_ADDRESS predeploy at 0x...8272: calling it with salt and root (64 bytes) stores an entry for the current slot under a source id built from your address and the salt. The recent_root_references field in the envelope carries (source id, slot, root). The block header's slotNumber says which slot you are in.",
    watch:
      "'predeploy entry matches the expected hash: yes' (we recomputed the stored value), the first transaction mined, and the second rejected before any frame runs because its root is not committed.",
    why: "It shows a root being a fact the chain itself verifies: the reference has to exist and be between 1 and 8191 slots old. Nothing in this wallet reads the root, so no validation logic depends on it here. The predeploy's code is still a draft (ethereum/EIPs PR #12131).",
  },
  step_11_debug: {
    title: "Step 11: why was my transaction (not) accepted?",
    story:
      "Give it a transaction hash. It asks the sidecar for the admission report (every rule that was checked and how it came out), the lifecycle events, the mempool status, and asks ethrex for the receipt. Rejected transactions get no hash back from a node, so steps 6, 8 and 10 compute and print it themselves.",
    components:
      "The explorer API (admission and lifecycle history, kept in memory and cleared on restart), skandha_frameTransactionStatus, and eth_getTransactionReceipt.",
    watch:
      "Lines starting with FAIL name the rule and the entity at fault. 'no record on this node' means the node never saw it, for example when only ethrex rejected it.",
    why: "This is the habit to keep after the workshop: read the rule-by-rule report instead of guessing from one error string.",
  },
};

function wrap(text: string, width: number, indent: string): string {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line && indent.length + line.length + 1 + word.length > width) {
      lines.push(indent + line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(indent + line);
  return lines.join("\n");
}

/** The text printed before a step runs, or undefined when the step has no explanation. */
export function renderExplanation(step: string, width = 92): string | undefined {
  const e = EXPLANATIONS[step];
  if (!e) return undefined;
  const section = (label: string, body: string) => `${label}\n${wrap(body, width, "  ")}`;
  return [
    `== ${e.title} ==`,
    section("What is going on:", e.story),
    section("Components:", e.components),
    section("Watch for:", e.watch),
    section("Why it matters:", e.why),
    "",
  ].join("\n");
}
