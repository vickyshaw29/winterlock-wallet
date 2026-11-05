import { concatHex, encodeAbiParameters, getContractAddress, parseAbiParameters } from "viem";
import { describe, expect, it } from "vitest";
import { runProtocols } from "../src/engine";
import { registry } from "../src/protocols";
import { POSITION_MANAGER_INIT_CODE } from "../src/protocols/position-manager-deployment";
import { QUOTER_INIT_CODE } from "../src/protocols/quoter-deployment";
import { STATE_VIEW_INIT_CODE } from "../src/protocols/state-view-deployment";
import type { Address, Hex } from "../src/types";
import { verifyProtocols } from "../src/verify";
import { FakeChain, MemoryArtifacts, MemoryJournal, makeArtifact } from "./fakes";

const ARACHNID_PROXY = "0x4e59b44847b379578588920cA78FbF26c0B4956C" as Address;
const ZERO_SALT = `0x${"0".repeat(64)}` as Hex;
const MAINNET_POOL_MANAGER = "0x000000000004444c5dc75cB358380D2e3dE08A90" as Address;
const MAINNET_WETH9 = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as Address;
const MAINNET_POSITION_MANAGER = "0xbD216513d74C8cf14cf4747E6AaA6420FF64ee9e" as Address;
const MAINNET_STATE_VIEW = "0x7fFE42C4a5DEeA5b0feC41C94C136Cf115597227" as Address;
const MAINNET_QUOTER = "0x52F0E24D1c21C8A0cB1e5a5dD6198556BD9E1203" as Address;
const MAINNET_POSITION_DESCRIPTOR = "0xd1428Ba554F4C8450b763a0B2040A4935c63f06C" as Address;
// The real mainnet UniswapV2Factory address - stands in for UniversalRouter's unmapped
// constructor arguments (v2Factory/v3Factory/v3NFTPositionManager), which the manifest leaves
// untouched on purpose since this devnet has no v2/v3 deployment of its own.
const UNMAPPED_STANDIN = "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f" as Address;
const UNSUBSCRIBE_GAS_LIMIT = 150_000n;

const addressWord = (address: Address): Hex => `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}` as Hex;

function create2Address(initCode: Hex, args: Hex): Address {
  return getContractAddress({ from: ARACHNID_PROXY, opcode: "CREATE2", salt: ZERO_SALT, bytecode: concatHex([initCode, args]) });
}

function setup() {
  const chain = new FakeChain();
  const artifacts = new MemoryArtifacts();
  const journal = new MemoryJournal();

  const competitionStep = registry["uniswap-v4"].steps[0];
  if (competitionStep.kind !== "create") throw new Error("expected a create step");
  artifacts.write("uniswap-v4", makeArtifact({ hash: competitionStep.tx, input: "0x6001" }));

  const wethStep = registry.weth9.steps[0];
  if (wethStep.kind !== "create") throw new Error("expected a create step");
  artifacts.write("weth9", makeArtifact({ hash: wethStep.tx, input: "0x6001", contractAddress: MAINNET_WETH9 }));

  const routerStep = registry["uniswap-v4-periphery"].steps.find((s) => s.id === "universal-router");
  if (!routerStep || routerStep.kind !== "create") throw new Error("expected a create step");
  // A minimal but representative constructor-args tail: three words that should get rewritten
  // (real PoolManager, WETH9 and PositionManager mainnet addresses, whose devnet mappings this
  // run's earlier steps register) and one that should NOT (a real, unmapped address - the
  // manifest leaves v2Factory/v3Factory/v3NFTPositionManager untouched on purpose).
  const args = concatHex([
    addressWord(MAINNET_POOL_MANAGER),
    addressWord(MAINNET_WETH9),
    addressWord(MAINNET_POSITION_MANAGER),
    addressWord(UNMAPPED_STANDIN),
  ]);
  artifacts.write(
    "uniswap-v4-periphery",
    makeArtifact({ hash: routerStep.tx, input: concatHex(["0x6001", args]), constructorArgs: args })
  );

  return { chain, artifacts, journal, log: () => {} };
}

describe("uniswap-v4-periphery deploy", () => {
  it("deploys PositionManager/StateView/Quoter via Arachnid's proxy with devnet addresses spliced into fresh constructor args, then UniversalRouter with its dependencies auto-rewritten", async () => {
    const deps = setup();

    await runProtocols(["uniswap-v4-periphery"], registry, deps);

    // uniswap-v4 (2 sends: create + custom) + weth9 (1 create) + permit2 (1 custom) + this
    // protocol's own 4 (3 customs + 1 create) = 8.
    expect(deps.chain.sent).toHaveLength(8);
    const periphery = deps.chain.sent.slice(4);

    const poolManager = deps.journal.file.protocols["uniswap-v4"].contracts.POOL_MANAGER;
    const weth9 = deps.journal.file.protocols.weth9.contracts.WETH9;
    const permit2 = deps.journal.file.protocols.permit2.contracts.PERMIT2;

    // position-manager: real init code, but fresh constructor args built from our own devnet
    // addresses, not a byte-for-byte replay of the real (unreachable-here) mainnet ones.
    expect(periphery[0].to).toBe(ARACHNID_PROXY);
    const positionManagerArgs = encodeAbiParameters(
      parseAbiParameters(
        "address poolManager, address permit2, uint256 unsubscribeGasLimit, address tokenDescriptor, address weth9"
      ),
      [poolManager, permit2, UNSUBSCRIBE_GAS_LIMIT, MAINNET_POSITION_DESCRIPTOR, weth9]
    );
    expect(periphery[0].data).toBe(concatHex([ZERO_SALT, POSITION_MANAGER_INIT_CODE, positionManagerArgs]));
    const positionManagerAddress = create2Address(POSITION_MANAGER_INIT_CODE, positionManagerArgs);
    const peripheryState = deps.journal.file.protocols["uniswap-v4-periphery"];
    expect(peripheryState.contracts.POSITION_MANAGER).toBe(positionManagerAddress);
    expect(peripheryState.mainnetToDevnet[MAINNET_POSITION_MANAGER.toLowerCase()]).toBe(positionManagerAddress);

    // state-view
    expect(periphery[1].to).toBe(ARACHNID_PROXY);
    const stateViewArgs = encodeAbiParameters(parseAbiParameters("address poolManager"), [poolManager]);
    expect(periphery[1].data).toBe(concatHex([ZERO_SALT, STATE_VIEW_INIT_CODE, stateViewArgs]));
    const stateViewAddress = create2Address(STATE_VIEW_INIT_CODE, stateViewArgs);
    expect(peripheryState.contracts.STATE_VIEW).toBe(stateViewAddress);
    expect(peripheryState.mainnetToDevnet[MAINNET_STATE_VIEW.toLowerCase()]).toBe(stateViewAddress);

    // quoter
    expect(periphery[2].to).toBe(ARACHNID_PROXY);
    const quoterArgs = encodeAbiParameters(parseAbiParameters("address poolManager"), [poolManager]);
    expect(periphery[2].data).toBe(concatHex([ZERO_SALT, QUOTER_INIT_CODE, quoterArgs]));
    const quoterAddress = create2Address(QUOTER_INIT_CODE, quoterArgs);
    expect(peripheryState.contracts.QUOTER).toBe(quoterAddress);
    expect(peripheryState.mainnetToDevnet[MAINNET_QUOTER.toLowerCase()]).toBe(quoterAddress);

    // universal-router: a plain create step - its real PoolManager/WETH9/PositionManager
    // constructor-argument words get rewritten to their devnet counterparts automatically by the
    // engine's generic address map, with zero protocol-specific rewriting code; the unmapped
    // v2Factory-shaped word is left untouched.
    expect(periphery[3].to).toBeNull();
    const sentArgs = periphery[3].data.slice(-4 * 64);
    const words = [0, 1, 2, 3].map((i) => `0x${sentArgs.slice(i * 64, (i + 1) * 64)}` as Hex);
    expect(words[0].toLowerCase()).toBe(addressWord(poolManager).toLowerCase());
    expect(words[1].toLowerCase()).toBe(addressWord(weth9).toLowerCase());
    expect(words[2].toLowerCase()).toBe(addressWord(positionManagerAddress).toLowerCase());
    expect(words[3].toLowerCase()).toBe(addressWord(UNMAPPED_STANDIN).toLowerCase());
  });

  it("resumes correctly if interrupted after PositionManager but before StateView", async () => {
    const deps = setup();
    // Pre-run the three dependencies plus this protocol's first step, as a real interrupted run
    // would leave them.
    await runProtocols(["uniswap-v4", "weth9", "permit2"], registry, deps);
    const poolManager = deps.journal.file.protocols["uniswap-v4"].contracts.POOL_MANAGER;
    const permit2 = deps.journal.file.protocols.permit2.contracts.PERMIT2;
    const weth9 = deps.journal.file.protocols.weth9.contracts.WETH9;
    // FakeChain only auto-registers code for a top-level creation (tx.to === null); POOL_MANAGER
    // and PERMIT2 were both deployed via a CREATE2 factory call (tx.to === the factory), so -
    // exactly like a real chain, which really would have code there - register it by hand, or
    // the engine's isStale check would otherwise see "no code" and redeploy these dependencies
    // from scratch on the next runProtocols call below.
    deps.chain.codes.set(poolManager.toLowerCase(), "0x6001");
    deps.chain.codes.set(permit2.toLowerCase(), "0x6001");
    const positionManagerArgs = encodeAbiParameters(
      parseAbiParameters(
        "address poolManager, address permit2, uint256 unsubscribeGasLimit, address tokenDescriptor, address weth9"
      ),
      [poolManager, permit2, UNSUBSCRIBE_GAS_LIMIT, MAINNET_POSITION_DESCRIPTOR, weth9]
    );
    const positionManagerAddress = create2Address(POSITION_MANAGER_INIT_CODE, positionManagerArgs);
    deps.chain.codes.set(positionManagerAddress.toLowerCase(), "0x6001");
    deps.journal.file.protocols["uniswap-v4-periphery"] = {
      stepsDone: ["position-manager"],
      contracts: { POSITION_MANAGER: positionManagerAddress },
      mainnetToDevnet: { [MAINNET_POSITION_MANAGER.toLowerCase()]: positionManagerAddress },
    };
    const sentBefore = deps.chain.sent.length;

    await runProtocols(["uniswap-v4-periphery"], registry, deps);

    // Only the remaining 3 steps run (state-view, quoter, universal-router) - position-manager is
    // not re-sent.
    expect(deps.chain.sent).toHaveLength(sentBefore + 3);
    expect(deps.journal.file.protocols["uniswap-v4-periphery"].stepsDone).toEqual([
      "position-manager",
      "state-view",
      "quoter",
      "universal-router",
    ]);
  });
});

describe("uniswap-v4-periphery verify", () => {
  function deployed() {
    const chain = new FakeChain();
    const journal = new MemoryJournal();
    const POOL_MANAGER = "0x0000000000000000000000000000000000000009" as Address;
    const WETH9 = "0x0000000000000000000000000000000000000008" as Address;
    const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address;
    const POSITION_MANAGER = "0x0000000000000000000000000000000000000010" as Address;
    const STATE_VIEW = "0x0000000000000000000000000000000000000011" as Address;
    const QUOTER = "0x0000000000000000000000000000000000000012" as Address;
    const UNIVERSAL_ROUTER = "0x0000000000000000000000000000000000000013" as Address;
    for (const address of [POOL_MANAGER, WETH9, PERMIT2, POSITION_MANAGER, STATE_VIEW, QUOTER, UNIVERSAL_ROUTER]) {
      chain.codes.set(address.toLowerCase(), "0x6001");
    }
    journal.file.protocols["uniswap-v4"] = {
      stepsDone: ["deployer-competition", "deploy-pool-manager"],
      contracts: { DEPLOYER_COMPETITION: "0x0000000000000000000000000000000000000001" as Address, POOL_MANAGER },
      mainnetToDevnet: {},
    };
    journal.file.protocols.weth9 = { stepsDone: ["token"], contracts: { WETH9 }, mainnetToDevnet: {} };
    journal.file.protocols.permit2 = { stepsDone: ["deploy"], contracts: { PERMIT2 }, mainnetToDevnet: {} };
    journal.file.protocols["uniswap-v4-periphery"] = {
      stepsDone: ["position-manager", "state-view", "quoter", "universal-router"],
      contracts: { POSITION_MANAGER, STATE_VIEW, QUOTER, UNIVERSAL_ROUTER },
      mainnetToDevnet: {},
    };
    chain.setRead(POSITION_MANAGER, "poolManager", POOL_MANAGER);
    chain.setRead(POSITION_MANAGER, "permit2", PERMIT2);
    chain.setRead(POSITION_MANAGER, "WETH9", WETH9);
    chain.setRead(POSITION_MANAGER, "tokenDescriptor", MAINNET_POSITION_DESCRIPTOR);
    chain.setRead(POSITION_MANAGER, "unsubscribeGasLimit", UNSUBSCRIBE_GAS_LIMIT);
    chain.setRead(POSITION_MANAGER, "name", "Uniswap v4 Positions NFT");
    chain.setRead(POSITION_MANAGER, "symbol", "UNI-V4-POSM");
    chain.setRead(POSITION_MANAGER, "nextTokenId", 1n);
    chain.setRead(STATE_VIEW, "poolManager", POOL_MANAGER);
    chain.setRead(QUOTER, "poolManager", POOL_MANAGER);
    chain.setRead(UNIVERSAL_ROUTER, "poolManager", POOL_MANAGER);
    chain.setRead(UNIVERSAL_ROUTER, "V4_POSITION_MANAGER", POSITION_MANAGER);
    return { chain, journal, artifacts: new MemoryArtifacts() };
  }

  it("passes when every dependency address and real constant matches", async () => {
    const [report] = await verifyProtocols(["uniswap-v4-periphery"], registry, deployed());
    expect(report.ok).toBe(true);
  });

  it("fails if UniversalRouter's PoolManager was somehow left at the real mainnet address instead of being rewritten", async () => {
    const deps = deployed();
    deps.chain.setRead(
      "0x0000000000000000000000000000000000000013" as Address,
      "poolManager",
      MAINNET_POOL_MANAGER
    );
    const [report] = await verifyProtocols(["uniswap-v4-periphery"], registry, deps);
    expect(
      report.checks.find((c) => c.name === "UniversalRouter.poolManager (rewritten to our devnet PoolManager)")?.ok
    ).toBe(false);
  });

  it("fails if PositionManager's tokenDescriptor somehow differs from the real mainnet address", async () => {
    const deps = deployed();
    deps.chain.setRead(
      "0x0000000000000000000000000000000000000010" as Address,
      "tokenDescriptor",
      "0x0000000000000000000000000000000000000099"
    );
    const [report] = await verifyProtocols(["uniswap-v4-periphery"], registry, deps);
    expect(
      report.checks.find((c) => c.name === "PositionManager.tokenDescriptor (real mainnet address; not predeployed here)")?.ok
    ).toBe(false);
  });
});
