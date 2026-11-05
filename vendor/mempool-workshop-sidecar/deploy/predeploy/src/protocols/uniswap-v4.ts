import { encodeFunctionData, getContractAddress, keccak256, parseAbi } from "viem";
import { equalCheck } from "../verify";
import { defineProtocol } from "./define";
import { POOL_MANAGER_INIT_CODE } from "./pool-manager-deployment";

const ZERO_SALT = `0x${"0".repeat(64)}` as const;
const MAINNET_POOL_MANAGER = "0x000000000004444c5dc75cB358380D2e3dE08A90";

const competitionAbi = parseAbi([
  "function deploy(bytes bytecode)",
  "function initCodeHash() view returns (bytes32)",
  "function bestAddressSalt() view returns (bytes32)",
]);
const poolManagerAbi = parseAbi([
  "function extsload(bytes32 slot) view returns (bytes32)",
  "function owner() view returns (address)",
]);
// The real, current mainnet Uniswap governance address - baked into the replayed bytecode
// itself, not something we control. Confirmed live: owner() reads exactly this.
const MAINNET_POOL_MANAGER_OWNER = "0x1a9C8182C09F50C8318d769245beA52c32BE35BC";

/**
 * Uniswap v4's PoolManager singleton, deployed through the real UniswapV4DeployerCompetition
 * contract mainnet actually used - a purpose-built factory from a real "vanity address mining
 * competition" Uniswap ran, not a generic CREATE2 proxy. `deploy(bytecode)` enforces
 * `keccak256(bytecode) == initCodeHash` (an immutable set at the factory's own construction), so
 * PoolManager's real bytecode is replayed byte-for-byte with no possibility of drift - the
 * factory itself would reject anything else.
 *
 * The devnet PoolManager does NOT land at mainnet's real vanity address
 * (`0x000000000004444c5dc75cB358380D2e3dE08A90`). That address came from a winning salt
 * submitted during the real competition, recorded in the factory's `bestAddressSalt` storage -
 * which a *fresh* copy of this contract can never acquire, because both the competition
 * (`competitionDeadline`) and the exclusive-deploy window (`exclusiveDeployDeadline`) are
 * immutable historical timestamps that are already in the past the moment this devnet's copy is
 * deployed (confirmed live: both fall in 2024-2025, long before this devnet's clock). Two
 * consequences, both expected and harmless: `updateBestAddress` always reverts
 * ("CompetitionOver"), so `bestAddressSalt` stays its zero default; and `deploy` is
 * *permissionless* here (its exclusive-deployer check only applies before
 * `exclusiveDeployDeadline`, already elapsed), unlike on mainnet where only the real competition
 * organizer could call it during that window. `deploy` therefore CREATE2s with a zero salt, at
 * a devnet-specific address computed from this devnet's own factory instance.
 *
 * PoolManager's constructor argument (an `owner`, for protocol-fee administration only - never
 * needed for ordinary pool creation or swapping) is baked into the exact bytecode above and is
 * the real mainnet Uniswap governance address; nobody here controls it, the same situation as
 * Tornado Cash's operator role.
 */
export default defineProtocol({
  name: "uniswap-v4",
  dependsOn: [],
  steps: [
    {
      id: "deployer-competition",
      kind: "create",
      tx: "0x7c62d6be8b2be4e685bd68fac286bd42921ad3e1767bcf55fe5743de05e3ebc7",
      as: "DEPLOYER_COMPETITION",
    },
    {
      id: "deploy-pool-manager",
      kind: "custom",
      run: async (ctx) => {
        const competition = ctx.address("DEPLOYER_COMPETITION");
        await ctx.send({
          to: competition,
          data: encodeFunctionData({ abi: competitionAbi, functionName: "deploy", args: [POOL_MANAGER_INIT_CODE] }),
          value: 0n,
        });
        const address = getContractAddress({
          from: competition,
          opcode: "CREATE2",
          salt: ZERO_SALT,
          bytecode: POOL_MANAGER_INIT_CODE,
        });
        ctx.record("POOL_MANAGER", address, MAINNET_POOL_MANAGER);
      },
    },
  ],
  async verify(ctx) {
    const competition = ctx.address("DEPLOYER_COMPETITION");
    const poolManager = ctx.address("POOL_MANAGER");
    return [
      equalCheck(
        "bytecode hash matches the factory's own initCodeHash",
        keccak256(POOL_MANAGER_INIT_CODE),
        await ctx.read(competition, competitionAbi, "initCodeHash")
      ),
      equalCheck("deployed with a zero salt (competition already closed)", await ctx.read(competition, competitionAbi, "bestAddressSalt"), ZERO_SALT),
      equalCheck("owner (baked into the bytecode; real mainnet governance)", await ctx.read(poolManager, poolManagerAbi, "owner"), MAINNET_POOL_MANAGER_OWNER),
      // extsload of slot 0 returns owner() left-padded to 32 bytes (confirmed live against
      // mainnet) - a real v4 storage-access function actually working, not just "has code".
      equalCheck(
        "extsload of slot 0 matches owner()",
        await ctx.read(poolManager, poolManagerAbi, "extsload", [ZERO_SALT]),
        `0x${"0".repeat(24)}${MAINNET_POOL_MANAGER_OWNER.slice(2).toLowerCase()}`
      ),
    ];
  },
});
