import { encodeFunctionData, parseAbi } from "viem";
import { equalCheck } from "../verify";
import { defineProtocol } from "./define";

const abi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function MAX_APES() view returns (uint256)",
  "function apePrice() view returns (uint256)",
  "function owner() view returns (address)",
  "function saleIsActive() view returns (bool)",
  "function flipSaleState()",
]);

/** Bored Ape Yacht Club (solc 0.7.0). Mainnet: 0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D. */
export default defineProtocol({
  name: "bayc",
  dependsOn: [],
  steps: [
    {
      id: "collection",
      kind: "create",
      tx: "0x22199329b0aa1aa68902a78e3b32ca327c872fab166c7a2838273de6ad383eba",
      as: "BAYC",
    },
    {
      // The mainnet contract deploys with the sale closed. Open it so testers can call mintApe().
      // Reads first, so a re-run never flips the sale shut again.
      id: "open-sale",
      kind: "custom",
      run: async (ctx) => {
        const bayc = ctx.address("BAYC");
        if ((await ctx.read(bayc, abi, "saleIsActive")) === true) return;
        await ctx.send({ to: bayc, data: encodeFunctionData({ abi, functionName: "flipSaleState" }), value: 0n });
      },
    },
  ],
  async verify(ctx) {
    const bayc = ctx.address("BAYC");
    return [
      equalCheck("name", await ctx.read(bayc, abi, "name"), "BoredApeYachtClub"),
      equalCheck("symbol", await ctx.read(bayc, abi, "symbol"), "BAYC"),
      equalCheck("MAX_APES", await ctx.read(bayc, abi, "MAX_APES"), 10_000),
      equalCheck("apePrice (0.08 ETH)", await ctx.read(bayc, abi, "apePrice"), 80_000_000_000_000_000n),
      equalCheck("owner is the deployer", await ctx.read(bayc, abi, "owner"), ctx.deployer),
      equalCheck("sale is open", await ctx.read(bayc, abi, "saleIsActive"), true),
    ];
  },
});
