import { describe, expect, it } from "vitest";
import { keccak256, concat, toHex, pad, numberToHex } from "viem";
import { NONCE_MANAGER, RECENT_ROOT_ADDRESS, keyedNonceSlot, recentRootEntryHash, recentRootSourceId, recentRootStorageKey } from "../../src/lib/frameTx/predeploys.js";
import { buildWalletTx } from "../../src/lib/frameTx/build.js";

const WALLET = "0x00000000000000000000000000000000000000b1" as const;
const OWNER = "0x00000000000000000000000000000000000000a1" as const;
const base = { wallet: WALLET, owner: OWNER, to: "0x00000000000000000000000000000000000000c2", value: 1n, nonce: 0n, chainId: 1337, maxFeePerGas: 10n } as const;

describe("predeploys", () => {
  it("sit where the devnet profile puts them", () => {
    expect(NONCE_MANAGER).toBe("0x0000000000000000000000000000000000008250");
    expect(RECENT_ROOT_ADDRESS).toBe("0x0000000000000000000000000000000000008272");
  });

  it("derives the keyed nonce slot as keccak256(pad32(sender) || key)", () => {
    expect(keyedNonceSlot(WALLET, 2n)).toBe(keccak256(concat([pad(WALLET, { size: 32 }), numberToHex(2n, { size: 32 })])));
    expect(keyedNonceSlot(WALLET, 1n)).not.toBe(keyedNonceSlot(WALLET, 2n));
  });

  it("derives the source id from the 20-byte caller and the salt, and the ring index from the slot", () => {
    const salt = keccak256(toHex("s"));
    expect(recentRootSourceId(OWNER, salt)).toBe(keccak256(concat([OWNER, salt])));
    const sourceId = recentRootSourceId(OWNER, salt);
    expect(recentRootStorageKey({ sourceId, slot: 5n })).toBe(recentRootStorageKey({ sourceId, slot: 5n + 8192n }));
    expect(recentRootStorageKey({ sourceId, slot: 5n })).not.toBe(recentRootStorageKey({ sourceId, slot: 6n }));
  });

  it("commits the entry hash to the raw slot, so a wrapped-around slot cannot satisfy it", () => {
    const sourceId = keccak256(toHex("src"));
    const root = keccak256(toHex("root"));
    expect(recentRootEntryHash({ sourceId, slot: 5n, root })).not.toBe(recentRootEntryHash({ sourceId, slot: 5n + 8192n, root }));
  });
});

describe("buildWalletTx with the optional fields", () => {
  it("defaults to the account nonce and no references", () => {
    const tx = buildWalletTx(base);
    expect(tx.nonceKeys).toEqual([0n]);
    expect(tx.recentRootReferences).toEqual([]);
  });

  it("carries a nonce key and recent root references", () => {
    const ref = { sourceId: keccak256(toHex("a")), slot: 7n, root: keccak256(toHex("b")) };
    const tx = buildWalletTx({ ...base, nonceKeys: [3n], recentRootReferences: [ref] });
    expect(tx.nonceKeys).toEqual([3n]);
    expect(tx.recentRootReferences).toEqual([ref]);
  });
});
