import { describe, expect, it } from "vitest";
import { keccak256, recoverAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { computeSigHash, decodeFrameTx, encodeRawFrameTx } from "../../src/lib/frameTx/codec.js";
import { buildSelfRelayTx, signFrameTx, toWire, txHash } from "../../src/lib/frameTx/build.js";
import { FRAME_MODE } from "../../src/lib/frameTx/types.js";

const KEY = "0x0000000000000000000000000000000000000000000000000000000000000001" as const;
const from = privateKeyToAccount(KEY).address;
const base = { from, to: "0x8943545177806ED17B9F23F0a21ee5948eCaa776", value: 1_000_000_000n, nonce: 7n, chainId: 1337, maxFeePerGas: 2_000_000_000n } as const;

describe("frame tx lib", () => {
  it("buildSelfRelayTx is [VERIFY(execution+payment) on sender, SENDER transfer] with nonce key 0", () => {
    const tx = buildSelfRelayTx(base);
    expect(tx.nonceKeys).toEqual([0n]);
    expect(tx.nonceSeq).toBe(7n);
    expect(tx.frames).toHaveLength(2);
    expect(tx.frames[0]).toMatchObject({ mode: FRAME_MODE.VERIFY, flags: 3, target: null });
    expect(tx.frames[1]).toMatchObject({ mode: FRAME_MODE.SENDER, target: base.to, value: base.value });
  });

  it("signFrameTx signature recovers to the signer over computeSigHash", async () => {
    const signed = await signFrameTx(buildSelfRelayTx(base), KEY);
    const packed = signed.signatures[0].signature;
    const v = parseInt(packed.slice(2, 4), 16);
    const recovered = await recoverAddress({
      hash: computeSigHash(signed),
      signature: { r: `0x${packed.slice(4, 68)}`, s: `0x${packed.slice(68, 132)}`, v: BigInt(v + 27) },
    });
    expect(recovered).toBe(from);
  });

  it("toWire renders every bigint as a 0x hex string", () => {
    const wire: any = toWire(buildSelfRelayTx(base));
    expect(wire.chainId).toBe("0x539");
    expect(wire.nonceSeq).toBe("0x7");
    expect(wire.nonceKeys).toEqual(["0x0"]);
    expect(wire.frames[1].value).toBe("0x3b9aca00");
    expect(wire.fees.maxFeePerGas).toBe("0x77359400");
  });

  it("txHash is keccak256 of the raw type-0x06 encoding, and the codec round-trips", async () => {
    const signed = await signFrameTx(buildSelfRelayTx(base), KEY);
    expect(txHash(signed)).toBe(keccak256(encodeRawFrameTx(signed)));
    const raw = encodeRawFrameTx(signed);
    expect(raw.startsWith("0x06")).toBe(true);
    const back = decodeFrameTx(raw);
    expect(back.nonceSeq).toBe(7n);
    expect(back.sender).toBe(from.toLowerCase());
  });
});
