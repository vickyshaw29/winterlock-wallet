import { describe, expect, it } from "vitest";
import { rpc } from "../../src/lib/rpc.js";

describe("rpc", () => {
  it("an unreachable endpoint throws RPC_UNREACHABLE with a hint", async () => {
    await expect(rpc("http://127.0.0.1:1", "eth_chainId", [])).rejects.toMatchObject({ code: "RPC_UNREACHABLE" });
  });
});
