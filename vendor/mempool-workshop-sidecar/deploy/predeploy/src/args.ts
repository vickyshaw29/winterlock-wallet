export type Command = "fetch" | "fund" | "run" | "verify" | "list" | "creation";

const COMMANDS: readonly Command[] = ["fetch", "fund", "run", "verify", "list", "creation"];
const NEEDS_PROTOCOLS: readonly Command[] = ["fetch", "run", "verify"];

export interface ParsedArgs {
  command: Command;
  /** Protocol names, or for `creation` the contract address. */
  names: string[];
  all: boolean;
  force: boolean;
}

export const USAGE = `usage: bun run predeploy <command> [protocols... | --all] [--force]

commands:
  list                         show protocols, dependencies and recorded addresses
  fetch <protocols|--all>      download mainnet transactions from Etherscan (needs ETHERSCAN_API_KEY)
  fund                         send devnet ETH from the shared key to the deployer
  run <protocols|--all>        replay the fetched transactions onto the devnet (--force: deploy a fresh copy)
  verify <protocols|--all>     run read-only checks against the devnet
  creation <address>           print a mainnet contract's creation transaction (needs ETHERSCAN_API_KEY)

environment:
  PREDEPLOY_RPC_URL            devnet RPC (default https://altmempool.forshtat.com)
  PREDEPLOY_DEPLOYER_KEY       deployer private key (default: the published throwaway key)
  ETHERSCAN_API_KEY            only for fetch and creation`;

export function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  if (!command || !COMMANDS.includes(command as Command)) throw new Error(USAGE);

  let all = false;
  let force = false;
  const names: string[] = [];
  for (const arg of rest) {
    if (arg === "--all") all = true;
    else if (arg === "--force") force = true;
    else if (arg.startsWith("--")) throw new Error(`unknown flag ${arg}\n\n${USAGE}`);
    else names.push(arg);
  }

  if (all && names.length > 0) throw new Error("use either --all or protocol names, not both");
  if (force && command !== "run") throw new Error("--force only applies to `run`");
  if (NEEDS_PROTOCOLS.includes(command as Command) && !all && names.length === 0) {
    throw new Error(`${command}: name at least one protocol, or pass --all`);
  }
  if (command === "creation" && names.length !== 1) {
    throw new Error("creation: pass exactly one contract address");
  }
  return { command: command as Command, names, all, force };
}
