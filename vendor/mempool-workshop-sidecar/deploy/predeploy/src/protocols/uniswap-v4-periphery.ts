import { concatHex, encodeAbiParameters, getContractAddress, parseAbi, parseAbiParameters } from "viem";
import { equalCheck } from "../verify";
import { defineProtocol } from "./define";
import { POSITION_MANAGER_INIT_CODE } from "./position-manager-deployment";
import { QUOTER_INIT_CODE } from "./quoter-deployment";
import { STATE_VIEW_INIT_CODE } from "./state-view-deployment";
import type { Address, Hex } from "../types";

const ARACHNID_PROXY: Address = "0x4e59b44847b379578588920cA78FbF26c0B4956C";
const ZERO_SALT = `0x${"0".repeat(64)}` as Hex;

const MAINNET_POSITION_MANAGER: Address = "0xbD216513d74C8cf14cf4747E6AaA6420FF64ee9e";
const MAINNET_STATE_VIEW: Address = "0x7fFE42C4a5DEeA5b0feC41C94C136Cf115597227";
const MAINNET_QUOTER: Address = "0x52F0E24D1c21C8A0cB1e5a5dD6198556BD9E1203";
// PositionManager's tokenDescriptor - real mainnet NFT-metadata renderer, not predeployed here
// (out of scope: it only serves tokenURI() image/JSON rendering, nothing core to minting or
// managing positions). Left as its real, unreachable-on-this-devnet address, the same choice
// already made for Tornado's historical operator and Uniswap v4's PoolManager governance owner.
const MAINNET_POSITION_DESCRIPTOR: Address = "0xd1428Ba554F4C8450b763a0B2040A4935c63f06C";
const UNSUBSCRIBE_GAS_LIMIT = 150_000n;

const positionManagerAbi = parseAbi([
  "function poolManager() view returns (address)",
  "function permit2() view returns (address)",
  "function WETH9() view returns (address)",
  "function tokenDescriptor() view returns (address)",
  "function unsubscribeGasLimit() view returns (uint256)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function nextTokenId() view returns (uint256)",
]);
const poolManagerGetterAbi = parseAbi(["function poolManager() view returns (address)"]);
const universalRouterAbi = parseAbi([
  "function poolManager() view returns (address)",
  "function V4_POSITION_MANAGER() view returns (address)",
]);

function create2Address(initCode: Hex, args: Hex): { bytecode: Hex; address: Address } {
  const bytecode = concatHex([initCode, args]);
  const address = getContractAddress({ from: ARACHNID_PROXY, opcode: "CREATE2", salt: ZERO_SALT, bytecode });
  return { bytecode, address };
}

/**
 * Uniswap v4's periphery: PositionManager (ERC-721 liquidity positions), StateView (read-only
 * pool-state helper) and Quoter (off-chain quote simulation), all deployed the same way Permit2
 * and the PoolManager singleton (see permit2.ts/uniswap-v4.ts) already are - real creation
 * bytecode replayed through Arachnid's deterministic deployment proxy, already at the same
 * address in this devnet's genesis, with a zero salt.
 *
 * Unlike Permit2, these three DO take constructor arguments, and every one of them references
 * mainnet's real PoolManager/WETH9 addresses - which this devnet's own copies don't share (the
 * PoolManager landed at a devnet-specific address; see uniswap-v4.ts). Replaying the real
 * trailing constructor-argument bytes verbatim would embed those unreachable mainnet addresses.
 * So instead of replaying the real init code + real args byte-for-byte, this predeploys only the
 * (address-independent) init code (`*-deployment.ts`) and re-encodes fresh constructor arguments
 * at deploy time, substituting this devnet's own PoolManager/Permit2/WETH9 addresses for the real
 * ones - the same "real code, our own values" pattern USDC's initializer replay already
 * established, applied here to a constructor instead of a function call.
 *
 * UniversalRouter is a plain top-level creation (real tx, `to: null`) with no CREATE2 factory
 * involved - the existing `create` step's automatic address rewriting handles its poolManager/
 * WETH9/v4PositionManager constructor arguments with no extra code, PROVIDED it deploys after
 * position-manager below (same protocol, later step - so PositionManager's mainnet->devnet
 * mapping is already registered by the time this step's constructor arguments are rewritten).
 * UniversalRouter's other constructor arguments (v2Factory, v3Factory, v3NFTPositionManager, and
 * SPOKE_POOL - confirmed live to be Across Protocol's SpokePool, a cross-chain bridge contract
 * from an entirely separate ecosystem this router also happens to integrate) are real mainnet
 * addresses this devnet has no counterpart for - left unmapped on purpose. v4 swaps/quotes/
 * liquidity all route through poolManager+permit2+v4PositionManager (all correctly rewired) and
 * work; only the router's legacy v2/v3 command paths and cross-chain bridging would revert, since
 * none of those dependencies exist on this chain. Same trade-off as PositionManager's
 * tokenDescriptor.
 */
export default defineProtocol({
  name: "uniswap-v4-periphery",
  dependsOn: ["uniswap-v4", "weth9", "permit2"],
  steps: [
    {
      id: "position-manager",
      kind: "custom",
      run: async (ctx) => {
        const args = encodeAbiParameters(
          parseAbiParameters("address poolManager, address permit2, uint256 unsubscribeGasLimit, address tokenDescriptor, address weth9"),
          [ctx.address("POOL_MANAGER"), ctx.address("PERMIT2"), UNSUBSCRIBE_GAS_LIMIT, MAINNET_POSITION_DESCRIPTOR, ctx.address("WETH9")]
        );
        const { bytecode, address } = create2Address(POSITION_MANAGER_INIT_CODE, args);
        await ctx.send({ to: ARACHNID_PROXY, data: concatHex([ZERO_SALT, bytecode]), value: 0n });
        ctx.record("POSITION_MANAGER", address, MAINNET_POSITION_MANAGER);
      },
    },
    {
      id: "state-view",
      kind: "custom",
      run: async (ctx) => {
        const args = encodeAbiParameters(parseAbiParameters("address poolManager"), [ctx.address("POOL_MANAGER")]);
        const { bytecode, address } = create2Address(STATE_VIEW_INIT_CODE, args);
        await ctx.send({ to: ARACHNID_PROXY, data: concatHex([ZERO_SALT, bytecode]), value: 0n });
        ctx.record("STATE_VIEW", address, MAINNET_STATE_VIEW);
      },
    },
    {
      id: "quoter",
      kind: "custom",
      run: async (ctx) => {
        const args = encodeAbiParameters(parseAbiParameters("address poolManager"), [ctx.address("POOL_MANAGER")]);
        const { bytecode, address } = create2Address(QUOTER_INIT_CODE, args);
        await ctx.send({ to: ARACHNID_PROXY, data: concatHex([ZERO_SALT, bytecode]), value: 0n });
        ctx.record("QUOTER", address, MAINNET_QUOTER);
      },
    },
    {
      id: "universal-router",
      kind: "create",
      tx: "0x350510f7398242ffc778c086ae6bbe9cc744c33a04468f1a7978e54164638257",
      as: "UNIVERSAL_ROUTER",
    },
  ],
  async verify(ctx) {
    const poolManager = ctx.address("POOL_MANAGER");
    const permit2 = ctx.address("PERMIT2");
    const weth9 = ctx.address("WETH9");
    const positionManager = ctx.address("POSITION_MANAGER");
    return [
      equalCheck("PositionManager.poolManager (rewritten to our devnet PoolManager)", await ctx.read(positionManager, positionManagerAbi, "poolManager"), poolManager),
      equalCheck("PositionManager.permit2 (real address - shared with mainnet)", await ctx.read(positionManager, positionManagerAbi, "permit2"), permit2),
      equalCheck("PositionManager.WETH9 (rewritten to our devnet WETH9)", await ctx.read(positionManager, positionManagerAbi, "WETH9"), weth9),
      equalCheck("PositionManager.tokenDescriptor (real mainnet address; not predeployed here)", await ctx.read(positionManager, positionManagerAbi, "tokenDescriptor"), MAINNET_POSITION_DESCRIPTOR),
      equalCheck("PositionManager.unsubscribeGasLimit", await ctx.read(positionManager, positionManagerAbi, "unsubscribeGasLimit"), UNSUBSCRIBE_GAS_LIMIT),
      equalCheck("PositionManager.name", await ctx.read(positionManager, positionManagerAbi, "name"), "Uniswap v4 Positions NFT"),
      equalCheck("PositionManager.symbol", await ctx.read(positionManager, positionManagerAbi, "symbol"), "UNI-V4-POSM"),
      equalCheck("PositionManager.nextTokenId (fresh, unused)", await ctx.read(positionManager, positionManagerAbi, "nextTokenId"), 1n),
      equalCheck("StateView.poolManager", await ctx.read(ctx.address("STATE_VIEW"), poolManagerGetterAbi, "poolManager"), poolManager),
      equalCheck("Quoter.poolManager", await ctx.read(ctx.address("QUOTER"), poolManagerGetterAbi, "poolManager"), poolManager),
      equalCheck("UniversalRouter.poolManager (rewritten to our devnet PoolManager)", await ctx.read(ctx.address("UNIVERSAL_ROUTER"), universalRouterAbi, "poolManager"), poolManager),
      equalCheck(
        "UniversalRouter.V4_POSITION_MANAGER (rewritten to our devnet PositionManager)",
        await ctx.read(ctx.address("UNIVERSAL_ROUTER"), universalRouterAbi, "V4_POSITION_MANAGER"),
        positionManager
      ),
    ];
  },
});
