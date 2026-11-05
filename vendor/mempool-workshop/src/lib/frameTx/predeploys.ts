// The two predeployed contracts of EIP-8250 and EIP-8272, and the hashes the protocol uses to find things in them.
import { concat, keccak256, numberToHex, pad, toBytes, type Address, type Hex } from "viem";
import type { RecentRootReference } from "@forshtat/hegota-support/tx";
import { profile } from "./profile.js";

export const NONCE_MANAGER = profile.predeploys!.NONCE_MANAGER as Address;
export const RECENT_ROOT_ADDRESS = profile.predeploys!.RECENT_ROOT_ADDRESS as Address;
/** The predeploy keeps this many slots; a slot's entry is overwritten by the slot 8192 later (the same index in the ring). */
export const RECENT_ROOT_LENGTH = 8192n;

/** Where `NONCE_MANAGER` keeps the next `nonce_seq` of `(sender, key)`: `keccak256(pad32(sender) || uint256(key))`. */
export const keyedNonceSlot = (sender: Address, key: bigint): Hex => keccak256(concat([pad(sender, { size: 32 }), numberToHex(key, { size: 32 })]));

/** A root source is the caller that wrote it plus a salt it chose: `keccak256(caller (20 bytes) || salt (32 bytes))`. */
export const recentRootSourceId = (caller: Address, salt: Hex): Hex => keccak256(concat([caller, salt]));

const domain = (name: string): Hex => keccak256(toBytes(name));
const u64 = (n: bigint): Hex => numberToHex(n, { size: 8 });

/** What the predeploy stores for a reference. It commits to the raw slot, so an entry that wrapped around cannot satisfy an old reference. */
export const recentRootEntryHash = (r: RecentRootReference): Hex => keccak256(concat([domain("RECENT_ROOT_ENTRY"), r.sourceId, u64(r.slot), r.root]));

/** The predeploy storage slot of a reference: the slot number modulo the ring length, under the source. */
export const recentRootStorageKey = (r: Pick<RecentRootReference, "sourceId" | "slot">): Hex =>
  keccak256(concat([domain("RECENT_ROOT_STORAGE"), r.sourceId, u64(r.slot % RECENT_ROOT_LENGTH)]));
