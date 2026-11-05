import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatEther } from "viem";
import { parseArgs } from "./args";
import { FileArtifactStore } from "./artifacts";
import { createViemChain } from "./chain-viem";
import {
  DEFAULT_CHAIN_ID,
  DEFAULT_RPC_URL,
  DEPLOYER_KEY,
  FUND_AMOUNT_WEI,
  FUND_MIN_BALANCE_WEI,
  SHARED_DEVNET_KEY,
} from "./config";
import { runProtocols } from "./engine";
import { EtherscanClient } from "./etherscan";
import { fetchProtocolArtifacts } from "./fetch";
import { FileJournalStore } from "./journal";
import { registry } from "./protocols";
import { submit } from "./send";
import type { Address, Hex } from "./types";
import { formatReport, verifyProtocols } from "./verify";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const artifacts = new FileArtifactStore(path.join(ROOT, "artifacts"));
const journal = new FileJournalStore(path.join(ROOT, "addresses"));
const log = (message: string): void => console.log(message);

const rpcUrl = process.env.PREDEPLOY_RPC_URL ?? DEFAULT_RPC_URL;
const deployerKey = (process.env.PREDEPLOY_DEPLOYER_KEY ?? DEPLOYER_KEY) as Hex;

function etherscan(): EtherscanClient {
  const key = process.env.ETHERSCAN_API_KEY;
  if (!key) throw new Error("ETHERSCAN_API_KEY is not set");
  return new EtherscanClient(key);
}

function printAddresses(chainId: number, names: string[]): void {
  const file = journal.load(chainId);
  for (const name of names) {
    for (const [contract, address] of Object.entries(file.protocols[name]?.contracts ?? {})) {
      log(`  ${name}/${contract}: ${address}`);
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const names = args.all ? Object.keys(registry) : args.names;

  switch (args.command) {
    case "list": {
      const recorded = journal.load(DEFAULT_CHAIN_ID);
      for (const [name, protocol] of Object.entries(registry)) {
        const deps = protocol.dependsOn.length ? ` (needs ${protocol.dependsOn.join(", ")})` : "";
        log(`${name}${deps}: ${protocol.steps.map((s) => `${s.id}[${s.kind}]`).join(" -> ")}`);
        for (const [contract, address] of Object.entries(recorded.protocols[name]?.contracts ?? {})) {
          log(`  ${contract}: ${address}`);
        }
      }
      break;
    }
    case "creation": {
      const info = await etherscan().getContractCreation(args.names[0] as Address);
      log(JSON.stringify(info, null, 2));
      break;
    }
    case "fetch": {
      const client = etherscan();
      for (const name of names) {
        if (!Object.hasOwn(registry, name)) throw new Error(`unknown protocol "${name}"`);
        await fetchProtocolArtifacts(registry[name], client, artifacts, log);
      }
      break;
    }
    case "fund": {
      const deployer = await createViemChain(rpcUrl, deployerKey);
      const balance = await deployer.getBalance(deployer.account);
      if (balance >= FUND_MIN_BALANCE_WEI) {
        log(`deployer ${deployer.account} already has ${formatEther(balance)} ETH`);
        break;
      }
      const shared = await createViemChain(rpcUrl, SHARED_DEVNET_KEY);
      await submit(shared, { to: deployer.account, data: "0x", value: FUND_AMOUNT_WEI }, "fund", log);
      log(`funded ${deployer.account} with ${formatEther(FUND_AMOUNT_WEI)} ETH`);
      break;
    }
    case "run": {
      const chain = await createViemChain(rpcUrl, deployerKey);
      log(`deployer ${chain.account} on chain ${chain.chainId} via ${rpcUrl}`);
      await runProtocols(names, registry, { chain, artifacts, journal, log }, { force: args.force });
      log("addresses:");
      printAddresses(chain.chainId, names);
      break;
    }
    case "verify": {
      const chain = await createViemChain(rpcUrl, deployerKey);
      const reports = await verifyProtocols(names, registry, { chain, artifacts, journal });
      for (const report of reports) log(formatReport(report));
      if (reports.some((r) => !r.ok)) process.exit(1);
      break;
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
