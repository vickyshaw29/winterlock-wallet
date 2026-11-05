import { encodeFunctionData, parseAbi } from "viem";
import { equalCheck } from "../verify";
import { defineProtocol } from "./define";
import { STAKING_REGISTRY_INIT_CODE } from "./staking-registry-deployment";

const abi = parseAbi([
  "function getDepositInfo(address account) view returns (uint256 stake, uint32 unstakeDelaySec, uint64 withdrawTime)",
  "function addStake(uint32 unstakeDelaySec) payable",
]);

/** The deploy step's own addStake smoke-test amount/delay - verify() (read-only; see below) checks against these. */
const SMOKE_TEST_STAKE = 10n ** 15n; // 0.001 ETH
const SMOKE_TEST_UNSTAKE_DELAY = 86_400;

/**
 * A naive but faithful implementation of ERC-8421's IStakingRegistry
 * (https://github.com/ethereum/ERCs/pull/2028) - no slashing, since the
 * spec itself has none. Not a mainnet replay (there is no mainnet
 * equivalent): a plain CREATE of freshly-compiled bytecode, the same
 * `custom`-step escape hatch `permit2.ts` already uses for its own
 * not-quite-a-plain-replay deployment.
 */
export default defineProtocol({
  name: "staking-registry",
  dependsOn: [],
  steps: [
    {
      id: "deploy",
      kind: "custom",
      run: async (ctx) => {
        const result = await ctx.send({ to: null, data: STAKING_REGISTRY_INIT_CODE, value: 0n });
        if (!result.contractAddress) throw new Error("staking registry deploy produced no contract address");
        ctx.record("StakingRegistry", result.contractAddress);
        // Smoke-tests the deployed bytecode right here, in the same `run`
        // (the only place this protocol has a write-capable `send`) -
        // `verify()` below only gets a read-only `VerifyContext` (no
        // `send`), so it can't perform this call itself; it just reads
        // the result.
        await ctx.send({
          to: result.contractAddress,
          data: encodeFunctionData({ abi, functionName: "addStake", args: [SMOKE_TEST_UNSTAKE_DELAY] }),
          value: SMOKE_TEST_STAKE,
        });
      },
    },
  ],
  async verify(ctx) {
    const registry = ctx.address("StakingRegistry");
    const [stake, unstakeDelaySec] = (await ctx.read(registry, abi, "getDepositInfo", [ctx.deployer])) as [
      bigint,
      number,
      bigint,
    ];
    return [
      equalCheck("deployer stake after deploy-time addStake", stake, SMOKE_TEST_STAKE),
      equalCheck("deployer unstakeDelaySec after deploy-time addStake", unstakeDelaySec, SMOKE_TEST_UNSTAKE_DELAY),
    ];
  },
});
