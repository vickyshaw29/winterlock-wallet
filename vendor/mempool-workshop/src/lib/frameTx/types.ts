// The transaction types and the codec come from @forshtat/hegota-support; this file keeps the names the workshop uses.
import { profile } from "./profile.js";

export type { Frame, FrameTx as FrameTransaction, SignatureEntry } from "@forshtat/hegota-support/tx";

/** The frame modes of the devnet, by name. */
export const FRAME_MODE = profile.frameModes as { readonly DEFAULT: number; readonly VERIFY: number; readonly SENDER: number };
