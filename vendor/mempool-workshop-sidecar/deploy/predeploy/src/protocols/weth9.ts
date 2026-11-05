import { parseAbi } from "viem";
import { equalCheck } from "../verify";
import { defineProtocol } from "./define";

const abi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
]);

/** Canonical WETH9. Mainnet: 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2. A plain, dependency-free
 *  creation - a dependency for Uniswap v4 and anything else that expects WETH at a fixed name. */
export default defineProtocol({
  name: "weth9",
  dependsOn: [],
  steps: [
    {
      id: "token",
      kind: "create",
      tx: "0xb95343413e459a0f97461812111254163ae53467855c0d73e0f1e7c5b8442fa3",
      as: "WETH9",
    },
  ],
  async verify(ctx) {
    const weth = ctx.address("WETH9");
    return [
      equalCheck("name", await ctx.read(weth, abi, "name"), "Wrapped Ether"),
      equalCheck("symbol", await ctx.read(weth, abi, "symbol"), "WETH"),
      equalCheck("decimals", await ctx.read(weth, abi, "decimals"), 18),
      // No premint on real WETH9 - supply comes only from deposit(). Unlike LINK/USDT, no
      // "deployer holds a starting balance" step: wrap real devnet ETH with deposit() instead.
      equalCheck("totalSupply (no premint)", await ctx.read(weth, abi, "totalSupply"), 0n),
    ];
  },
});
