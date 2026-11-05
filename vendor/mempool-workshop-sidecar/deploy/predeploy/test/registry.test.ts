import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { registry } from "../src/protocols";

describe("protocol registry", () => {
  it("has consistent manifests", () => {
    for (const [key, protocol] of Object.entries(registry)) {
      expect(protocol.name).toBe(key);
      for (const dependency of protocol.dependsOn) expect(registry).toHaveProperty(dependency);
      const ids = protocol.steps.map((s) => s.id);
      expect(new Set(ids).size).toBe(ids.length);
      const names = protocol.steps.flatMap((s) => (s.kind === "create" ? [s.as] : []));
      expect(new Set(names).size).toBe(names.length);
      for (const step of protocol.steps) {
        if (step.kind !== "create") continue;
        expect(step.tx).toMatch(/^0x[0-9a-f]{64}$/);
        const file = new URL(`../artifacts/${key}/${step.tx}.json`, import.meta.url);
        expect(fs.existsSync(file), `missing artifact ${key}/${step.tx}.json`).toBe(true);
        expect((JSON.parse(fs.readFileSync(file, "utf8")) as { hash: string }).hash).toBe(step.tx);
      }
    }
  });

  it("deploys in the documented order: link, usdt, bayc, tornado, usdc, weth9, permit2, uniswap-v4, uniswap-v4-periphery, railgun, staking-registry", () => {
    expect(Object.keys(registry)).toEqual([
      "link",
      "usdt",
      "bayc",
      "tornado",
      "usdc",
      "weth9",
      "permit2",
      "uniswap-v4",
      "uniswap-v4-periphery",
      "railgun",
      "staking-registry",
    ]);
  });
});
