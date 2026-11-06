import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChainChanged, checkChainPin, pinFileFor, pinOrCheckChain, type ChainIdentity } from "../src/genesis.ts";

// The devnet's real genesis hash (chain 1337, read Nov 6).
const DEVNET: ChainIdentity = { chainId: 1337n, genesisHash: "0x196a1589ac71e2f305b1fbc7bfd23e55367f9fd6eb9da97e2f572c2791e17bbc" };
const RESET: ChainIdentity = { chainId: 1337n, genesisHash: `0x${"ab".repeat(32)}` };
const tmpPin = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pin-")), "seed.bin.chain.json");

describe("genesis guard", () => {
  test("the first call pins the chain beside the seed, readable only by its owner", async () => {
    const file = tmpPin();
    const pin = await pinOrCheckChain(file, async () => DEVNET);
    expect(pin).toMatchObject({ chainId: "1337", genesisHash: DEVNET.genesisHash });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(pinFileFor("/data/wallet-1/seed.bin")).toBe("/data/wallet-1/seed.bin.chain.json");
  });

  test("later calls on the same chain pass", async () => {
    const file = tmpPin();
    await pinOrCheckChain(file, async () => DEVNET);
    expect(await pinOrCheckChain(file, async () => DEVNET)).toMatchObject({ genesisHash: DEVNET.genesisHash });
  });

  test("after a devnet reset (same chain id, new genesis) it refuses, and the pin is not replaced", async () => {
    const file = tmpPin();
    await pinOrCheckChain(file, async () => DEVNET);
    await expect(pinOrCheckChain(file, async () => RESET)).rejects.toBeInstanceOf(ChainChanged);
    await expect(pinOrCheckChain(file, async () => RESET)).rejects.toThrow("was reset");
    expect(JSON.parse(fs.readFileSync(file, "utf8")).genesisHash).toBe(DEVNET.genesisHash);
  });

  test("another chain id is refused", () => {
    expect(() => checkChainPin({ chainId: "1337", genesisHash: DEVNET.genesisHash, pinnedAt: "" }, { ...DEVNET, chainId: 1n })).toThrow("connected to chain 1");
  });

  test("hash comparison ignores hex case", () => {
    expect(() => checkChainPin({ chainId: "1337", genesisHash: DEVNET.genesisHash.toUpperCase().replace("0X", "0x") as `0x${string}`, pinnedAt: "" }, DEVNET)).not.toThrow();
  });
});
