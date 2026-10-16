import { expect, test, type Page } from "@playwright/test";

// UI smoke test against a running stack (API + Vite). No credentials live in
// the repo: pass them in the environment, e.g.
//   E2E_USER=… E2E_PASSWORD=… E2E_ADMIN_USER=… E2E_ADMIN_PASSWORD=… pnpm test:smoke
// Tests that need an account are skipped when it is not set.
const USER = process.env.E2E_USER;
const PASSWORD = process.env.E2E_PASSWORD;
const ADMIN = process.env.E2E_ADMIN_USER;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;

const pageErrors: string[] = [];

test.beforeEach(async ({ page, context }) => {
  pageErrors.length = 0;
  await context.addInitScript(() => {
    try {
      localStorage.setItem("i18nextLng", "en-US");
    } catch {
      /* storage blocked */
    }
  });
  page.on("pageerror", (e) => pageErrors.push(e.message));
});

test.afterEach(() => {
  expect(pageErrors, "uncaught errors in the page").toEqual([]);
});

async function login(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel(/Email/).fill(email);
  await page.getByLabel(/Password/).fill(password);
  await page.getByRole("button", { name: "Log In" }).click();
  await page.waitForURL(/\/(dashboard)?$/, { timeout: 15_000 });
}

test("login page renders", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Log In" })).toBeVisible();
});

test.describe("signed in as a user", () => {
  test.skip(!USER || !PASSWORD, "E2E_USER / E2E_PASSWORD not set");

  test("wrong password shows an error, right one opens the dashboard", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel(/Email/).fill(USER!);
    await page.getByLabel(/Password/).fill("definitely-not-the-password");
    await page.getByRole("button", { name: "Log In" }).click();
    await expect(page.getByRole("alert")).toBeVisible();

    await page.getByLabel(/Password/).fill(PASSWORD!);
    await page.getByRole("button", { name: "Log In" }).click();
    await page.waitForURL(/\/(dashboard)?$/, { timeout: 15_000 });
  });

  test("dashboard shows the stat cards and the memo table", async ({ page }) => {
    await login(page, USER!, PASSWORD!);
    if (!/dashboard/.test(page.url())) await page.goto("/dashboard");
    await expect(page.getByRole("heading", { name: "Approvals Management" })).toBeVisible();
    const cards = page.locator("button[aria-pressed]").filter({ has: page.locator(".tabular-nums") });
    await expect(cards).toHaveCount(8);
    await expect(page.locator("table thead th").first()).toBeVisible();
  });

  test("notification bell opens and closes with Escape", async ({ page }) => {
    await login(page, USER!, PASSWORD!);
    const bell = page.getByRole("button", { name: "Notifications" });
    await bell.click();
    await expect(bell).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Escape");
    await expect(bell).not.toHaveAttribute("aria-pressed", "true");
  });

  test("profile page renders", async ({ page }) => {
    await login(page, USER!, PASSWORD!);
    await page.goto("/profile");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });
});

test.describe("signed in as an admin", () => {
  test.skip(!ADMIN || !ADMIN_PASSWORD, "E2E_ADMIN_USER / E2E_ADMIN_PASSWORD not set");

  const pages: [route: string, heading: RegExp][] = [
    ["/user", /User Management/],
    ["/department", /Department Management/],
    ["/business-units", /Business Unit Management/],
    ["/cc-groups", /CC Groups/],
    ["/memotype-manager", /Memo Type Management/],
    ["/approver-lines", /LOA Management/],
  ];

  for (const [route, heading] of pages) {
    test(`${route} renders its header and table`, async ({ page }) => {
      await login(page, ADMIN!, ADMIN_PASSWORD!);
      await page.goto(route);
      await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
      await expect(page.getByRole("button", { name: /View Log/ })).toBeVisible();
      await expect(page.locator("table.ui-table").first()).toBeVisible();
    });
  }
});
