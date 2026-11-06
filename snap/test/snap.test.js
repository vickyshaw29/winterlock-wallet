// The Winterlock Snap in MetaMask's own Snap simulator (@metamask/snaps-jest), on a bundle built with
// WL_SNAP_FAKE_CHAIN=1 (src/fake-chain.ts), so nothing reaches the devnet. It checks: the tree comes from the Snap's
// entropy and a reinstall gets a new one; the account is used only once the chain shows our proxy and root; a send
// shows its confirmation first, a reject spends no leaf, an approve answers at submission and its lane is then followed
// to OnChain; only the page's origins may call it. Written with Claude Code (AI) for Vicky.
const fs = require("fs");
const path = require("path");
const snapsJest = require("@metamask/snaps-jest");

/**
 * Every install first checks that dist/bundle.js is the stand-in-chain build (npm test builds it), so a test can never
 * reach the devnet: a devnet bundle (from mm-snap build or a running mm-snap watch) lacks the mark.
 */
async function installSnap() {
  const bundle = fs.readFileSync(path.join(__dirname, "../dist/bundle.js"), "utf8");
  if (!bundle.includes("the Winterlock stand-in chain")) {
    throw new Error("dist/bundle.js is not the stand-in-chain build: stop mm-snap watch and run npm test, never jest alone");
  }
  return snapsJest.installSnap();
}

const ORIGIN = "http://localhost:15190";
const OWNER = "0x00000000000000000000000000000000000e0a01";
const TO = "0x000000000000000000000000000000000000beef";

async function call(request, method, params) {
  const { response } = await request({ method, ...(params ? { params } : {}), origin: ORIGIN });
  if (response.error) throw new Error(`${method}: ${JSON.stringify(response.error)}`);
  return response.result;
}

/** The send's confirmation dialog, or the error the Snap answered before showing one (getInterface alone would wait forever). */
async function dialogOf(pending) {
  const first = await Promise.race([pending.getInterface().then((ui) => ({ ui })), pending.then((r) => ({ r }))]);
  if (first.r) throw new Error(`no dialog: ${JSON.stringify(first.r.response.error ?? first.r.response.result).slice(0, 600)}`);
  return first.ui;
}

async function withAccount() {
  const snap = await installSnap();
  const tree = await call(snap.request, "winterlock_getAccount");
  const prepared = await call(snap.request, "winterlock_prepareAccount", { owner: OWNER });
  const used = await call(snap.request, "winterlock_useAccount", { address: prepared.address });
  return { ...snap, tree, prepared, used };
}

describe("the Winterlock Snap", () => {
  it("builds its tree from its own entropy, and hands out the factory call for the EOA", async () => {
    const { request } = await installSnap();
    const a = await call(request, "winterlock_getAccount");
    expect(a).toMatchObject({ chainId: "1337", height: 10, account: null, balanceWei: null, factory: "0xe7227c802ea370f04ae533827041c89dc5a4e659" });
    expect(a.root).toMatch(/^0x[0-9a-f]{64}$/);
    const p = await call(request, "winterlock_prepareAccount", { owner: OWNER });
    expect(p.factory).toBe(a.factory);
    expect(p.data.startsWith("0x")).toBe(true);
    expect(p.data).toContain(a.root.slice(2)); // createAccount carries our root
    expect(p.address).toMatch(/^0x[0-9a-f]{40}$/);
    const b = await call((await installSnap()).request, "winterlock_getAccount");
    expect(b.root).not.toBe(a.root); // a reinstall gets a new tree
  });

  it("refuses an account it did not prepare, and sends nothing before an account is set", async () => {
    const { request } = await installSnap();
    await call(request, "winterlock_prepareAccount", { owner: OWNER });
    await expect(call(request, "winterlock_useAccount", { address: TO })).rejects.toThrow(/not the account this Snap prepared/);
    await expect(call(request, "winterlock_send", { to: TO, valueWei: "1000" })).rejects.toThrow(/no account yet/);
  });

  it("spends no leaf when the user rejects the confirmation", async () => {
    const { request } = await withAccount();
    const pending = request({ method: "winterlock_send", params: { to: TO, valueWei: "1000" }, origin: ORIGIN });
    const ui = await dialogOf(pending);
    expect(ui.type).toBe("confirmation");
    await ui.cancel();
    const { response } = await pending;
    expect(response.error.code).toBe(4001);
    expect((await call(request, "winterlock_status")).leaves).toEqual([]);
  });

  it("answers at submission after the user approves, then follows the lane to OnChain", async () => {
    const { request, used } = await withAccount();
    expect(used.balanceWei).toBe("1000000000000000000");
    const pending = request({ method: "winterlock_send", params: { to: TO, valueWei: "1000" }, origin: ORIGIN });
    const ui = await dialogOf(pending);
    expect(ui.type).toBe("confirmation");
    await ui.ok();
    const { response } = await pending;
    expect(response.error).toBeUndefined();
    expect(response.result).toMatchObject({ status: "Submitted", leaf: 1, nonceKey: "0x1" });
    expect(response.result.explorerUrl).toMatch(/^https:\/\/explorer\.altmempool\.wtf\/tx\/0x/);
    let s;
    for (let i = 0; i < 60; i++) {
      s = await call(request, "winterlock_status");
      if (s.leaves[0]?.status === "onchain") break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(s.leaves[0]).toMatchObject({ leaf: 1, status: "onchain", outcome: "OnChain" });
  });

  it("refuses a send the account cannot pay before the dialog, with no leaf used", async () => {
    const { request } = await withAccount(); // the stand-in chain gives the account 1 ETH
    const { response } = await request({ method: "winterlock_send", params: { to: TO, valueWei: "1000000000000000000" }, origin: ORIGIN });
    expect(response.error.message).toMatch(/can cost up to .* Fund it first\. No leaf was used\./);
    expect((await call(request, "winterlock_status")).leaves).toEqual([]);
  });

  it("gives back-to-back sends distinct leaves, each confirmed in its own dialog", async () => {
    const { request } = await withAccount();
    for (const leaf of [1, 2]) {
      const pending = request({ method: "winterlock_send", params: { to: TO, valueWei: "1000" }, origin: ORIGIN });
      const ui = await dialogOf(pending);
      await ui.ok();
      const { response } = await pending;
      if (!response.result) throw new Error(`send ${leaf}: ${JSON.stringify(response.error).slice(0, 600)}`);
      expect(response.result).toMatchObject({ status: "Submitted", leaf, nonceKey: `0x${leaf}` });
    }
    const s = await call(request, "winterlock_status");
    expect(s.leaves.map((l) => l.leaf)).toEqual([2, 1]); // newest first
    expect(s.unsettled).toEqual([]);
  });

  it("lets only the page's origins call it (MetaMask's own check, on our manifest)", () => {
    const { isOriginAllowed } = require("@metamask/snaps-utils");
    const origins = require("../snap.manifest.json").initialPermissions["endowment:rpc"];
    expect(isOriginAllowed(origins, "website", "http://localhost:15190")).toBe(true);
    expect(isOriginAllowed(origins, "website", "http://127.0.0.1:15190")).toBe(true);
    expect(isOriginAllowed(origins, "website", "https://example.com")).toBe(false);
    expect(isOriginAllowed(origins, "snap", "npm:some-other-snap")).toBe(false);
  });
});
