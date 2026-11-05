import { keccak256 } from "viem";
import { isFullyDeployed, resolveContract, type Registry } from "./engine";
import type { Address, ArtifactStore, ChainPort, CheckResult, Hex, JournalStore } from "./types";

export interface CodeHashInfo {
  contract: string;
  /** "unknown" when no mainnet hash was fetched. */
  status: "identical" | "differs" | "unknown";
}

export interface VerifyReport {
  protocol: string;
  ok: boolean;
  checks: CheckResult[];
  codeHashes: CodeHashInfo[];
}

export interface VerifyDeps {
  chain: ChainPort;
  artifacts: ArtifactStore;
  journal: JournalStore;
}

/** Compares as lower-case strings, so bigint 6n equals number 6 equals "6", and addresses ignore case. */
export function equalCheck(name: string, actual: unknown, expected: unknown): CheckResult {
  if (actual === null || actual === undefined) return { name, ok: false, detail: "no value returned" };
  const ok = String(actual).toLowerCase() === String(expected).toLowerCase();
  return { name, ok, detail: ok ? String(actual) : `expected ${String(expected)}, got ${String(actual)}` };
}

/**
 * Runs each protocol's read-only checks against the chain, plus two generic
 * ones: every recorded contract has code, and its runtime code is compared
 * with mainnet's. A code-hash difference is reported but never fails a run:
 * immutables and baked-in arguments legitimately change the runtime code.
 */
export async function verifyProtocols(
  names: string[],
  registry: Registry,
  deps: VerifyDeps
): Promise<VerifyReport[]> {
  const { chain } = deps;
  const journal = deps.journal.load(chain.chainId);
  const reports: VerifyReport[] = [];

  for (const name of names) {
    if (!Object.hasOwn(registry, name)) throw new Error(`unknown protocol "${name}"`);
    const protocol = registry[name];
    const state = journal.protocols[name];

    if (!state || !isFullyDeployed(protocol, state)) {
      reports.push({
        protocol: name,
        ok: false,
        checks: [{ name: "deployed", ok: false, detail: `not fully deployed; run: bun run predeploy run ${name}` }],
        codeHashes: [],
      });
      continue;
    }

    const lookup = (contractName: string): Address => resolveContract(name, contractName, registry, journal);

    const checks: CheckResult[] = [];
    for (const [contractName, address] of Object.entries(state.contracts)) {
      const code = await chain.getCode(address);
      checks.push({ name: `${contractName} has code`, ok: code !== "0x", detail: address });
    }

    try {
      checks.push(
        ...(await protocol.verify({
          deployer: chain.account,
          address: lookup,
          read: (address, abi, functionName, args) => chain.read(address, abi, functionName, args),
        }))
      );
    } catch (error) {
      checks.push({
        name: "verify",
        ok: false,
        detail: `threw: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
      });
    }

    const codeHashes: CodeHashInfo[] = [];
    for (const step of protocol.steps) {
      if (step.kind !== "create") continue;
      const address = state.contracts[step.as];
      let mainnetHash: Hex | null = null;
      try {
        mainnetHash = deps.artifacts.read(name, step.tx).runtimeCodeHash;
      } catch {
        mainnetHash = null;
      }
      if (!address || !mainnetHash) {
        codeHashes.push({ contract: step.as, status: "unknown" });
        continue;
      }
      const local = keccak256((await chain.getCode(address)) as Hex);
      codeHashes.push({ contract: step.as, status: local === mainnetHash ? "identical" : "differs" });
    }

    reports.push({ protocol: name, ok: checks.every((c) => c.ok), checks, codeHashes });
  }
  return reports;
}

export function formatReport(report: VerifyReport): string {
  const lines = [`${report.ok ? "PASS" : "FAIL"} ${report.protocol}`];
  for (const check of report.checks) {
    lines.push(`  ${check.ok ? "ok  " : "FAIL"} ${check.name}: ${check.detail}`);
  }
  for (const info of report.codeHashes) {
    const text =
      info.status === "identical"
        ? "runtime code identical to mainnet"
        : info.status === "differs"
          ? "runtime code differs from mainnet (expected with immutables or baked-in arguments)"
          : "no mainnet code hash to compare";
    lines.push(`  info ${info.contract}: ${text}`);
  }
  return lines.join("\n");
}
