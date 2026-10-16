import { defineConfig, devices } from "@playwright/test";

// UI smoke test (e2e-smoke/). Runs against an already running stack; set
// E2E_BASE_URL to point somewhere other than the local Vite server.
export default defineConfig({
  testDir: "./e2e-smoke",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "line" : "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:5173",
    viewport: { width: 1440, height: 900 },
    locale: "en-US",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
});
