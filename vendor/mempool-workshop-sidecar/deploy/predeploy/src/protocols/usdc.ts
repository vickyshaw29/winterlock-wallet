import { encodeFunctionData, parseAbi } from "viem";
import { equalCheck } from "../verify";
import { defineProtocol } from "./define";

const abi = parseAbi([
  // Proxy (AdminUpgradeabilityProxy) surface - only reachable by its admin, our deployer, until
  // we renounce that role (see the class doc comment).
  "function upgradeTo(address newImplementation)",
  "function changeAdmin(address newAdmin)",
  // FiatToken (delegated) surface.
  "function initialize(string tokenName, string tokenSymbol, string tokenCurrency, uint8 tokenDecimals, address newMasterMinter, address newPauser, address newBlacklister, address newOwner)",
  "function initializeV2(string newName)",
  "function initializeV2_1(address lostAndFound)",
  "function initializeV2_2(address[] accountsToBlacklist, string newSymbol)",
  "function configureMinter(address minter, uint256 minterAllowedAmount) returns (bool)",
  "function mint(address to, uint256 amount) returns (bool)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function currency() view returns (string)",
  "function decimals() view returns (uint8)",
  "function masterMinter() view returns (address)",
  "function pauser() view returns (address)",
  "function blacklister() view returns (address)",
  "function owner() view returns (address)",
  "function version() pure returns (string)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);

const MINT_AMOUNT = 10n ** 9n * 10n ** 6n; // 1,000,000,000 USDC, 6 decimals
// A well-known "nobody controls this" address, not the zero address (changeAdmin rejects that).
const BURN_ADDRESS = "0x000000000000000000000000000000000000dEaD";

const call = (functionName: string, args: readonly unknown[]) => ({
  data: encodeFunctionData({ abi, functionName, args } as never),
  value: 0n,
});

/**
 * USDC, the full current version (FiatTokenV2_2 - permit/EIP-3009 support included), deployed
 * the way mainnet's own upgrade history actually happened: deploy the original 2018 proxy and
 * implementation, then genuinely upgrade to the current implementation and run its real
 * initializer chain - with our own deployer standing in for Circle's roles throughout
 * (masterMinter/pauser/blacklister/owner), the same pattern already used for USDT.
 *
 * `implementation-v1`'s only job is letting the proxy's real constructor argument (the mainnet
 * V1 implementation address) resolve through the ordinary word-level rewrite; it is immediately
 * superseded by `upgrade` and never touched again. `upgrade` and the initializer calls need no
 * new step kind - `ctx.address()` already resolves an earlier step's devnet address at runtime,
 * the same mechanism BAYC's `open-sale` step uses. No read-first guards: the real contracts
 * enforce one-time initialization internally (a second call reverts), and the engine's own step
 * journal means a completed step never runs twice anyway.
 *
 * `renounce-admin` exists because of a real transparent-proxy trap: this proxy's admin (our
 * deployer, having created it) can call the proxy's own functions (`upgradeTo`, `changeAdmin`,
 * `implementation`, `admin`) but CANNOT call anything on the implementation through it - a real,
 * confirmed devnet error: "Cannot call fallback function from the proxy admin." So after
 * upgrading, the deployer gives up admin to a burn address it never needs to control again,
 * before calling `initialize` or anything else. This has a second consequence: `implementation`/
 * `admin` can no longer be READ correctly by anyone either (a read from any non-admin caller,
 * including an unspecified default caller, hits the exact same fallback split) - so `verify`
 * checks `version()` (a plain, caller-independent function only V2+ exposes) instead of the
 * implementation address directly; a successful `initializeV2_2` call during deployment is
 * already strong evidence the upgrade landed, since it is a V2.2-only function.
 *
 * Mainnet: proxy `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`, V1 implementation
 * `0x0882477e7895bdc5cea7cb1552ed914ab157fe56`, current (V2_2) implementation
 * `0x43506849D7C04F9138D1A2050bbF3A0c054402dd`.
 */
export default defineProtocol({
  name: "usdc",
  dependsOn: [],
  steps: [
    {
      id: "implementation-v1",
      kind: "create",
      tx: "0xa40b41d5a00b8b1a1d591dc60882521942f5b98b277bb3e8ba6e0edda0a2e550",
      as: "IMPLEMENTATION_V1",
    },
    {
      id: "proxy",
      kind: "create",
      tx: "0xe7e0fe390354509cd08c9a0168536938600ddc552b3f7cb96030ebef62e75895",
      as: "PROXY",
    },
    {
      id: "implementation",
      kind: "create",
      tx: "0x8240d79c3cbdc9347c602def2a433e006ddd5cbd065963a8f67050bb8d8102e2",
      as: "IMPLEMENTATION",
    },
    {
      id: "upgrade",
      kind: "custom",
      run: async (ctx) => {
        await ctx.send({ to: ctx.address("PROXY"), ...call("upgradeTo", [ctx.address("IMPLEMENTATION")]) });
      },
    },
    {
      id: "renounce-admin",
      kind: "custom",
      run: async (ctx) => {
        await ctx.send({ to: ctx.address("PROXY"), ...call("changeAdmin", [BURN_ADDRESS]) });
      },
    },
    {
      id: "initialize",
      kind: "custom",
      run: async (ctx) => {
        const d = ctx.deployer;
        await ctx.send({
          to: ctx.address("PROXY"),
          ...call("initialize", ["USD Coin", "USDC", "USD", 6, d, d, d, d]),
        });
      },
    },
    {
      id: "initialize-v2",
      kind: "custom",
      run: async (ctx) => {
        await ctx.send({ to: ctx.address("PROXY"), ...call("initializeV2", ["USD Coin"]) });
      },
    },
    {
      // The real, historical one-time V2.1 migration parameter (recovers tokens that were
      // stranded at the zero address before this fix shipped). Functionally irrelevant on a
      // fresh chain with no such tokens; the deployer is a harmless placeholder.
      id: "initialize-v2-1",
      kind: "custom",
      run: async (ctx) => {
        await ctx.send({ to: ctx.address("PROXY"), ...call("initializeV2_1", [ctx.deployer]) });
      },
    },
    {
      // Real args, empty blacklist: no need to replicate mainnet's OFAC-sanctioned address list
      // on a demonstration devnet.
      id: "initialize-v2-2",
      kind: "custom",
      run: async (ctx) => {
        await ctx.send({ to: ctx.address("PROXY"), ...call("initializeV2_2", [[], "USDC"]) });
      },
    },
    {
      id: "configure-minter",
      kind: "custom",
      run: async (ctx) => {
        await ctx.send({
          to: ctx.address("PROXY"),
          ...call("configureMinter", [ctx.deployer, 2n ** 256n - 1n]),
        });
      },
    },
    {
      id: "mint",
      kind: "custom",
      run: async (ctx) => {
        await ctx.send({ to: ctx.address("PROXY"), ...call("mint", [ctx.deployer, MINT_AMOUNT]) });
      },
    },
  ],
  async verify(ctx) {
    const proxy = ctx.address("PROXY");
    return [
      equalCheck("name", await ctx.read(proxy, abi, "name"), "USD Coin"),
      equalCheck("symbol", await ctx.read(proxy, abi, "symbol"), "USDC"),
      equalCheck("currency", await ctx.read(proxy, abi, "currency"), "USD"),
      equalCheck("decimals", await ctx.read(proxy, abi, "decimals"), 6),
      equalCheck("masterMinter is the deployer", await ctx.read(proxy, abi, "masterMinter"), ctx.deployer),
      equalCheck("pauser is the deployer", await ctx.read(proxy, abi, "pauser"), ctx.deployer),
      equalCheck("blacklister is the deployer", await ctx.read(proxy, abi, "blacklister"), ctx.deployer),
      equalCheck("owner is the deployer", await ctx.read(proxy, abi, "owner"), ctx.deployer),
      // Not "implementation is the devnet V2.2 deploy" - implementation()/admin() can no longer
      // be read correctly by anyone after renouncing admin (see the class doc comment).
      // version() is V2+-only and callable by anyone, so it is positive evidence in its place.
      equalCheck("version (proves V2+ code is running)", await ctx.read(proxy, abi, "version"), "2"),
      equalCheck("totalSupply", await ctx.read(proxy, abi, "totalSupply"), MINT_AMOUNT),
      equalCheck("deployer balance", await ctx.read(proxy, abi, "balanceOf", [ctx.deployer]), MINT_AMOUNT),
    ];
  },
});
