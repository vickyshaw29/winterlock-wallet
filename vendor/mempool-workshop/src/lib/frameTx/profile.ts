/** The devnet this workshop talks to, as `@forshtat/hegota-support` describes it. Every call into the library names it. */
import { getProfile } from "@forshtat/hegota-support/profiles";

export const profile = getProfile("ethrex-eip8141-tracer");
