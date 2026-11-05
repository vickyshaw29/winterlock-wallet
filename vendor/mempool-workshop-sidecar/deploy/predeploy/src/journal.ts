import fs from "node:fs";
import path from "node:path";
import type { JournalFile, JournalStore } from "./types";

/** Stores the address map and step journal for a chain at <dir>/<chainId>.json. */
export class FileJournalStore implements JournalStore {
  constructor(private readonly dir: string) {}

  private file(chainId: number): string {
    return path.join(this.dir, `${chainId}.json`);
  }

  load(chainId: number): JournalFile {
    const file = this.file(chainId);
    if (!fs.existsSync(file)) return { chainId, protocols: {} };
    return JSON.parse(fs.readFileSync(file, "utf8")) as JournalFile;
  }

  save(journal: JournalFile): void {
    const file = this.file(journal.chainId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Write beside the target, then rename: a crash mid-write cannot leave a truncated journal.
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(journal, null, 2)}\n`);
    fs.renameSync(temporary, file);
  }
}
