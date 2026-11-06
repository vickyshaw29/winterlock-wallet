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

const ORIGIN = "http://localhost:5173";
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
    const permissions = require("../snap.manifest.json").initialPermissions;
    for (const permission of ["endowment:rpc", "endowment:keyring"]) {
      const origins = permissions[permission];
      expect(isOriginAllowed(origins, "website", "http://localhost:5173")).toBe(true);
      expect(isOriginAllowed(origins, "website", "http://127.0.0.1:5173")).toBe(true);
      expect(isOriginAllowed(origins, "website", "http://localhost:15190")).toBe(true); // the Snap's page, site/
      expect(isOriginAllowed(origins, "website", "http://127.0.0.1:15190")).toBe(true);
      expect(isOriginAllowed(origins, "website", "http://localhost:15191")).toBe(false);
      expect(isOriginAllowed(origins, "website", "https://example.com")).toBe(false);
      expect(isOriginAllowed(origins, "snap", "npm:some-other-snap")).toBe(false);
    }
  });
});

describe("the Winterlock Snap as a MetaMask account (ERC-4337 envelope, Nov 6)", () => {
  const FEES = { maxFeePerGas: "0xee6b2800", maxPriorityFeePerGas: "0xb2d05e00" }; // 4 gwei, 3 gwei tip
  let n = 0;
  const reqId = () => `6f9c1d2e-0b7a-4c3d-8e5f-${String(++n).padStart(12, "0")}`;

  async function keyringCall(snap, origin, method, params) {
    const { response } = await snap.onKeyringRequest({ origin, method, ...(params ? { params } : {}) });
    if (response.error) throw new Error(`${method}: ${JSON.stringify(response.error)}`);
    return response.result;
  }
  /** What MetaMask sends: keyring_submitRequest for the account, from origin "metamask". */
  async function submit(snap, account, method, params) {
    const r = await keyringCall(snap, "metamask", "keyring_submitRequest", {
      id: reqId(), scope: "eip155:1337", account: account.id, origin: "metamask", request: { method, params },
    });
    expect(r.pending).toBe(false);
    return r.result;
  }
  async function withMetaMaskAccount() {
    const s = await withAccount();
    const account = await keyringCall(s, ORIGIN, "keyring_createAccount", { options: {} });
    return { ...s, account };
  }
  const userOp = (account, prepared, fees = FEES) => ({
    sender: account.address, nonce: prepared.nonce, initCode: prepared.initCode, callData: prepared.callData,
    callGasLimit: prepared.gasLimits.callGasLimit, verificationGasLimit: prepared.gasLimits.verificationGasLimit,
    preVerificationGas: prepared.gasLimits.preVerificationGas, ...fees, paymasterAndData: "0x", signature: prepared.dummySignature,
  });
  const ENTRY = "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789";
  const statusOf = async (s, leaf) => (await call(s.request, "winterlock_status")).leaves.find((l) => l.leaf === leaf);

  it("the page may add the account to MetaMask, as an ERC-4337 account; only MetaMask may ask it to sign", async () => {
    const s = await withMetaMaskAccount();
    expect(s.account).toMatchObject({ type: "eip155:erc4337", address: s.used.account, scopes: ["eip155:1337"] });
    expect(s.account.methods).toEqual(["eth_prepareUserOperation", "eth_patchUserOperation", "eth_signUserOperation"]);
    await expect(keyringCall(s, ORIGIN, "keyring_createAccount", { options: {} })).rejects.toThrow(/already in MetaMask/);
    expect(await keyringCall(s, "metamask", "keyring_listAccounts")).toEqual([s.account]);
    const asPage = { id: reqId(), scope: "eip155:1337", account: s.account.id, origin: ORIGIN, request: { method: "eth_prepareUserOperation", params: [{ to: TO, value: "0x3e8", data: "0x" }] } };
    await expect(keyringCall(s, ORIGIN, "keyring_submitRequest", asPage)).rejects.toThrow(/may not call keyring_submitRequest/);
    await expect(keyringCall(s, "https://example.com", "keyring_listAccounts")).rejects.toThrow(/may not call/);
    expect(await keyringCall(s, "http://localhost:15190", "keyring_listAccounts")).toEqual([s.account]);
    await expect(keyringCall(s, "metamask", "keyring_createAccount", { options: {} })).rejects.toThrow(/may not call/);
  });

  it("the page may also add the account through winterlock_addToMetaMask, once", async () => {
    const s = await withAccount();
    const account = await call(s.request, "winterlock_addToMetaMask");
    expect(account).toMatchObject({ type: "eip155:erc4337", address: s.used.account, scopes: ["eip155:1337"] });
    await expect(call(s.request, "winterlock_addToMetaMask")).rejects.toThrow(/already in MetaMask/);
    expect(await keyringCall(s, "metamask", "keyring_listAccounts")).toEqual([account]);
  });

  it("prepare reserves a fresh leaf and names the bundler; sign signs it once, at the user's fees", async () => {
    const s = await withMetaMaskAccount();
    const prepared = await submit(s, s.account, "eth_prepareUserOperation", [{ to: TO, value: "0x3e8", data: "0x" }]);
    expect(prepared).toMatchObject({ nonce: "0x10000000000000000", initCode: "0x", bundlerUrl: "http://127.0.0.1:15192/rpc", dummyPaymasterAndData: "0x" });
    expect(prepared.callData.startsWith("0x574c0001")).toBe(true);
    expect(await statusOf(s, 1)).toMatchObject({ status: "reserved", via: "MetaMask" });
    expect(await submit(s, s.account, "eth_patchUserOperation", [userOp(s.account, prepared)])).toEqual({ paymasterAndData: "0x" });
    const decoded = await submit(s, s.account, "eth_decodeUserOperationCallData", [prepared.callData]);
    expect(decoded).toEqual([{ to: TO, value: "0x3e8", data: "0x" }]);

    const op = userOp(s.account, prepared);
    const raw = await submit(s, s.account, "eth_signUserOperation", [op]); // what MetaMask sends: the user operation alone
    expect(raw).toMatch(/^0x06[0-9a-f]+$/);
    expect(raw.length).toBeGreaterThan(2 * 2594);
    const lane = await statusOf(s, 1);
    expect(lane).toMatchObject({ status: "submitted", via: "MetaMask" });
    expect(lane.txHash).toMatch(/^0x[0-9a-f]{64}$/);

    // The same user operation again, or another fee on the same leaf: never a second signature.
    await expect(submit(s, s.account, "eth_signUserOperation", [op, ENTRY])).rejects.toThrow(/is submitted: this Snap signs a prepared leaf once/);
    await expect(submit(s, s.account, "eth_signUserOperation", [{ ...op, maxFeePerGas: "0x12a05f200" }, ENTRY])).rejects.toThrow(/signs a prepared leaf once/);
    // A second prepare gets the next leaf.
    const next = await submit(s, s.account, "eth_prepareUserOperation", [{ to: TO, value: "0x1", data: "0x" }]);
    expect(next.nonce).toBe("0x20000000000000000");
  });

  it("signs nothing for a user operation it did not prepare, below the tip floor, or for another account", async () => {
    const s = await withMetaMaskAccount();
    const prepared = await submit(s, s.account, "eth_prepareUserOperation", [{ to: TO, value: "0x3e8", data: "0x" }]);
    const op = userOp(s.account, prepared);
    const other = "0x000000000000000000000000000000000000dEaD";
    const cases = [
      [{ ...op, callData: `0x574c0001${prepared.callData.slice(10).replace(TO.slice(2), other.slice(2).toLowerCase())}` }, /not the one this Snap prepared/],
      [{ ...op, preVerificationGas: "0x1" }, /not the one this Snap prepared/],
      [{ ...op, maxPriorityFeePerGas: "0x3b9aca00" }, /below the devnet's 3000000000 wei tip floor/],
      [{ ...op, maxFeePerGas: "0x1", maxPriorityFeePerGas: "0xb2d05e00" }, /below maxPriorityFeePerGas/],
      [{ ...op, sender: other }, /not this Snap's account/],
      [{ ...op, nonce: "0x50000000000000000" }, /was never prepared/],
      [{ ...op, nonce: "0x10000000000000001" }, /sequence must be 0/],
    ];
    for (const [bad, why] of cases) await expect(submit(s, s.account, "eth_signUserOperation", [bad, ENTRY])).rejects.toThrow(why);
    await expect(submit(s, s.account, "eth_signUserOperation", [op, "0x0000000000000000000000000000000000000001"])).rejects.toThrow(/entry point/);
    // Nothing signed: the prepared leaf is still reserved, and signs fine with the right fees.
    expect(await statusOf(s, 1)).toMatchObject({ status: "reserved" });
    expect(await submit(s, s.account, "eth_signUserOperation", [op, ENTRY])).toMatch(/^0x06/);
  });

  it("refuses a send to itself or above the balance with no leaf used, and a lane its gas cannot pay with nothing signed", async () => {
    const s = await withMetaMaskAccount(); // the stand-in chain gives the account 1 ETH
    await expect(submit(s, s.account, "eth_prepareUserOperation", [{ to: s.account.address, value: "0x1", data: "0x" }])).rejects.toThrow(/admin call/);
    await expect(submit(s, s.account, "eth_prepareUserOperation", [{ to: TO, value: "0x1bc16d674ec80000", data: "0x" }])).rejects.toThrow(/No leaf was used/);
    expect((await call(s.request, "winterlock_status")).leaves).toEqual([]);
    // 1 ETH fits before gas, so prepare reserves; at sign the gas does not fit beside it: nothing signs.
    const prepared = await submit(s, s.account, "eth_prepareUserOperation", [{ to: TO, value: "0xde0b6b3a7640000", data: "0x" }]);
    await expect(submit(s, s.account, "eth_signUserOperation", [userOp(s.account, prepared), ENTRY])).rejects.toThrow(/can cost up to .* Nothing was signed/);
    expect(await statusOf(s, 1)).toMatchObject({ status: "reserved", via: "MetaMask" });
  });
});
