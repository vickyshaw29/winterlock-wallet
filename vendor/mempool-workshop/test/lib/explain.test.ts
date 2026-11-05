import { describe, expect, it } from "vitest";
import { EXPLANATIONS, renderExplanation } from "../../src/lib/explain.js";
import pkg from "../../package.json" with { type: "json" };

describe("explanations", () => {
  it("exist for every step script", () => {
    const steps = Object.keys(pkg.scripts).filter((s) => /^step_\d+_/.test(s));
    expect(steps.sort()).toEqual(Object.keys(EXPLANATIONS).sort());
  });

  it("render four labelled sections within the width", () => {
    const text = renderExplanation("step_6_tx_violating_canonical", 92)!;
    for (const label of ["What is going on:", "Components:", "Watch for:", "Why it matters:"]) expect(text).toContain(label);
    expect(Math.max(...text.split("\n").map((l) => l.length))).toBeLessThanOrEqual(92);
  });

  it("returns undefined for an unknown step", () => {
    expect(renderExplanation("nope")).toBeUndefined();
  });
});
