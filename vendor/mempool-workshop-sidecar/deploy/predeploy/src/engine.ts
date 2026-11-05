import { AddressMap } from "./address-map";
import { applyArgWords, splitCreation } from "./creation";
import { submit } from "./send";
import type {
  Address,
  ArtifactStore,
  ChainPort,
  CreateStep,
  Hex,
  JournalFile,
  JournalStore,
  Protocol,
  ProtocolState,
  StepContext,
} from "./types";

export type Registry = Record<string, Protocol>;

export interface EngineDeps {
  chain: ChainPort;
  artifacts: ArtifactStore;
  journal: JournalStore;
  log: (message: string) => void;
}

/** Requested protocols plus their dependencies, dependencies first, each once. */
export function resolveOrder(names: string[], registry: Registry): string[] {
  const order: string[] = [];
  const done = new Set<string>();
  const visiting = new Set<string>();

  const visit = (name: string, path: string[]): void => {
    if (!Object.hasOwn(registry, name)) throw new Error(`unknown protocol "${name}"`);
    if (done.has(name)) return;
    if (visiting.has(name)) throw new Error(`dependency cycle: ${[...path, name].join(" -> ")}`);
    visiting.add(name);
    for (const dependency of registry[name].dependsOn) visit(dependency, [...path, name]);
    visiting.delete(name);
    done.add(name);
    order.push(name);
  };

  for (const name of names) visit(name, []);
  return order;
}

/** True when the journal records every step of the protocol (by step id) as done. */
export function isFullyDeployed(protocol: Protocol, state: ProtocolState | undefined): boolean {
  return state !== undefined && protocol.steps.every((s) => state.stepsDone.includes(s.id));
}

/**
 * Devnet address of a contract, looked up in the protocol itself first, then in the
 * protocols it (transitively) depends on, the one run last first. Other protocols are not visible.
 */
export function resolveContract(
  protocolName: string,
  contractName: string,
  registry: Registry,
  journal: JournalFile
): Address {
  const scope = [protocolName, ...resolveOrder([protocolName], registry).slice(0, -1).reverse()];
  for (const name of scope) {
    const found = journal.protocols[name]?.contracts[contractName];
    if (found) return found;
  }
  throw new Error(`${protocolName}: no deployed contract named "${contractName}"`);
}

/** True when a recorded contract has no code on the chain, e.g. after a devnet restart. */
async function isStale(state: ProtocolState, chain: ChainPort): Promise<boolean> {
  for (const address of Object.values(state.contracts)) {
    if ((await chain.getCode(address)) === "0x") return true;
  }
  return false;
}

async function runCreate(
  protocolName: string,
  step: CreateStep,
  state: ProtocolState,
  map: AddressMap,
  deps: EngineDeps
): Promise<void> {
  const label = `${protocolName}/${step.id}`;
  const artifact = deps.artifacts.read(protocolName, step.tx);
  if (!artifact.contractAddress) {
    throw new Error(`${label}: artifact ${step.tx} is not a contract creation`);
  }
  const { initCode, args } = splitCreation(artifact);
  const patchedInit = step.patches ? map.patch(initCode, step.patches) : initCode;
  const rewritten = map.rewrite(applyArgWords(args, step.argWords));
  for (const address of rewritten.unmapped) {
    deps.log(`${label}: warning: constructor argument ${address} looks like an address but has no devnet mapping`);
  }
  const data = `${patchedInit}${rewritten.data.slice(2)}` as Hex;

  const result = await submit(
    deps.chain,
    { to: null, data, value: BigInt(artifact.value) },
    label,
    deps.log
  );
  if (!result.contractAddress) throw new Error(`${label}: receipt has no contract address`);

  state.contracts[step.as] = result.contractAddress;
  state.mainnetToDevnet[artifact.contractAddress.toLowerCase()] = result.contractAddress;
  map.set(artifact.contractAddress, result.contractAddress);
  deps.log(`${label}: ${step.as} -> ${result.contractAddress}`);
}

/**
 * Deploys the requested protocols (dependencies first) by replaying their
 * manifests. Progress is journaled after every step, so an interrupted run
 * resumes where it stopped and a restarted chain (recorded contracts gone)
 * starts over.
 */
export async function runProtocols(
  names: string[],
  registry: Registry,
  deps: EngineDeps,
  options: { force?: boolean } = {}
): Promise<JournalFile> {
  const { chain, log } = deps;
  const order = resolveOrder(names, registry);
  const requested = new Set(names);
  const journal = deps.journal.load(chain.chainId);

  // Guard against sends made outside this tool (or an interrupted earlier run): a second
  // deployment at the next nonce would shift every later CREATE address.
  const recorded = Object.values(journal.protocols).flatMap((s) => Object.values(s.contracts));
  const live = (await Promise.all(recorded.map((address) => chain.getCode(address)))).some((code) => code !== "0x");
  const nonce = await chain.transactionCount();
  if (live) {
    if (journal.deployerNonce === undefined) {
      log(`deployer nonce ${nonce} adopted as the journal's baseline`);
      journal.deployerNonce = nonce;
      deps.journal.save(journal);
    } else if (journal.deployerNonce !== nonce) {
      const message = `deployer nonce is ${nonce} but the journal accounts for ${journal.deployerNonce}: something sent a transaction from ${chain.account} outside this tool, or an earlier run was interrupted after a transaction was mined. Deploying now would shift every later address. Investigate and repair addresses/${chain.chainId}.json (see deploy/predeploy/README.md), or re-run with --force to continue anyway.`;
      if (!options.force) throw new Error(message);
      log(`warning: ${message.split(": something sent")[0]}; continuing because of --force`);
    }
  } else {
    journal.deployerNonce = undefined; // a fresh or restarted chain: nothing to compare against
  }

  for (const name of order) {
    const protocol = registry[name];
    let state: ProtocolState | undefined = journal.protocols[name];

    if (state && options.force && requested.has(name)) {
      log(`${name}: --force, deploying a fresh copy`);
      state = undefined;
    }
    if (state && (await isStale(state, chain))) {
      log(`${name}: recorded contracts are missing from this chain (restarted?), starting over`);
      state = undefined;
    }
    if (!state) state = { stepsDone: [], contracts: {}, mainnetToDevnet: {} };
    journal.protocols[name] = state;

    if (isFullyDeployed(protocol, state)) {
      log(`${name}: already deployed`);
      continue;
    }

    const earlier = order.slice(0, order.indexOf(name));
    const map = new AddressMap();
    for (const other of earlier) {
      for (const [mainnet, devnet] of Object.entries(journal.protocols[other]?.mainnetToDevnet ?? {})) {
        map.set(mainnet as Address, devnet);
      }
    }
    for (const [mainnet, devnet] of Object.entries(state.mainnetToDevnet)) {
      map.set(mainnet as Address, devnet);
    }

    const lookup = (contractName: string): Address => resolveContract(name, contractName, registry, journal);

    for (const step of protocol.steps) {
      if (state.stepsDone.includes(step.id)) continue;
      if (step.kind === "create") {
        await runCreate(name, step, state, map, deps);
      } else {
        const label = `${name}/${step.id}`;
        const context: StepContext = {
          deployer: chain.account,
          address: lookup,
          send: (tx) => submit(chain, tx, label, log),
          read: (address, abi, functionName, args) => chain.read(address, abi, functionName, args),
          record: (recordName, address, mainnetAddress) => {
            state.contracts[recordName] = address;
            if (mainnetAddress) {
              state.mainnetToDevnet[mainnetAddress.toLowerCase()] = address;
              map.set(mainnetAddress, address);
            }
          },
        };
        await step.run(context);
        log(`${label}: done`);
      }
      state.stepsDone.push(step.id);
      journal.deployerNonce = await chain.transactionCount();
      deps.journal.save(journal);
    }
    log(`${name}: deployed`);
  }

  deps.journal.save(journal);
  return journal;
}
