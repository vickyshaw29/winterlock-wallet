// The example Snap in MetaMask's own Snap simulator (@metamask/snaps-jest): the pipeline core signs inside a Snap,
// its one journal survives between requests in snap_manageState, concurrent requests get distinct leaves, only the
// allowed origin may call it, a reinstall gets a new tree, and the whole send path runs there.
// Written with Claude Code (AI) for Vicky.
const { installSnap } = require("@metamask/snaps-jest");

const ORIGIN = "http://127.0.0.1:15190"; // the one origin snap.manifest.json allows
const before = (events, a, b) => {
  const i = events.findIndex(a), j = events.findIndex(b);
  expect(i).toBeGreaterThanOrEqual(0);
  expect(j).toBeGreaterThanOrEqual(0);
  expect(i).toBeLessThan(j);
};
const result = async (request, method, origin = ORIGIN) => {
  const { response } = await request({ method, origin });
  if (response.error) throw new Error(`${method}: ${JSON.stringify(response.error)}`);
  return response.result;
};

describe("the pipeline core inside a MetaMask Snap", () => {
  it("signs two-pass with a tree from snap_getEntropy, journals in snap_manageState, and sends", async () => {
    const { request } = await installSnap();

    const first = await result(request, "winterlock_sign");
    expect(first).toMatchObject({
      leaf: 1, nonceKey: "0x1", entryLength: 2594, expectedEntryLength: 2594, verified: true, prefixBudget: "95100",
      journal: ["1:burned"], globals: { process: "undefined", Buffer: "undefined", require: "undefined" },
    });
    expect(first.chainSteps).toBeLessThanOrEqual(first.maxSteps);
    before(first.events, (e) => e.includes("1:reserved"), (e) => e === "sign leaf 1");

    const second = await result(request, "winterlock_sign");
    expect(second).toMatchObject({ leaf: 2, verified: true, journal: ["1:burned", "2:burned"], root: first.root }); // the journal was kept

    const sent = await result(request, "winterlock_send");
    expect(sent).toMatchObject({ outcome: "OnChain", leaf: 3, nonceKey: "0x3", admission: "included: 1 of 1 rules passed" });
    expect(sent.journal).toEqual(["1:burned", "2:burned", "3:onchain"]);
    before(sent.events, (e) => e.includes("3:reserved"), (e) => e === "sign leaf 3");
    before(sent.events, (e) => e.includes("3:submitted"), (e) => e === "send key 0x3");
  });

  it("gives concurrent requests distinct leaves (one journal, one request at a time)", async () => {
    const { request } = await installSnap();
    const [a, b] = await Promise.all([result(request, "winterlock_sign"), result(request, "winterlock_sign")]);
    expect([a.leaf, b.leaf].sort()).toEqual([1, 2]);
    expect(a.sigHash).not.toBe(b.sigHash);
    const [s, c] = await Promise.all([result(request, "winterlock_send"), result(request, "winterlock_sign")]);
    expect([s.leaf, c.leaf].sort()).toEqual([3, 4]);
  });

  it("lets only the one allowed origin call it (MetaMask's own check, on our manifest)", () => {
    // The simulator does not enforce endowment:rpc origins; MetaMask's SnapController does, with this function.
    const { isOriginAllowed } = require("@metamask/snaps-utils");
    const origins = require("../snap.manifest.json").initialPermissions["endowment:rpc"];
    expect(isOriginAllowed(origins, "website", ORIGIN)).toBe(true);
    expect(isOriginAllowed(origins, "website", "https://example.com")).toBe(false);
    expect(isOriginAllowed(origins, "snap", "npm:some-other-snap")).toBe(false);
  });

  it("gives a new install a new tree, so a reinstall never re-signs the old tree's leaves", async () => {
    const a = await result((await installSnap()).request, "winterlock_sign");
    const b = await result((await installSnap()).request, "winterlock_sign");
    expect([a.leaf, b.leaf]).toEqual([1, 1]);
    expect(a.root).not.toBe(b.root);
  });
});
