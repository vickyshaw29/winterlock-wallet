import { describe, expect, it } from "vitest";
import { StepError, executeStep, formatFailure } from "../../src/lib/output.js";

describe("output", () => {
  it("formatFailure has code, rule and hint", () => {
    const out = JSON.parse(formatFailure(new StepError("RPC_UNREACHABLE", "no route", { rule: "NET", hint: "check URL" }), true));
    expect(out).toMatchObject({ ok: false, code: "RPC_UNREACHABLE", rule: "NET", hint: "check URL" });
  });

  it("executeStep --json success writes exactly one JSON line to stdout and logs go to stderr", async () => {
    const r = await executeStep("step_x", async (ctx) => {
      ctx.log("progress line");
      return { summary: "done", data: { a: 1 } };
    }, ["--json"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, step: "step_x", a: 1 });
    expect(r.stderr).toContain("progress line");
  });

  it("executeStep --json failure is valid JSON with exit code 1", async () => {
    const r = await executeStep("step_x", async () => { throw new StepError("BOOM", "bad", { hint: "h" }); }, ["--json"]);
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, code: "BOOM", hint: "h" });
  });

  it("an unexpected error becomes a JSON error, not a stack trace on stdout", async () => {
    const r = await executeStep("step_x", async () => { throw new Error("oops"); }, ["--json"]);
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, code: "UNEXPECTED", message: "oops" });
  });

  it("a result with ok:false exits 1 (expected outcome not reached)", async () => {
    const r = await executeStep("step_x", async () => ({ summary: "tx was accepted", ok: false, hint: "run step 7", data: {} }), ["--json"]);
    expect(r.exitCode).toBe(1);
  });

  it("parses --fresh", async () => {
    let fresh = false;
    await executeStep("step_x", async (ctx) => { fresh = ctx.fresh; return { summary: "", data: {} }; }, ["--fresh"]);
    expect(fresh).toBe(true);
  });
});
