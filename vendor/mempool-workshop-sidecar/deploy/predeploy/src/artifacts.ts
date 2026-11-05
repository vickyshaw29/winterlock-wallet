import fs from "node:fs";
import path from "node:path";
import type { ArtifactStore, Hex, TxArtifact } from "./types";

/** Stores each fetched transaction at <dir>/<protocol>/<hash>.json. */
export class FileArtifactStore implements ArtifactStore {
  constructor(private readonly dir: string) {}

  private file(protocol: string, hash: Hex): string {
    return path.join(this.dir, protocol, `${hash}.json`);
  }

  read(protocol: string, hash: Hex): TxArtifact {
    const file = this.file(protocol, hash);
    if (!fs.existsSync(file)) {
      throw new Error(
        `missing artifact ${file}. Run \`bun run predeploy fetch ${protocol}\` (needs ETHERSCAN_API_KEY).`
      );
    }
    return JSON.parse(fs.readFileSync(file, "utf8")) as TxArtifact;
  }

  write(protocol: string, artifact: TxArtifact): void {
    const file = this.file(protocol, artifact.hash);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(artifact, null, 2)}\n`);
  }
}
