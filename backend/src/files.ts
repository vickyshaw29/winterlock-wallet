// Durable JSON writes and a small lock, shared by the wallet records and the transaction store.
// Written with Claude Code (AI) for Vicky.
import fs from "node:fs";
import path from "node:path";

/** Unique temp file, full write, fsync, rename, fsync of the directory: a reader sees the old file or the new one. */
export function writeJsonAtomic(file: string, data: unknown, mode = 0o600): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  const fd = fs.openSync(tmp, "wx", mode);
  try {
    fs.writeFileSync(fd, JSON.stringify(data, null, 2) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  const dfd = fs.openSync(dir, "r");
  try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
}

/** Runs one task at a time, in order of arrival; a failed task does not block the next. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
