import { parseAbi } from "viem";
import { equalCheck } from "../verify";
import { defineProtocol } from "./define";

const abi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);

const TOTAL_SUPPLY = 10n ** 27n; // 1 billion LINK, all minted to the deployer by the constructor

/** Chainlink's LINK (ERC-677) token. Mainnet: 0x514910771AF9Ca656af840dff83E8264EcF986CA. */
export default defineProtocol({
  name: "link",
  dependsOn: [],
  steps: [
    {
      id: "token",
      kind: "create",
      tx: "0x5488510df045770efbff57f25d0c6d2c1404d58c1199b21eb8dc5072b22d91d7",
      as: "LINK",
    },
  ],
  async verify(ctx) {
    const link = ctx.address("LINK");
    return [
      equalCheck("name", await ctx.read(link, abi, "name"), "ChainLink Token"),
      equalCheck("symbol", await ctx.read(link, abi, "symbol"), "LINK"),
      equalCheck("decimals", await ctx.read(link, abi, "decimals"), 18),
      equalCheck("totalSupply", await ctx.read(link, abi, "totalSupply"), TOTAL_SUPPLY),
      equalCheck("deployer balance", await ctx.read(link, abi, "balanceOf", [ctx.deployer]), TOTAL_SUPPLY),
    ];
  },
});
