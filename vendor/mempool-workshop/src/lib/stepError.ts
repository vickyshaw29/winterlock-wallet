export class StepError extends Error {
  code: string;
  rule?: string;
  hint?: string;
  constructor(code: string, message: string, opts: { rule?: string; hint?: string } = {}) {
    super(message);
    this.code = code;
    this.rule = opts.rule;
    this.hint = opts.hint;
  }
}
