import { describe, expect, it } from "vitest";
import { explainRejection } from "../../src/lib/frameTx/send.js";
import { decodeDepositInfo } from "../../src/lib/contracts.js";

describe("explainRejection", () => {
  it("maps the sidecar's storage rejection to the storage rules", () => {
    const r = explainRejection("unstaked payer accessed 0x6129d8bf6befced4bd2a300e0a57ec1ab73d690d slot 0x0000000000000000000000000000000000000000000000000000000000000000");
    expect(r.rule).toBe("STO");
    expect(r.hint).toContain("step_7_stake");
  });

  it("maps ethrex's StorageReadNonSender to the storage rules", () => {
    expect(explainRejection("Invalid params: Frame transaction validation-prefix simulation failed: StorageReadNonSender").rule).toBe("STO");
  });

  it("maps banned opcodes from both nodes to OP-011", () => {
    expect(explainRejection("payer uses banned opcode: TIMESTAMP").rule).toBe("OP-011");
    expect(explainRejection("Invalid params: Frame transaction validation-prefix simulation failed: BannedOpcode(66)").rule).toBe("OP-011");
  });

  it("keeps the raw message and says UNKNOWN for anything else", () => {
    const r = explainRejection("something new");
    expect(r.rule).toBe("UNKNOWN");
    expect(r.message).toBe("something new");
  });
});

describe("decodeDepositInfo", () => {
  it("decodes the registry's (stake, unstakeDelaySec, withdrawTime) triple", () => {
    const word = (n: bigint) => n.toString(16).padStart(64, "0");
    const hex = `0x${word(12_000_000_000_000_000n)}${word(86400n)}${word(0n)}` as const;
    expect(decodeDepositInfo(hex)).toEqual({ amount: 12_000_000_000_000_000n, unstakeDelay: 86400, withdrawTime: 0 });
  });

  it("treats empty return data as no stake", () => {
    expect(decodeDepositInfo("0x")).toEqual({ amount: 0n, unstakeDelay: 0, withdrawTime: 0 });
  });
});
