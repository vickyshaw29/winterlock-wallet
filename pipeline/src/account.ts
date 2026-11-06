// The account's address before it exists, and the factory call that creates it (spec, "Factory"). Mirrors
// account/src/Factory.sol exactly: CREATE2 from the factory, salt = keccak256(abi.encode(all nine createAccount
// arguments)), code = the EIP-1167 proxy to the implementation.
// Accounts are created by an EOA calling the factory, never by a deploy frame (decided Nov 6): the account's
// verify path refuses the legacy nonce [0], and createAccount needs ~954k gas of state, above the 500k prefix cap.
// Written with Claude Code (AI) for Vicky.
import { concat, encodeAbiParameters, encodeFunctionData, getContractAddress, keccak256, parseAbi, parseAbiParameters, type Address, type Hex } from "viem";

/** The nine createAccount arguments; the address commits to every one of them. */
export interface AccountParams {
  root: Hex;
  treeSeed: Hex;
  height: number;
  owner: Address;
  hotStart: number;
  hotValueCap: bigint;
  hotFeeCap: bigint;
  allowedTarget: Address;
  salt: Hex;
}

export const FACTORY_ABI = parseAbi([
  "function createAccount(bytes32 root, bytes32 treeSeed, uint8 height, address owner, uint32 hotStart, uint256 hotValueCap, uint256 hotFeeCap, address allowedTarget, bytes32 salt) returns (address)",
  "function predictAddress(bytes32 root, bytes32 treeSeed, uint8 height, address owner, uint32 hotStart, uint256 hotValueCap, uint256 hotFeeCap, address allowedTarget, bytes32 salt) view returns (address)",
  "function implementation() view returns (address)",
]);

const args = (p: AccountParams) =>
  [p.root, p.treeSeed, p.height, p.owner, p.hotStart, p.hotValueCap, p.hotFeeCap, p.allowedTarget, p.salt] as const;

/** Factory._proxyInitCode: 10 bytes of init code, then the 45-byte runtime that DELEGATECALLs to the implementation. */
export const proxyInitCode = (implementation: Address): Hex =>
  concat(["0x3d602d80600a3d3981f3363d3d373d3d3d363d73", implementation, "0x5af43d82803e903d91602b57fd5bf3"]);

/** The 45-byte code every account has on chain. */
export const proxyRuntimeCode = (implementation: Address): Hex =>
  concat(["0x363d3d373d3d3d363d73", implementation, "0x5af43d82803e903d91602b57fd5bf3"]);

/** Factory._salt. */
export const accountSalt = (p: AccountParams): Hex =>
  keccak256(encodeAbiParameters(parseAbiParameters("bytes32, bytes32, uint8, address, uint32, uint256, uint256, address, bytes32"), args(p)));

/** Factory.predictAddress, computed off chain: the account can be funded before it exists. */
export const predictAccountAddress = (factory: Address, implementation: Address, p: AccountParams): Address =>
  getContractAddress({ opcode: "CREATE2", from: factory, salt: accountSalt(p), bytecodeHash: keccak256(proxyInitCode(implementation)) });

export const createAccountCalldata = (p: AccountParams): Hex =>
  encodeFunctionData({ abi: FACTORY_ABI, functionName: "createAccount", args: args(p) });
