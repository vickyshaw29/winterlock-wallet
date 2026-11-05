import { keccak256 } from "viem";
import { splitCreation } from "./creation";
import type { EtherscanApi, SourceMeta } from "./etherscan";
import type { ArtifactStore, Hex, Protocol } from "./types";

/**
 * Downloads every `create` step's mainnet transaction into the artifact
 * store: the creation input, its constructor arguments, the compiler, and the
 * hash of the mainnet runtime code (used later as an informational check).
 */
export async function fetchProtocolArtifacts(
  protocol: Protocol,
  api: EtherscanApi,
  store: ArtifactStore,
  log: (message: string) => void
): Promise<void> {
  for (const step of protocol.steps) {
    if (step.kind !== "create") continue;
    const label = `${protocol.name}/${step.id}`;

    const tx = await api.getTransaction(step.tx);
    if (tx.to !== null) {
      throw new Error(
        `${label}: ${step.tx} is not a direct contract creation (it calls ${tx.to}); factory-created contracts need a different step kind`
      );
    }
    const contractAddress = await api.getReceiptContractAddress(step.tx);
    if (!contractAddress) throw new Error(`${label}: ${step.tx} created no contract`);

    let source: SourceMeta;
    try {
      source = await api.getSourceMeta(contractAddress);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("is not verified")) throw error;
      // No ABI to decode a constructor-argument split against. Treating the whole creation
      // input as init code with no constructor arguments is exact for a contract that truly
      // has none (the common case for such unverified helper/library contracts); it is
      // conservative even otherwise, since no rewriting or argWords override can then be
      // applied to whatever bytes would have been the split-off arguments - the contract is
      // still replayed byte-for-byte, just with nothing inside it eligible for substitution.
      log(
        `${label}: warning: source is not verified on Etherscan; treating the whole creation input as init code with no constructor arguments`
      );
      source = { contractName: "(unverified)", compilerVersion: "(unverified)", constructorArguments: "0x" };
    }
    const runtime = await api.getRuntimeCode(contractAddress);
    // Throws if the arguments Etherscan reports are not a suffix of the input.
    splitCreation({ input: tx.input, constructorArgs: source.constructorArguments });

    store.write(protocol.name, {
      hash: step.tx,
      from: tx.from,
      to: null,
      value: tx.value,
      blockNumber: tx.blockNumber,
      input: tx.input,
      contractAddress,
      constructorArgs: source.constructorArguments,
      contractName: source.contractName,
      compiler: source.compilerVersion,
      runtimeCodeHash: runtime === "0x" ? null : (keccak256(runtime as Hex) as Hex),
    });
    log(`${label}: fetched ${source.contractName} (${source.compilerVersion}) at ${contractAddress}`);
  }
}
