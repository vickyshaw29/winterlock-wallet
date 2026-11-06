// account/src/Factory.sol modelled: createAccount, predictAddress and implementation(), with Solidity's ABI checks.
// Written with Claude Code (AI) for Vicky.
import { concat, keccak256, pad, toHex, type Address, type Hex } from "viem";
import { predictAccountAddress, proxyRuntimeCode, type AccountParams } from "../../pipeline/src/account.ts";
import { accountCall, Meter, Revert, StateMeter, StorageCtx, SELECTORS } from "./accountModel.ts";
import { FACTORY, IMPLEMENTATION } from "./constants.ts";
import type { WorldState } from "./state.ts";

export const FACTORY_SELECTORS = { createAccount: 0x38ffbfcd, predictAddress: 0xa52b96de, implementation: 0x5c60da1b } as const;
export const ACCOUNT_CREATED_TOPIC = keccak256(toHex("AccountCreated(address,bytes32,address)"));

/**
 * Gas of a successful creation, modelled to the measured 953,678 for an EOA's createAccount with six initialised
 * slots (spec, Factory): CREATE2 and the calls 59,600 plus the SSTOREs (2,100 cold + 2,900 each, from StorageCtx);
 * state gas 183,600 for the new account, 1,530 per byte of the 45-byte proxy, 97,920 per initialised slot.
 */
export const CREATE_GAS = { execution: 59_600, newAccountState: 183_600n, codeState: 1_530n * 45n } as const;

export interface Log { address: Address; topics: Hex[]; data: Hex }

const SOLIDITY_REVERT = () => new Revert("", "0x"); // the ABI decoder and a missing function revert with no data

/** The nine createAccount / predictAddress arguments, with the checks Solidity's ABI decoder makes. */
export function decodeAccountArgs(data: Uint8Array): AccountParams {
  if (data.length < 4 + 32 * 9) throw SOLIDITY_REVERT();
  const w = (i: number) => {
    let v = 0n;
    for (let j = 0; j < 32; j++) v = (v << 8n) | BigInt(data[4 + 32 * i + j]!);
    return v;
  };
  const fits = (v: bigint, bits: number) => { if (v >> BigInt(bits)) throw SOLIDITY_REVERT(); return v; };
  const hex32 = (v: bigint) => `0x${v.toString(16).padStart(64, "0")}` as Hex;
  const addr = (v: bigint) => `0x${v.toString(16).padStart(40, "0")}` as Address;
  return {
    root: hex32(w(0)), treeSeed: hex32(w(1)), height: Number(fits(w(2), 8)), owner: addr(fits(w(3), 160)),
    hotStart: Number(fits(w(4), 32)), hotValueCap: w(5), hotFeeCap: w(6), allowedTarget: addr(fits(w(7), 160)), salt: hex32(w(8)),
  };
}

export interface FactoryResult { returnData: Hex; created: Address | null; logs: Log[] }

/**
 * A call to the factory. createAccount writes to `state` (the caller runs it on a copy and keeps the copy only when the
 * call succeeds); an initialize refusal bubbles up unchanged, as Solidity re-throws a failed call's revert data.
 */
export function factoryCall(data: Uint8Array, state: WorldState, meter: Meter, stateGas: StateMeter, value = 0n): FactoryResult {
  // Factory.sol has no payable function and no receive(): Solidity's callvalue check reverts any call carrying ETH.
  if (value !== 0n) throw SOLIDITY_REVERT();
  if (data.length < 4) throw SOLIDITY_REVERT();
  const sel = ((data[0]! << 24) | (data[1]! << 16) | (data[2]! << 8) | data[3]!) >>> 0;
  const word = (v: bigint | string) => pad(toHex(BigInt(v)), { size: 32 });
  if (sel === FACTORY_SELECTORS.implementation) {
    meter.charge(2_300);
    return { returnData: word(IMPLEMENTATION), created: null, logs: [] };
  }
  if (sel !== FACTORY_SELECTORS.createAccount && sel !== FACTORY_SELECTORS.predictAddress) throw SOLIDITY_REVERT();
  const p = decodeAccountArgs(data);
  const account = predictAccountAddress(FACTORY, IMPLEMENTATION, p);
  meter.charge(3_000); // salt and address hashing, the code check
  if (sel === FACTORY_SELECTORS.predictAddress || state.code(account) !== "0x") {
    return { returnData: word(account), created: null, logs: [] }; // an existing account is returned unchanged
  }
  meter.charge(CREATE_GAS.execution - 3_000);
  stateGas.charge(CREATE_GAS.newAccountState + CREATE_GAS.codeState);
  state.setCode(account, proxyRuntimeCode(IMPLEMENTATION));
  state.setNonce(account, 1n); // EIP-161: a created contract starts at nonce 1
  const init = concat([toHex(SELECTORS.initialize, { size: 4 }), ...[p.root, p.treeSeed, word(BigInt(p.height)), word(p.owner), word(BigInt(p.hotStart)), word(p.hotValueCap), word(p.hotFeeCap), word(p.allowedTarget)].map((x) => pad(x as Hex, { size: 32 }))]);
  const storage = new StorageCtx((s) => state.sload(account, s), () => 0n, (s, v) => state.sstore(account, s, v), new Set(), meter, stateGas);
  accountCall(hexBytes(init), false, storage, meter);
  const log: Log = { address: FACTORY, topics: [ACCOUNT_CREATED_TOPIC, pad(account, { size: 32 })], data: concat([pad(p.root, { size: 32 }), pad(p.owner, { size: 32 })]) };
  return { returnData: word(account), created: account, logs: [log] };
}

const hexBytes = (h: Hex) => Uint8Array.from(Buffer.from(h.slice(2), "hex"));
