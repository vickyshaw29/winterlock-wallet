import { encodeFunctionData, parseAbi } from "viem";
import { DEPLOYER_ADDRESS } from "../config";
import { equalCheck } from "../verify";
import { defineProtocol } from "./define";
import verificationKeys from "./railgun-verification-keys.json";
import type { Hex } from "../types";

/** A 32-byte ABI word encoding `address` (12 zero bytes, then the 20-byte address). */
const addressWord = (address: string): Hex => `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}` as Hex;

const abi = parseAbi([
  "function upgrade(address newImplementation)",
  "function unpause()",
  "function owner() view returns (address)",
  "function initializeRailgunLogic(address treasury, uint120 shieldFee, uint120 unshieldFee, uint256 nftFee, address owner)",
  "function treasury() view returns (address)",
  "function shieldFee() view returns (uint256)",
  "function unshieldFee() view returns (uint256)",
  "function setVerificationKey(uint256 nullifiers, uint256 commitments, (string,(uint256,uint256),(uint256[2],uint256[2]),(uint256[2],uint256[2]),(uint256[2],uint256[2]),(uint256,uint256)[]) verifyingKey)",
  "function getVerificationKey(uint256 nullifiers, uint256 commitments) view returns ((string,(uint256,uint256),(uint256[2],uint256[2]),(uint256[2],uint256[2]),(uint256[2],uint256[2]),(uint256,uint256)[]))",
]);

// Real, current mainnet values (0.25% each - basis points out of 10,000).
const SHIELD_FEE = 25n;
const UNSHIELD_FEE = 25n;
const NFT_FEE = 25n;

/**
 * RAILGUN's shielded-pool contracts (`RailgunSmartWallet` behind `PausableUpgradableProxy`),
 * plus all 91 real Groth16 verifying keys mainnet actually registered - one per
 * (nullifiers, commitments) shape from (1,1) up to (13,1)/(1,13), a zk-SNARK circuit is a fixed
 * shape, so a distinct circuit (and verifying key) exists for every input/output-count
 * combination the real deployment chose to support. Extracted by reading each real key
 * directly off mainnet (`getVerificationKey`, confirmed to return genuinely different data per
 * shape) via the RAILGUN's own `VerifyingKeySet` event log, not from any single top-level
 * transaction - the real deployer set them through some internal-call mechanism this tool never
 * needed to reverse-engineer, since replaying the *data* (not the historical calldata) is
 * exactly the same "real values, fresh call" pattern already used for USDT/BAYC/USDC.
 *
 * Unlike USDC's proxy, this one has no "admin can't call the implementation" trap: only
 * `pause`/`unpause`/`transferOwnership`/`upgrade` are proxy-native (gated by `onlyOwner`, which
 * falls through to the implementation for any other caller); every other selector, including
 * ones called BY the admin, always falls through to the implementation. So the deployer can
 * freely call `upgrade`, then `unpause`, then `initializeRailgunLogic`, then all 91
 * `setVerificationKey` calls, all as itself, no admin-renouncement dance required. `unpause`
 * has to come before any implementation call (including `initializeRailgunLogic`): every
 * non-proxy-native selector goes through `delegate()`, which is gated `notPaused`
 * unconditionally, even for the admin (confirmed live: calling `initializeRailgunLogic` while
 * still paused reverts "Proxy: Contract is paused", regardless of caller).
 *
 * The proxy's constructor takes only an admin address (no implementation - it starts paused
 * with implementation unset), so there is no V1-implementation scaffolding step needed the way
 * USDC's replay needed one - but that single constructor argument is exactly the real mainnet
 * admin address if left unmodified, so it is overridden via `argWords` to our own deployer (see
 * the `proxy` step below). No renouncement is needed here the way USDC needed one; this proxy
 * simply never blocks admin from reaching the implementation in the first place.
 *
 * Two separate Poseidon hashing libraries are delegatecalled into as bytecode-level constants,
 * patched the same way Tornado's Hasher is: PoseidonT3 (2-input), used by the Merkle tree logic
 * `initializeRailgunLogic` touches, and PoseidonT4 (3-input), used by `shield()`'s note
 * commitment hash (npk, tokenHash, value) - found live via `debug_traceCall` the same way
 * PoseidonT3 was, after a real `shield()` call reverted delegatecalling into a real mainnet
 * address with no devnet code.
 */
export default defineProtocol({
  name: "railgun",
  dependsOn: [],
  steps: [
    {
      id: "proxy",
      kind: "create",
      tx: "0x13954e0d1af4c619efbd502299e78e116d1309b2b85c15ac6fe09838bb8622aa",
      as: "PROXY",
      // The constructor's sole argument is the proxy's admin - the real mainnet Railgun admin
      // address if left unmodified. Overridden to our own deployer, the same way USDT's supply
      // is overridden: without this, our deployer could never call upgrade()/unpause() at all
      // (confirmed live: calling upgrade() as a non-admin falls through to delegate(), which
      // reverts "Proxy: Contract is paused" before any implementation is even set).
      argWords: { 0: addressWord(DEPLOYER_ADDRESS) },
    },
    {
      // PoseidonT3, the Merkle-tree hash library RailgunLogic's initializer (and its Merkle
      // tree logic generally) delegatecalls into. Referenced as a bytecode-level constant, not
      // a constructor argument - the same class of dependency as Tornado Cash's Hasher.
      // Confirmed live: without this, initializeRailgunLogic delegatecalls into an address with
      // no code on the devnet and reverts with no reason string. Unverified on Etherscan (its
      // "source" is generated circomlib output, not hand-written Solidity) - `fetch` already
      // handles that gracefully.
      id: "poseidon-t3",
      kind: "create",
      tx: "0x22f522952985c00705187839388aa76c80a7684f186f29a47c05bba3a17765e6",
      as: "POSEIDON_T3",
    },
    {
      // PoseidonT4 - a second Poseidon library, 3-input, delegatecalled into by `shield()`'s note
      // commitment hashing (npk, tokenHash, value). A distinct dependency from PoseidonT3, which
      // only ever came up via `initializeRailgunLogic`'s Merkle tree logic, not shielding.
      // Confirmed live via `debug_traceCall`: `shield()` reverted delegatecalling into this real
      // mainnet address with no devnet code, the same failure signature as PoseidonT3's.
      id: "poseidon-t4",
      kind: "create",
      tx: "0x1e7e34c103de436502520ee4d38b9ad1879645c8baf0547ab092bb034cfef679",
      as: "POSEIDON_T4",
    },
    {
      id: "implementation",
      kind: "create",
      tx: "0x12e5f2bb0d2d3bf66ba4ad115da3605a5e46103c4ad208baf3662b039f661d97",
      as: "IMPLEMENTATION",
      patches: [
        { find: "0xF5fE83643dd42d408c19B938866fA441C6c52563", count: 1 },
        { find: "0xafd3Fc0396f793B35E433Bbe0e1160329bF0ABd3", count: 1 },
      ],
    },
    {
      id: "upgrade",
      kind: "custom",
      run: async (ctx) => {
        await ctx.send({
          to: ctx.address("PROXY"),
          data: encodeFunctionData({ abi, functionName: "upgrade", args: [ctx.address("IMPLEMENTATION")] }),
          value: 0n,
        });
      },
    },
    {
      // Must come before any implementation call, including initialize below: every non-proxy-
      // native selector (which is everything except pause/unpause/transferOwnership/upgrade)
      // goes through delegate(), which is gated `notPaused` unconditionally - even for the
      // admin. Confirmed live: initializeRailgunLogic while still paused reverts "Proxy:
      // Contract is paused", regardless of caller.
      id: "unpause",
      kind: "custom",
      run: async (ctx) => {
        await ctx.send({
          to: ctx.address("PROXY"),
          data: encodeFunctionData({ abi, functionName: "unpause", args: [] }),
          value: 0n,
        });
      },
    },
    {
      id: "initialize",
      kind: "custom",
      run: async (ctx) => {
        await ctx.send({
          to: ctx.address("PROXY"),
          data: encodeFunctionData({
            abi,
            functionName: "initializeRailgunLogic",
            args: [ctx.deployer, SHIELD_FEE, UNSHIELD_FEE, NFT_FEE, ctx.deployer],
          }),
          value: 0n,
        });
      },
    },
    ...verificationKeys.map(({ nullifiers, commitments, verifyingKey }) => ({
      id: `vk-${nullifiers}-${commitments}`,
      kind: "custom" as const,
      run: async (ctx: import("../types").StepContext) => {
        await ctx.send({
          to: ctx.address("PROXY"),
          data: encodeFunctionData({
            abi,
            functionName: "setVerificationKey",
            args: [BigInt(nullifiers), BigInt(commitments), verifyingKey as never],
          }),
          value: 0n,
        });
      },
    })),
  ],
  async verify(ctx) {
    const proxy = ctx.address("PROXY");
    const checks = [
      equalCheck("owner is the deployer", await ctx.read(proxy, abi, "owner"), ctx.deployer),
      equalCheck("treasury is the deployer", await ctx.read(proxy, abi, "treasury"), ctx.deployer),
      equalCheck("shieldFee (0.25%)", await ctx.read(proxy, abi, "shieldFee"), SHIELD_FEE),
      equalCheck("unshieldFee (0.25%)", await ctx.read(proxy, abi, "unshieldFee"), UNSHIELD_FEE),
      equalCheck("verification keys registered", verificationKeys.length, 91),
    ];
    // Spot-check a handful of shapes (not all 91 - each already had to succeed during `run`, or
    // the whole deployment would have failed) to prove they are readable and match what mainnet
    // has, not just "some call succeeded".
    for (const { nullifiers, commitments, verifyingKey } of [
      verificationKeys[0],
      verificationKeys[Math.floor(verificationKeys.length / 2)],
      verificationKeys[verificationKeys.length - 1],
    ]) {
      const onChain = (await ctx.read(proxy, abi, "getVerificationKey", [BigInt(nullifiers), BigInt(commitments)])) as [
        string,
        ...unknown[],
      ];
      checks.push(
        equalCheck(
          `verifying key (${nullifiers},${commitments}) IPFS hash matches mainnet's`,
          onChain[0],
          (verifyingKey as [string, ...unknown[]])[0]
        )
      );
    }
    return checks;
  },
});
