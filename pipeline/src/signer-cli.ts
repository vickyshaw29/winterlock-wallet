// The hash-based signer that shells out to the Rust CLI (Node and Bun only: it spawns a process and reads the seed
// file). Moved out of signer.ts on Nov 6 so the browser- and Snap-safe core holds no process code.
import type { Hex } from "viem";
import { HashSignerError, type HashSigner } from "./signer.ts";

/**
 * Shell-out to the hashsig CLI's `sign` (plan, interface 4). The seed goes in through PQ_SEED, which
 * both the spec and the plan accept, so it never appears as an argument.
 * VERIFY against the published CLI: the --chains format (comma-separated here) and the output fields.
 */
export function cliHashSigner(opts: { bin: string; seedFile: string; height: number; generation: number; treeSeed: Hex; chains: bigint[] }): HashSigner {
  return {
    height: opts.height, generation: opts.generation, treeSeed: opts.treeSeed,
    async sign({ chainId, leaf, msg }) {
      const seed = (await Bun.file(opts.seedFile).text()).trim();
      const proc = Bun.spawn(
        [opts.bin, "sign", "--height", String(opts.height), "--generation", String(opts.generation),
          "--chains", opts.chains.join(","), "--chain-id", String(chainId), "--leaf", String(leaf), "--msg", msg],
        { env: { ...process.env, PQ_SEED: seed }, stdout: "pipe", stderr: "pipe" },
      );
      const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      if (code !== 0) {
        let parsed: { error?: string; detail?: string } = {};
        try { parsed = JSON.parse(err); } catch { /* not JSON */ }
        throw new HashSignerError(parsed.error ?? `exit_${code}`, parsed.detail ?? err.trim());
      }
      const res = JSON.parse(out) as { leaf: number; entry: Hex };
      if (res.leaf !== leaf) throw new HashSignerError("leaf_mismatch", `asked for leaf ${leaf}, CLI signed ${res.leaf}`);
      return res.entry;
    },
  };
}
