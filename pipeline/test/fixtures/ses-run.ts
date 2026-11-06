// Runs a browser bundle of sandbox-scenario.ts the way a MetaMask Snap runs: the realm locked down by SES, the code
// evaluated in a Compartment whose only extra globals are the ones a Snap gets (no process, Bun, require or Buffer).
// Prints the scenario's result as one JSON line. Its own process, because lockdown() freezes the whole realm.
//   bun test/fixtures/ses-run.ts <bundle.js>
// Written with Claude Code (AI) for Vicky.
import "ses";

const file = process.argv[2];
if (!file) throw new Error("usage: bun test/fixtures/ses-run.ts <bundle.js>");
const code = await Bun.file(file).text();

// Taming close to a Snap's (ses 2.x has dropped the date and math options).
lockdown({ consoleTaming: "unsafe", errorTaming: "unsafe", overrideTaming: "severe" });

// A Snap's endowments beyond the language's own intrinsics (fetch only with endowment:network-access; the scenario
// brings its own fake fetch, so none is given here). A bare compartment's Date.now() throws; a Snap gets a Date whose
// now() works (with a little noise added), so the start compartment's Date stands in for it.
const globals = {
  console, crypto, TextEncoder, TextDecoder, URL, atob, btoa, setTimeout, clearTimeout, setInterval, clearInterval,
  AbortController, AbortSignal, Date,
};
const compartment = new Compartment({ globals, __options__: true });
compartment.evaluate(code);
const run = (compartment.globalThis as { __winterlockScenario?: () => Promise<unknown> }).__winterlockScenario;
if (typeof run !== "function") throw new Error("the bundle did not define __winterlockScenario");
console.log(JSON.stringify(await run()));
