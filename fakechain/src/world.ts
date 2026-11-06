// The genesis world: system contracts with the Day-0 code, the implementation, the factory and funded accounts.
// Written with Claude Code (AI) for Vicky.
import fs from "node:fs";
import path from "node:path";
import { getAddress, keccak256, toHex, type Address, type Hex } from "viem";
import { EXPIRY_VERIFIER, EXPIRY_VERIFIER_CODE, NONCE_MANAGER, NONCE_MANAGER_CODE } from "../../pipeline/src/config.ts";
import { ETH, FACTORY, IMPLEMENTATION, SHOP } from "./constants.ts";
import { WorldState } from "./state.ts";

const ACCOUNT_DIR = path.resolve(import.meta.dir, "../../account");

/** A marked stand-in: INVALID first, so it could never run, then a note. */
const placeholder = (what: string): Hex => `0xfe${toHex(`fakechain placeholder for ${what}`).slice(2)}` as Hex;

/**
 * Account.yul's runtime, cut out of account/build/Account.bin, whose constructor is solc's standard
 * PUSH2 len DUP1 PUSH2 offset PUSH0 CODECOPY PUSH0 RETURN INVALID. A missing or unexpected build gives a placeholder.
 */
export function implementationCode(): { runtime: Hex; initCodeHash: Hex | null; placeholder: boolean; source: string } {
  const file = path.join(ACCOUNT_DIR, "build/Account.bin");
  if (!fs.existsSync(file)) return { runtime: placeholder("the account implementation (no account/build/Account.bin)"), initCodeHash: null, placeholder: true, source: file };
  const bin = `0x${fs.readFileSync(file, "utf8").trim()}` as Hex;
  const m = /^0x61([0-9a-f]{4})8061([0-9a-f]{4})5f395ff3/i.exec(bin);
  if (!m) return { runtime: placeholder("the account implementation (unexpected Account.bin header)"), initCodeHash: keccak256(bin), placeholder: true, source: file };
  const len = parseInt(m[1]!, 16), offset = parseInt(m[2]!, 16);
  const runtime = `0x${bin.slice(2 + 2 * offset, 2 + 2 * (offset + len))}` as Hex;
  return { runtime, initCodeHash: keccak256(bin), placeholder: runtime.length !== 2 + 2 * len, source: file };
}

/** Factory.sol's deployed bytecode from the Foundry artifact, with the `implementation` immutable filled in. */
export function factoryCode(): { runtime: Hex; placeholder: boolean } {
  const file = path.join(ACCOUNT_DIR, "out/Factory.sol/Factory.json");
  if (!fs.existsSync(file)) return { runtime: placeholder("the factory (no account/out/Factory.sol/Factory.json)"), placeholder: true };
  const a = JSON.parse(fs.readFileSync(file, "utf8"));
  let code: string = a.deployedBytecode.object.replace(/^0x/, "");
  const word = IMPLEMENTATION.slice(2).toLowerCase().padStart(64, "0");
  for (const refs of Object.values(a.deployedBytecode.immutableReferences ?? {}) as { start: number; length: number }[][]) {
    for (const r of refs) code = code.slice(0, 2 * r.start) + word.slice(64 - 2 * r.length) + code.slice(2 * (r.start + r.length));
  }
  return { runtime: `0x${code}` as Hex, placeholder: false };
}

export interface GenesisAccounts { eoa: Address; faucet: Address }

export function genesisState(g: GenesisAccounts) {
  const s = new WorldState();
  s.setCode(NONCE_MANAGER, NONCE_MANAGER_CODE as Hex);
  s.setCode(EXPIRY_VERIFIER, EXPIRY_VERIFIER_CODE as Hex);
  const impl = implementationCode();
  s.setCode(IMPLEMENTATION, impl.runtime);
  s.setNonce(IMPLEMENTATION, 1n);
  const factory = factoryCode();
  s.setCode(FACTORY, factory.runtime);
  s.setNonce(FACTORY, 1n);
  s.setBalance(getAddress(g.eoa), 1_000n * ETH);
  s.setBalance(getAddress(g.faucet), 1_000_000n * ETH);
  s.setBalance(SHOP, ETH);
  return { state: s, implementation: impl, factory };
}
