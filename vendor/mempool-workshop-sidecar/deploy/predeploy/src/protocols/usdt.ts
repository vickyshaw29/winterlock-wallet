import { parseAbi } from "viem";
import { uintWord } from "../creation";
import { equalCheck } from "../verify";
import { defineProtocol } from "./define";

const abi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function owner() view returns (address)",
  "function balanceOf(address) view returns (uint256)",
]);

// Mainnet minted 100,000 USDT at deployment (1e11 base units). The devnet gets
// 1,000,000,000 USDT (1e15 base units) so testers have plenty; the deployer
// can mint more with issue().
const INITIAL_SUPPLY = 10n ** 15n;

/** Tether USD (TetherToken, solc 0.4.18). Mainnet: 0xdAC17F958D2ee523a2206206994597C13D831ec7. */
export default defineProtocol({
  name: "usdt",
  dependsOn: [],
  steps: [
    {
      id: "token",
      kind: "create",
      tx: "0x2f1c5c2b44f771e942a8506148e256f94f1a464babc938ae0690c6e34cd79190",
      as: "USDT",
      // Constructor: (uint _initialSupply, string _name, string _symbol, uint _decimals). Word 0 is the supply.
      argWords: { 0: uintWord(INITIAL_SUPPLY) },
    },
  ],
  async verify(ctx) {
    const usdt = ctx.address("USDT");
    return [
      equalCheck("name", await ctx.read(usdt, abi, "name"), "Tether USD"),
      equalCheck("symbol", await ctx.read(usdt, abi, "symbol"), "USDT"),
      equalCheck("decimals", await ctx.read(usdt, abi, "decimals"), 6),
      equalCheck("totalSupply", await ctx.read(usdt, abi, "totalSupply"), INITIAL_SUPPLY),
      equalCheck("owner is the deployer", await ctx.read(usdt, abi, "owner"), ctx.deployer),
      equalCheck("deployer balance", await ctx.read(usdt, abi, "balanceOf", [ctx.deployer]), INITIAL_SUPPLY),
    ];
  },
});
