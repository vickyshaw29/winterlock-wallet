import { describe, expect, it } from "vitest";
import { submit } from "../src/send";
import { FakeChain } from "./fakes";

const TX = { to: null, data: "0x6080", value: 0n } as const;

describe("submit", () => {
  it("sends with the margin applied to the estimate and a doubled gas price", async () => {
    const chain = new FakeChain();
    chain.estimate = 1_000_000n;
    chain.price = 1_000_007n;

    const result = await submit(chain, TX, "test/step", () => {});

    expect(chain.sent).toHaveLength(1);
    expect(chain.sent[0].gas).toBe(1_200_000n);
    expect(chain.sent[0].gasPrice).toBe(2_000_014n);
    expect(result.contractAddress).not.toBeNull();
  });

  it("refuses to send when estimation fails, and says why", async () => {
    const chain = new FakeChain();
    chain.estimateError = "execution reverted: nope";

    await expect(submit(chain, TX, "test/step", () => {})).rejects.toThrow(
      /test\/step: gas estimation failed, refusing to send: execution reverted: nope/
    );
    expect(chain.sent).toHaveLength(0);
  });

  it("keeps the first five lines of a multi-line estimation error, joined with ' | '", async () => {
    const chain = new FakeChain();
    chain.estimateError = "line1\nline2\nline3\nline4\nline5\nline6";

    await expect(submit(chain, TX, "test/step", () => {})).rejects.toThrow(
      "test/step: gas estimation failed, refusing to send: line1 | line2 | line3 | line4 | line5"
    );
    await expect(submit(chain, TX, "test/step", () => {})).rejects.not.toThrow(/line6/);
  });

  it("throws with the transaction hash when the transaction reverts", async () => {
    const chain = new FakeChain();
    chain.revertNext = true;

    await expect(submit(chain, TX, "test/step", () => {})).rejects.toThrow(
      /test\/step: transaction 0x[0-9a-f]+ reverted/
    );
  });

  it("logs the estimate and the limit", async () => {
    const chain = new FakeChain();
    const lines: string[] = [];
    await submit(chain, TX, "test/step", (m) => lines.push(m));
    expect(lines[0]).toBe("test/step: estimate 100000 gas, limit 120000");
  });
});
