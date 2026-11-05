import type { Hex, TxArtifact } from "./types";

const WORD_HEX_CHARS = 64;

/** Splits a creation input into init code and constructor arguments. */
export function splitCreation(
  artifact: Pick<TxArtifact, "input" | "constructorArgs">
): { initCode: Hex; args: Hex } {
  const input = artifact.input.slice(2);
  const args = artifact.constructorArgs.slice(2);
  if (args.length > input.length || !input.toLowerCase().endsWith(args.toLowerCase())) {
    throw new Error("constructorArgs is not a suffix of the creation input");
  }
  return {
    initCode: `0x${input.slice(0, input.length - args.length)}` as Hex,
    args: artifact.constructorArgs,
  };
}

/** Big-endian 32-byte word for an unsigned integer. */
export function uintWord(value: bigint): Hex {
  if (value < 0n) throw new Error("uintWord: negative value");
  const hex = value.toString(16);
  if (hex.length > WORD_HEX_CHARS) throw new Error("uintWord: value does not fit in 32 bytes");
  return `0x${hex.padStart(WORD_HEX_CHARS, "0")}` as Hex;
}

/** Replaces 32-byte words of constructor arguments by word index. */
export function applyArgWords(args: Hex, words: Record<number, Hex> | undefined): Hex {
  if (!words) return args;
  let body = args.slice(2);
  for (const [key, word] of Object.entries(words)) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0) {
      throw new Error(`argWords key "${key}" must be a non-negative integer`);
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(word)) {
      throw new Error(`argWords[${index}] must be a 32-byte hex word`);
    }
    const start = index * WORD_HEX_CHARS;
    if (start + WORD_HEX_CHARS > body.length) {
      throw new Error(
        `argWords[${index}] is outside the ${body.length / 2}-byte constructor arguments`
      );
    }
    body = body.slice(0, start) + word.slice(2).toLowerCase() + body.slice(start + WORD_HEX_CHARS);
  }
  return `0x${body}` as Hex;
}
