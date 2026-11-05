import { concatHex, getContractAddress, parseAbi } from "viem";
import { equalCheck } from "../verify";
import { defineProtocol } from "./define";
import { PERMIT2_INIT_CODE, PERMIT2_SALT } from "./permit2-deployment";
import type { Address } from "../types";

const ARACHNID_PROXY: Address = "0x4e59b44847b379578588920cA78FbF26c0B4956C";
const MAINNET_PERMIT2: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

const abi = parseAbi(["function DOMAIN_SEPARATOR() view returns (bytes32)"]);

/**
 * Uniswap's Permit2, deployed by replaying its real mainnet call to Arachnid's deterministic
 * deployment proxy (see `permit2-deployment.ts`). Because that proxy is already at the same
 * address on this devnet (part of genesis) and CREATE2's outcome depends only on the factory
 * address, salt, and init code - all three identical to mainnet's - this lands Permit2 at its
 * *real mainnet address*, not a devnet-only one. Confirmed: `getContractAddress` with this real
 * salt/init code reproduces `0x000000000022D473030F116dDEE9F6B43aC78BA3` exactly.
 *
 * The receipt for a call like this never carries a `contractAddress` (that field is only ever
 * populated for the outermost creation, never one triggered internally via CREATE2), so the
 * address is computed independently and registered with `ctx.record` - the mechanism this
 * needed to be added for.
 */
export default defineProtocol({
  name: "permit2",
  dependsOn: [],
  steps: [
    {
      id: "deploy",
      kind: "custom",
      run: async (ctx) => {
        await ctx.send({ to: ARACHNID_PROXY, data: concatHex([PERMIT2_SALT, PERMIT2_INIT_CODE]), value: 0n });
        const address = getContractAddress({
          from: ARACHNID_PROXY,
          opcode: "CREATE2",
          salt: PERMIT2_SALT,
          bytecode: PERMIT2_INIT_CODE,
        });
        ctx.record("PERMIT2", address, MAINNET_PERMIT2);
      },
    },
  ],
  async verify(ctx) {
    const permit2 = ctx.address("PERMIT2");
    return [
      equalCheck("address matches Permit2's real mainnet address", permit2, MAINNET_PERMIT2),
      // A real, meaningful read (not just "has code"): proves the deployed bytecode is really
      // Permit2 and is functioning, not just something that happened to land at this address.
      equalCheck(
        "DOMAIN_SEPARATOR is non-zero",
        (await ctx.read(permit2, abi, "DOMAIN_SEPARATOR")) !== `0x${"0".repeat(64)}`,
        true
      ),
    ];
  },
});
