import { parseAbi } from "viem";
import { equalCheck } from "../verify";
import { defineProtocol } from "./define";

const abi = parseAbi([
  "function denomination() view returns (uint256)",
  "function levels() view returns (uint32)",
  "function verifier() view returns (address)",
  "function hashLeftRight(bytes32,bytes32) pure returns (bytes32)",
]);

const ZERO_WORD = `0x${"0".repeat(64)}` as const;
const HASHER_MAINNET = "0x83584f83F26aF4EDDA9cBe8C730BC87C364b28fe";

/**
 * Tornado Cash Classic, the 0.1 ETH pool, replayed exactly as it was originally deployed
 * (December 2019) - not as it exists on mainnet today. Mainnet later swapped this pool's
 * verifier via `updateVerifier()` (an admin call, 8 months after launch) and renounced the
 * operator role. Replicating that current state would need either the `call` step kind
 * (deferred to USDC) or a second `patch`-style substitution; replaying the genesis deployment
 * needs neither. Deposits and withdrawals work identically either way - the admin-only
 * `updateVerifier`/`changeOperator` functions are the only difference, and we don't control that
 * key (the real historical Tornado deployer's address) in either version.
 *
 * Mainnet addresses: Hasher `0x83584f83F26aF4EDDA9cBe8C730BC87C364b28fe`, original Verifier
 * `0x0db297c70758F31A63235eDFdeD040A04Ad3fd6c`, pool (TornadoCash_Eth_01)
 * `0x12D66f87A04A9E220743712cE6d9bB1B5616B8Fc`.
 */
export default defineProtocol({
  name: "tornado",
  dependsOn: [],
  steps: [
    {
      id: "hasher",
      kind: "create",
      tx: "0x9d8e2c2e06baeae6fd9ea5b7080466f25f0b9ea3f1c45a05fac21c3f99e6bc4a",
      as: "HASHER",
    },
    {
      id: "verifier",
      kind: "create",
      tx: "0x73870f0f3299f85531fc241a14d3d1d4e7b4cb52e44656f9fd3c2aad33d80d94",
      as: "VERIFIER",
    },
    {
      id: "pool",
      kind: "create",
      tx: "0xeed4367a9b4c066b9fbf0a44869f36b93d2f06e5a63a9464ddfd0597a8a45935",
      as: "POOL",
      // The pool's constructor takes the verifier as an ABI argument - handled by the ordinary
      // word-level rewrite, no override needed. The Hasher, by contrast, is referenced as a
      // bytecode-level constant (pre-`immutable` Solidity), not a constructor argument, hence
      // the explicit patch. Count confirmed by an exact byte search of the real mainnet creation
      // bytecode: the literal appears 4 times (once in the constructor's own logic, three times
      // in the deployed runtime code for deposit/withdraw/hashLeftRight).
      patches: [{ find: HASHER_MAINNET, count: 4 }],
    },
  ],
  async verify(ctx) {
    const pool = ctx.address("POOL");
    const checks = [
      equalCheck("denomination (0.1 ETH)", await ctx.read(pool, abi, "denomination"), 100_000_000_000_000_000n),
      equalCheck("levels", await ctx.read(pool, abi, "levels"), 20),
      equalCheck("verifier is the devnet deploy", await ctx.read(pool, abi, "verifier"), ctx.address("VERIFIER")),
    ];
    // A read-only sanity call, not just a getter: proves the deployed Hasher was really wired
    // in (the pool's constructor already exercised this once, while building the zero tree; a
    // wrong patch would have failed the deploy itself, but this also catches a devnet Hasher
    // whose code was somehow removed or replaced after the fact).
    try {
      await ctx.read(pool, abi, "hashLeftRight", [ZERO_WORD, ZERO_WORD]);
      checks.push({ name: "hashLeftRight reaches the deployed Hasher", ok: true, detail: "no revert" });
    } catch (error) {
      checks.push({
        name: "hashLeftRight reaches the deployed Hasher",
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    return checks;
  },
});
