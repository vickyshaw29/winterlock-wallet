// Production React behavior through the guarded server, real backend and throwaway fake chain.
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
const TARGET = "0x5544596212F91984C986A919C8026DF0576816f9";
let wallet: string;
test.beforeEach(async ({ request }) => {
  const response = await request.post("/api/wallets", {
    data: {
      height: 6,
      hotStart: 32,
      spendLimitWei: "1000000000000000",
      allowedTarget: TARGET,
    },
  });
  expect(response.ok()).toBeTruthy();
  wallet = (await response.json()).address;
});
const path = (screen = "hot-cold", extra = "") =>
  `/${screen}.html?wallet=${wallet}&theme=light${extra}`;
async function cut(page: Page, count = 10) {
  expect(
    (
      await page.request.post(`/api/wallets/${wallet}/tickets`, {
        data: { count },
      })
    ).ok(),
  ).toBeTruthy();
}
async function go(page: Page, screen = "hot-cold", extra = "") {
  await page.goto(path(screen, extra));
  await expect(page.locator("h1")).toBeVisible();
}
async function activity(page: Page) {
  const tab = page.getByRole("tab", { name: "Activity", exact: true });
  if (await tab.isVisible()) await tab.click();
}

test("single payment, exact wei, duplicate-submit fence, receipt and keyboard inspector", async ({
  page,
}) => {
  await cut(page);
  await go(page);
  await page.locator("#pay-amount").fill("0.000000000000000001");
  const posts: unknown[] = [];
  page.on("request", (req) => {
    if (req.method() === "POST" && req.url().endsWith("/send"))
      posts.push(req.postDataJSON());
  });
  await page.locator("#pay-form").evaluate((form) => {
    (form as HTMLFormElement).requestSubmit();
    (form as HTMLFormElement).requestSubmit();
  });
  await expect(
    page.getByRole("status", { name: "Latest payment" }),
  ).toContainText("included");
  expect(posts).toEqual([
    { to: TARGET, valueWei: "1", mode: "hot", mempool: "alt" },
  ]);
  await expect(page.locator("#phone-pane .count")).toContainText("9");
  await page.locator(".lane-inspect").first().focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("dialog")).toContainText("Admission report");
  await page.keyboard.press("Escape");
  await expect(page.locator(".lane-inspect").first()).toBeFocused();
});

test("wallet creation validates inputs, omits optional defaults and opens the new account", async ({
  page,
}) => {
  await go(page, "index");
  await page.getByText("Key tree settings", { exact: true }).click();
  await page.getByLabel("Tree height", { exact: true }).fill("6");
  await page.getByLabel("Value cap, ETH", { exact: true }).fill("0.001");
  const submitted = page.waitForRequest(
    (req) => req.method() === "POST" && req.url().endsWith("/api/wallets"),
  );
  await page
    .getByRole("button", { name: "Create wallet", exact: true })
    .click();
  expect((await submitted).postDataJSON()).toEqual({
    height: 6,
    spendLimitWei: "1000000000000000",
  });
  await expect(page.locator("h1")).toHaveText("Hot and cold");
  await expect(page).toHaveURL(/wallet=0x/);
  expect(new URL(page.url()).searchParams.get("wallet")).not.toBe(wallet);
});

test("an unknown requested wallet never silently selects another account", async ({
  page,
}) => {
  await page.goto(
    "/hot-cold.html?wallet=0x0000000000000000000000000000000000000001",
  );
  await expect(page.getByRole("alert").first()).toContainText("unknown_wallet");
  await expect(page.locator("#pay")).toHaveCount(0);
});

test("inline cap validation, presets and cold offline separation", async ({
  page,
}) => {
  await cut(page);
  await go(page);
  await page.locator("#pay-amount").fill("1");
  await expect(page.locator("#pay-problem")).toContainText(
    "above the hot value cap",
  );
  await expect(page.locator("#pay")).toBeDisabled();
  await page.getByRole("button", { name: "Full cap", exact: true }).click();
  await expect(page.locator("#pay-amount")).toHaveValue("0.001");
  await page.getByLabel("Offline", { exact: true }).check();
  await expect(
    page.getByRole("button", { name: "Cut tickets", exact: true }),
  ).toBeDisabled();
  await expect(page.locator("#pay")).toBeEnabled();
});

test("cold transfer and policy stay explicit, rotation waits for confirmation and inclusion", async ({
  page,
}) => {
  await go(page);
  await page.locator("#fold-transfer > summary").click();
  await page
    .locator("#fold-transfer")
    .getByLabel("To", { exact: true })
    .fill(TARGET);
  await page
    .locator("#fold-transfer")
    .getByLabel("Amount, ETH", { exact: true })
    .fill("0.0001");
  await page
    .getByRole("button", { name: "Send from cold", exact: true })
    .click();
  await expect(page.locator("#lanes")).toContainText("included");
  await page.locator("#fold-policy > summary").click();
  await page
    .locator("#fold-policy")
    .getByLabel("Value cap, ETH", { exact: true })
    .fill("0.002");
  await page.getByRole("button", { name: "Set policy", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/wallets/${wallet}`)).json())
          .hotValueCapWei,
    )
    .toBe("2000000000000000");
  await page.locator("#fold-rotate > summary").click();
  await page.getByRole("button", { name: "Rotate root", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "invalidates every pending lane",
  );
  expect(
    (await (await page.request.get(`/api/wallets/${wallet}`)).json()).epoch,
  ).toBe(0);
  await page
    .getByRole("button", { name: "Confirm rotation", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/wallets/${wallet}`)).json()).epoch,
    )
    .toBe(1);
});

test("stuck attempt expires and retries once on a fresh leaf", async ({
  page,
}) => {
  await cut(page);
  await go(page);
  await page
    .getByRole("button", { name: "Payment details", exact: true })
    .click();
  await page.getByText("Expiry and retry", { exact: true }).click();
  await page
    .getByRole("button", { name: "Simulate stuck payment", exact: true })
    .click();
  await page.keyboard.press("Escape");
  await expect
    .poll(
      async () => {
        const rows = await (
          await page.request.get(`/api/wallets/${wallet}/txs`)
        ).json();
        return rows.some((r: any) => r.status === "Expired" && r.retriedAs);
      },
      { timeout: 12_000 },
    )
    .toBeTruthy();
  const rows = await (
    await page.request.get(`/api/wallets/${wallet}/txs`)
  ).json();
  const expired = rows.find((r: any) => r.status === "Expired");
  const retry = rows.find((r: any) => r.retryOf === expired.txHash);
  expect(retry.leaf).not.toBe(expired.leaf);
  expect(rows).toHaveLength(2);
});

test("agent fires four concurrent tranches and preserves both account refusals", async ({
  page,
}) => {
  await cut(page, 20);
  await go(page, "agent");
  await page
    .getByRole("button", { name: "Fire 4 tranches", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (
          await (await page.request.get(`/api/wallets/${wallet}/txs`)).json()
        ).filter((r: any) => r.status === "OnChain").length,
    )
    .toBe(4);
  await page.getByText("Test policy enforcement", { exact: true }).click();
  await page
    .getByRole("button", { name: "Server compromised", exact: true })
    .click();
  await expect(page.locator("#lanes")).toContainText("exceeds value cap");
  await expect(page.locator("#lanes")).toContainText("target not allowed");
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/wallets/${wallet}`)).json())
          .tickets.left,
    )
    .toBe(14);
});

test("armed mock rule fires once, and stays disarmed across polling", async ({
  page,
}) => {
  await cut(page, 20);
  await go(page, "agent");
  await page.getByLabel("Rule armed", { exact: true }).check();
  await page.getByText("Mock market", { exact: true }).click();
  await page
    .getByRole("button", { name: "Drop the mock price 3 %", exact: true })
    .click();
  await expect(
    page.getByLabel("Rule armed", { exact: true }),
  ).not.toBeChecked();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/wallets/${wallet}/txs`)).json())
          .length,
    )
    .toBe(4);
  await page.waitForTimeout(2200);
  expect(
    (await (await page.request.get(`/api/wallets/${wallet}/txs`)).json())
      .length,
  ).toBe(4);
});

test("mobile grant navigates to dapp, session action sends exactly zero wei without calldata", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await go(page, "session");
  await page
    .getByRole("button", { name: "Grant 20 tickets", exact: true })
    .click();
  await expect(
    page.getByRole("tab", { name: "Dapp", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  const request = page.waitForRequest(
    (req) => req.method() === "POST" && req.url().endsWith("/send"),
  );
  await page.getByRole("button", { name: "Move A1", exact: true }).click();
  expect((await request).postDataJSON()).toEqual({
    to: TARGET,
    valueWei: "0",
    mode: "hot",
    mempool: "alt",
  });
  await expect(
    page.getByRole("button", { name: /Move A1, included/ }),
  ).toHaveAttribute("data-state", "included");
});

test("different dapp cells can submit together while each cell submits only once", async ({
  page,
}) => {
  await cut(page);
  await go(page, "session");
  const sends: unknown[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith("/send"))
      sends.push(r.postDataJSON());
  });
  await page.locator(".cell").evaluateAll((nodes) => {
    (nodes[0] as HTMLButtonElement).click();
    (nodes[0] as HTMLButtonElement).click();
    (nodes[1] as HTMLButtonElement).click();
  });
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/wallets/${wallet}/txs`)).json())
          .length,
    )
    .toBe(2);
  expect(sends).toHaveLength(2);
});

test("mobile task navigation preserves drafts and browser history", async ({
  page,
}) => {
  await cut(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await go(page);
  await page.locator("#pay-amount").fill("0.00042");
  const cold = page.getByRole("tab", { name: "Cold device", exact: true });
  await cold.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("tab", { name: "Activity", exact: true }),
  ).toBeFocused();
  await expect(page.locator("#lanes")).toHaveJSProperty("clientHeight", 320);
  await page.goBack();
  await expect(cold).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "Pay", exact: true }).click();
  await expect(page.locator("#pay-amount")).toHaveValue("0.00042");
});

test("session scene submits eight distinct zero-value lanes and decline cuts nothing", async ({
  page,
}) => {
  await go(page, "session");
  await page.getByRole("button", { name: "Decline", exact: true }).click();
  expect(
    (await (await page.request.get(`/api/wallets/${wallet}`)).json()).tickets
      .exported,
  ).toBe(0);
  await page.getByText("Grant session tickets", { exact: true }).click();
  await page
    .getByRole("button", { name: "Grant 20 tickets", exact: true })
    .click();
  await page.getByRole("button", { name: "Play scene", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/wallets/${wallet}/txs`)).json())
          .length,
    )
    .toBe(8);
  const records = await (
    await page.request.get(`/api/wallets/${wallet}/txs`)
  ).json();
  expect(new Set(records.map((r: any) => r.leaf)).size).toBe(8);
  expect(
    records.every((r: any) => r.valueWei === "0" && r.mode === "hot"),
  ).toBeTruthy();
});

test("lost-device response disables hot signing and cutting immediately, then recovers", async ({
  page,
}) => {
  await cut(page);
  let broken = false;
  await page.route(`**/api/wallets/${wallet}/send`, async (route) => {
    broken = true;
    await route.fulfill({
      status: 409,
      json: {
        error: "device_unusable",
        detail: "ticket journal cannot be opened",
      },
    });
  });
  await page.route(`**/api/wallets/${wallet}`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    if (broken)
      body.tickets = { ...body.tickets, left: 0, used: 0, unjournaled: 10 };
    await route.fulfill({ response, json: body });
  });
  await go(page);
  await page.locator("#pay").click();
  await expect(page.locator("#phone-pane")).toContainText("recover it");
  await expect(page.locator("#pay")).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Cut tickets", exact: true }),
  ).toBeDisabled();
  broken = false;
  await page.unroute(`**/api/wallets/${wallet}/send`);
  await page.reload();
  await expect(page.locator("#pay")).toBeEnabled();
});

test("503 disables signing while read-only history remains available; fresh status recovers", async ({
  page,
}) => {
  await cut(page);
  let stalled = false;
  await page.route("**/api/status", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: { ...(await response.json()), stalled },
    });
  });
  await page.route(`**/api/wallets/${wallet}/send`, async (route) => {
    stalled = true;
    await route.fulfill({
      status: 503,
      json: { error: "chain_stalled", detail: "latest block is old" },
    });
  });
  await go(page);
  await page.locator("#pay").click();
  await expect(page.getByRole("alert")).toContainText("stalled");
  await expect(page.locator("#pay")).toBeDisabled();
  await expect(page.locator("#lanes")).toBeVisible();
  stalled = false;
  await page.unroute(`**/api/wallets/${wallet}/send`);
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.locator("#pay")).toBeEnabled();
});

test("a failed member of a burst is retained with the other three results", async ({
  page,
}) => {
  await cut(page, 20);
  let count = 0;
  await page.route(`**/api/wallets/${wallet}/send`, async (route) => {
    count++;
    if (count === 2)
      await route.fulfill({
        status: 422,
        json: {
          error: "refused",
          detail: "controlled refusal",
          simulation: { violations: ["account: hot: value cap"] },
        },
      });
    else await route.continue();
  });
  await go(page, "agent");
  await page
    .getByRole("button", { name: "Fire 4 tranches", exact: true })
    .click();
  await expect(page.locator(".notice-line")).toContainText(
    "3 of 4 tranches admitted",
  );
  await expect(page.locator("#agent-log")).toContainText("controlled refusal");
  expect(count).toBe(4);
});

for (const width of [375, 768, 1440])
  for (const theme of ["light", "dark"])
    test(`all screens: ${width}px ${theme}, no overflow, accessible controls and local resources`, async ({
      page,
    }) => {
      await cut(page);
      await page.setViewportSize({ width, height: 900 });
      const errors: string[] = [];
      const external: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (m) => {
        if (m.type() === "error") errors.push(m.text());
      });
      page.on("request", (req) => {
        if (!req.url().startsWith("http://127.0.0.1:5190"))
          external.push(req.url());
      });
      for (const screen of ["index", "hot-cold", "agent", "session"]) {
        await page.goto(`/${screen}.html?wallet=${wallet}&theme=${theme}`);
        await expect(page.locator("h1")).toBeVisible();
        await page.evaluate(() => document.fonts.ready);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBeTruthy();
        if (width < 1000 && screen !== "index") {
          for (const tab of await page.getByRole("tab").all()) {
            await tab.click();
            const scan = await new AxeBuilder({ page }).analyze();
            expect(
              scan.violations.map((v) => ({
                id: v.id,
                nodes: v.nodes.map((n) => n.target),
              })),
            ).toEqual([]);
          }
        }
        if (screen !== "index") {
          await activity(page);
          await expect(page.locator("#lanes")).toHaveJSProperty(
            "clientHeight",
            320,
          );
        }
        const result = await new AxeBuilder({ page }).analyze();
        expect(
          result.violations.map((v) => ({
            id: v.id,
            nodes: v.nodes.map((n) => n.target),
          })),
        ).toEqual([]);
        if (screen === "hot-cold") {
          if (width < 1000)
            await page.getByRole("tab", { name: "Pay", exact: true }).click();
          await page
            .getByRole("button", { name: "Payment details", exact: true })
            .click();
          await expect(page.getByRole("dialog")).toBeVisible();
          expect(
            (await new AxeBuilder({ page }).analyze()).violations.map((v) => ({
              id: v.id,
              nodes: v.nodes.map((n) => ({
                target: n.target,
                failure: n.failureSummary,
              })),
            })),
          ).toEqual([]);
          await page.keyboard.press("Escape");
        }
      }
      expect(errors).toEqual([]);
      expect(external).toEqual([]);
    });

test("production routes and proxy keep CSP, host/origin guard, body limit and missing-asset 404s", async ({
  request,
}) => {
  for (const url of [
    "/",
    "/index.html",
    "/hot-cold.html",
    "/agent.html",
    "/session.html",
  ]) {
    const res = await request.get(url);
    expect(res.ok()).toBeTruthy();
    expect(res.headers()["content-security-policy"]).toContain(
      "script-src 'self'",
    );
    expect(res.headers()["content-security-policy"]).not.toContain(
      "unsafe-inline",
    );
  }
  for (const url of ["/missing.js", "/serve.ts", "/src/main.tsx"])
    expect((await request.get(url)).status()).toBe(404);
  expect(
    (
      await request.get("/api/wallets", {
        headers: { origin: "https://attacker.example" },
      })
    ).status(),
  ).toBe(403);
  expect(
    (
      await request.get("/api/wallets", {
        headers: { host: "attacker.example:5190" },
      })
    ).status(),
  ).toBe(403);
  expect(
    (await request.post("/api/wallets", { data: "x".repeat(65537) })).status(),
  ).toBe(400);
});
