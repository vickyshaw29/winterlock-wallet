import type { Address, Hex, PatchSpec } from "./types";

const WORD_HEX_CHARS = 64;
const ZERO_PREFIX = "0".repeat(24);

export interface RewriteResult {
  data: Hex;
  /** Number of words replaced with a devnet address. */
  replaced: number;
  /** Address-looking words that had no mapping (left unchanged). A warning, not an error. */
  unmapped: Address[];
}

/**
 * Maps mainnet addresses to the devnet addresses their replays produced, and
 * rewrites ABI-encoded data accordingly.
 *
 * Only whole 32-byte words are inspected (12 zero bytes followed by a 20-byte
 * address). That is exactly how ABI encoding places an address, and it keeps
 * the rewrite from touching bytes inside code or packed data.
 */
export class AddressMap {
  private readonly map = new Map<string, Address>();

  constructor(entries: Record<string, Address> = {}) {
    for (const [mainnet, devnet] of Object.entries(entries)) {
      this.map.set(mainnet.toLowerCase(), devnet);
    }
  }

  set(mainnet: Address, devnet: Address): void {
    this.map.set(mainnet.toLowerCase(), devnet);
  }

  get(mainnet: Address): Address | undefined {
    return this.map.get(mainnet.toLowerCase());
  }

  toJSON(): Record<string, Address> {
    return Object.fromEntries(this.map);
  }

  rewrite(data: Hex): RewriteResult {
    const body = data.slice(2);
    if (body.length % WORD_HEX_CHARS !== 0) {
      throw new Error(
        `cannot rewrite ${body.length / 2} bytes: not a whole number of 32-byte words`
      );
    }
    let out = "";
    let replaced = 0;
    const unmapped = new Set<Address>();
    for (let i = 0; i < body.length; i += WORD_HEX_CHARS) {
      const word = body.slice(i, i + WORD_HEX_CHARS);
      if (!word.startsWith(ZERO_PREFIX)) {
        out += word;
        continue;
      }
      const address = `0x${word.slice(24).toLowerCase()}` as Address;
      const devnet = this.map.get(address);
      if (devnet) {
        out += ZERO_PREFIX + devnet.slice(2).toLowerCase();
        replaced++;
        continue;
      }
      // Heuristic for the warning only: a value >= 2^152 (first address byte
      // non-zero) is almost certainly an address, not a number. Addresses that
      // start with a zero byte (vanity addresses) are not flagged.
      if (word.slice(24, 26) !== "00") unmapped.add(address);
      out += word;
    }
    return { data: `0x${out}` as Hex, replaced, unmapped: [...unmapped] };
  }

  /**
   * Replaces literal occurrences of a mainnet address's 20 raw bytes within creation init code
   * with wherever this run deployed it on the devnet. Distinct from `rewrite()`: that only ever
   * touches 32-byte ABI-encoded constructor-argument words; this touches raw init-code bytes for
   * an address baked in as a bytecode-level constant, which never appears as a clean 32-byte
   * word. Each patch's target must already have a devnet mapping - deploy it in an earlier step
   * first - and its expected occurrence count must match exactly, so a typo'd count can never
   * silently under- or over-patch.
   */
  patch(initCode: Hex, patches: readonly PatchSpec[]): Hex {
    let body = initCode.slice(2).toLowerCase();
    for (const spec of patches) {
      const devnet = this.map.get(spec.find.toLowerCase());
      if (!devnet) {
        throw new Error(`no devnet mapping for ${spec.find}: deploy it in an earlier step first`);
      }
      const needle = spec.find.slice(2).toLowerCase();
      const occurrences = body.split(needle).length - 1;
      if (occurrences !== spec.count) {
        throw new Error(
          `expected ${spec.count} occurrences of ${spec.find} in init code, found ${occurrences}`
        );
      }
      body = body.split(needle).join(devnet.slice(2).toLowerCase());
    }
    return `0x${body}` as Hex;
  }
}
