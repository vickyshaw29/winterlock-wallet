import { concatHex } from "viem";
import { describe, expect, it } from "vitest";
import { runProtocols } from "../src/engine";
import { PERMIT2_INIT_CODE, PERMIT2_SALT } from "../src/protocols/permit2-deployment";
import { registry } from "../src/protocols";
import type { Address } from "../src/types";
import { verifyProtocols } from "../src/verify";
import { FakeChain, MemoryArtifacts, MemoryJournal } from "./fakes";

const ARACHNID_PROXY = "0x4e59b44847b379578588920cA78FbF26c0B4956C" as Address;
const MAINNET_PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address;

describe("permit2 deploy", () => {
  it("sends the real salt+init code to Arachnid's proxy and records the real mainnet address", async () => {
    const chain = new FakeChain();
    const journal = new MemoryJournal();

    await runProtocols(["permit2"], registry, { chain, artifacts: new MemoryArtifacts(), journal, log: () => {} });

    expect(chain.sent).toHaveLength(1);
    expect(chain.sent[0].to).toBe(ARACHNID_PROXY);
    expect(chain.sent[0].data).toBe(concatHex([PERMIT2_SALT, PERMIT2_INIT_CODE]));
    // No new-account-creation heuristic here - a plain call, whatever gas it needs.
    expect(chain.sent[0].value).toBe(0n);
    expect(journal.file.protocols.permit2.contracts.PERMIT2).toBe(MAINNET_PERMIT2);
    expect(journal.file.protocols.permit2.mainnetToDevnet[MAINNET_PERMIT2.toLowerCase()]).toBe(MAINNET_PERMIT2);
  });
});

describe("permit2 verify", () => {
  it("passes when the address matches and DOMAIN_SEPARATOR is non-zero", async () => {
    const chain = new FakeChain();
    const journal = new MemoryJournal();
    chain.codes.set(MAINNET_PERMIT2.toLowerCase(), "0x6001");
    journal.file.protocols.permit2 = {
      stepsDone: ["deploy"],
      contracts: { PERMIT2: MAINNET_PERMIT2 },
      mainnetToDevnet: {},
    };
    chain.setRead(MAINNET_PERMIT2, "DOMAIN_SEPARATOR", `0x${"ab".repeat(32)}`);

    const [report] = await verifyProtocols(["permit2"], registry, { chain, artifacts: new MemoryArtifacts(), journal });

    expect(report.ok).toBe(true);
  });

  it("fails when DOMAIN_SEPARATOR reads as zero", async () => {
    const chain = new FakeChain();
    const journal = new MemoryJournal();
    chain.codes.set(MAINNET_PERMIT2.toLowerCase(), "0x6001");
    journal.file.protocols.permit2 = {
      stepsDone: ["deploy"],
      contracts: { PERMIT2: MAINNET_PERMIT2 },
      mainnetToDevnet: {},
    };
    chain.setRead(MAINNET_PERMIT2, "DOMAIN_SEPARATOR", `0x${"0".repeat(64)}`);

    const [report] = await verifyProtocols(["permit2"], registry, { chain, artifacts: new MemoryArtifacts(), journal });

    expect(report.checks.find((c) => c.name === "DOMAIN_SEPARATOR is non-zero")?.ok).toBe(false);
  });
});
