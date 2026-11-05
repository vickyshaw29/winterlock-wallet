import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSON5 from "json5";
import { isAddress, parseEther, parseGwei } from "viem";
import type { Address } from "viem";
import { StepError } from "./output.js";

/** The one configuration file. The code reads it and never writes it. */
export const CONFIG_FILE = fileURLToPath(new URL("../../workshop.config.json5", import.meta.url));

export interface Config {
  chainId: number;
  gatewayUrl: string;
  explorerUrl: string;
  stakingRegistry: Address;
  entryPoint: Address;
  /** Absolute path. */
  stateFile: string;
  recipient: Address;
  transferWei: bigint;
  maxFeePerGasWei: bigint;
  legacyGasPriceWei: bigint;
  legacyGasLimit: bigint;
  deployGasLimit: bigint;
  txTimeoutSec: number;
  minBalanceWei: bigint;
  paymasterFundingWei: bigint;
  walletFundingWei: bigint;
  violatingWalletFundingWei: bigint;
  stakeWei: bigint;
  unstakeDelaySec: number;
  banOpsSeenPenalty: number;
}

/** Each key of the file, how to check it, and where it lands in `Config`. */
const FIELDS: { [K: string]: { kind: "int" | "string" | "address" | "eth" | "gwei"; to: keyof Config } } = {
  chainId: { kind: "int", to: "chainId" },
  gatewayUrl: { kind: "string", to: "gatewayUrl" },
  explorerUrl: { kind: "string", to: "explorerUrl" },
  stakingRegistry: { kind: "address", to: "stakingRegistry" },
  entryPoint: { kind: "address", to: "entryPoint" },
  stateFile: { kind: "string", to: "stateFile" },
  recipient: { kind: "address", to: "recipient" },
  transferGwei: { kind: "gwei", to: "transferWei" },
  maxFeePerGasGwei: { kind: "gwei", to: "maxFeePerGasWei" },
  legacyGasPriceGwei: { kind: "gwei", to: "legacyGasPriceWei" },
  legacyGasLimit: { kind: "int", to: "legacyGasLimit" },
  deployGasLimit: { kind: "int", to: "deployGasLimit" },
  txTimeoutSec: { kind: "int", to: "txTimeoutSec" },
  minBalanceEth: { kind: "eth", to: "minBalanceWei" },
  paymasterFundingEth: { kind: "eth", to: "paymasterFundingWei" },
  walletFundingEth: { kind: "eth", to: "walletFundingWei" },
  violatingWalletFundingEth: { kind: "eth", to: "violatingWalletFundingWei" },
  stakeEth: { kind: "eth", to: "stakeWei" },
  unstakeDelaySec: { kind: "int", to: "unstakeDelaySec" },
  banOpsSeenPenalty: { kind: "int", to: "banOpsSeenPenalty" },
};

const BIGINT_INTS = new Set<keyof Config>(["legacyGasLimit", "deployGasLimit"]);

function invalid(problems: string[]): StepError {
  return new StepError("CONFIG_INVALID", `${CONFIG_FILE}:\n  ${problems.join("\n  ")}`, {
    hint: "fix workshop.config.json5: every key is required and no other key is allowed",
  });
}

/** Parses and strictly validates the text of a config file. */
export function parseConfig(text: string): Config {
  let raw: unknown;
  try {
    raw = JSON5.parse(text);
  } catch (e) {
    throw invalid([`not valid JSON5: ${(e as Error).message}`]);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw invalid(["the top level must be an object"]);
  const obj = raw as Record<string, unknown>;
  const problems: string[] = [];
  for (const key of Object.keys(obj)) if (!(key in FIELDS)) problems.push(`unknown key "${key}"`);
  const out: Record<string, unknown> = {};
  for (const [key, { kind, to }] of Object.entries(FIELDS)) {
    const v = obj[key];
    if (v === undefined) {
      problems.push(`missing key "${key}"`);
      continue;
    }
    try {
      if (kind === "int") {
        if (!Number.isSafeInteger(v) || (v as number) <= 0) throw new Error("expected a positive integer");
        out[to] = BIGINT_INTS.has(to) ? BigInt(v as number) : v;
      } else if (kind === "string") {
        if (typeof v !== "string" || v === "") throw new Error("expected a non-empty string");
        out[to] = v;
      } else if (kind === "address") {
        if (typeof v !== "string" || !isAddress(v, { strict: false })) throw new Error("expected a 0x address");
        out[to] = v;
      } else {
        if (typeof v !== "string") throw new Error(`expected a string such as "0.1" (${kind === "eth" ? "ETH" : "gwei"})`);
        out[to] = kind === "eth" ? parseEther(v) : parseGwei(v);
      }
    } catch (e) {
      problems.push(`"${key}": ${(e as Error).message}`);
    }
  }
  if (problems.length) throw invalid(problems);
  out.stateFile = path.resolve(path.dirname(CONFIG_FILE), out.stateFile as string);
  return out as unknown as Config;
}

let cached: Config | undefined;

export function loadConfig(): Config {
  if (!cached) {
    let text: string;
    try {
      text = fs.readFileSync(CONFIG_FILE, "utf8");
    } catch {
      throw new StepError("CONFIG_MISSING", `${CONFIG_FILE} not found`, { hint: "restore workshop.config.json5 from git" });
    }
    cached = parseConfig(text);
  }
  return cached;
}

/** For tests: replaces the loaded configuration. */
export function setConfig(config: Config | undefined): void {
  cached = config;
}
