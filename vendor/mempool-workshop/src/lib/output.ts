import { StepError } from "./stepError.js";
import { renderExplanation } from "./explain.js";
import { gated } from "./progress.js";

export { StepError };

export interface Result {
  summary: string;
  data: Record<string, unknown>;
  /** false = the expected outcome was NOT reached (exit 1). Defaults to true. */
  ok?: boolean;
  hint?: string;
}

export interface StepContext {
  json: boolean;
  fresh: boolean;
  args: string[];
  /** Progress goes to stderr so `--json` stdout stays one JSON object. */
  log: (line: string) => void;
}

export function formatFailure(err: StepError, json: boolean): string {
  if (json) {
    return JSON.stringify({ ok: false, code: err.code, rule: err.rule ?? null, hint: err.hint ?? null, message: err.message });
  }
  const lines = [`FAILED [${err.code}] ${err.message}`];
  if (err.rule) lines.push(`  rule: ${err.rule}`);
  if (err.hint) lines.push(`  hint: ${err.hint}`);
  return lines.join("\n");
}

export interface ExecutedStep {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Runs a step and renders its result. Pure with respect to process I/O, so it can be tested. */
export async function executeStep(
  name: string,
  fn: (ctx: StepContext) => Promise<Result>,
  argv: string[]
): Promise<ExecutedStep> {
  const json = argv.includes("--json");
  const fresh = argv.includes("--fresh");
  const args = argv.filter((a) => !a.startsWith("--"));
  const stderr: string[] = [];
  const ctx: StepContext = { json, fresh, args, log: (l) => stderr.push(l) };
  try {
    const r = await fn(ctx);
    const ok = r.ok !== false;
    const stdout = json
      ? JSON.stringify({ ok, step: name, summary: r.summary, ...(!ok && r.hint ? { hint: r.hint } : {}), ...r.data })
      : [r.summary, ...(!ok && r.hint ? [`hint: ${r.hint}`] : [])].join("\n");
    return { exitCode: ok ? 0 : 1, stdout, stderr: stderr.join("\n") };
  } catch (e) {
    const err = e instanceof StepError ? e : new StepError("UNEXPECTED", e instanceof Error ? e.message : String(e));
    return { exitCode: 1, stdout: formatFailure(err, json), stderr: stderr.join("\n") };
  }
}

export async function runStep(name: string, fn: (ctx: StepContext) => Promise<Result>): Promise<never> {
  const argv = process.argv.slice(2);
  const json = argv.includes("--json");
  // Stream progress to stderr live instead of buffering until the end.
  const live = (l: string) => process.stderr.write(l + "\n");
  const explanation = json ? undefined : renderExplanation(name);
  // Printed after the order check, so a refused step does not explain itself first.
  const r = await executeStep(name, gated(name, (ctx) => { if (explanation) live(explanation); return fn({ ...ctx, log: live }); }), argv);
  process.stdout.write(r.stdout + "\n");
  process.exit(r.exitCode);
}
