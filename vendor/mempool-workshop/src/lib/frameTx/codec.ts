// @forshtat/hegota-support does the encoding; these bind it to this devnet's profile.
import type { Hex } from "viem";
import * as lib from "@forshtat/hegota-support/tx";
import { profile } from "./profile.js";

export const computeSigHash = (tx: lib.FrameTx): Hex => lib.sigHash(profile, tx);
/** `0x06 || rlp(payload)`: the canonical wire bytes, what `eth_sendRawTransaction` takes. */
export const encodeRawFrameTx = (tx: lib.FrameTx): Hex => lib.encodeTx(profile, tx);
/** Inverse of `encodeRawFrameTx`. */
export const decodeFrameTx = (raw: Hex): lib.FrameTx => lib.decodeTx(profile, raw);
