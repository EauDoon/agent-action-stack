import { defineConfig, devices } from "@playwright/test";

/**
 * Real browser workflow tests for the local GUI. Chromium only, to keep
 * browser downloads and caches bounded. The server is the real
 * orchestrator against the pinned component checkouts.
 */
const port = Number(process.env.AAS_BROWSER_PORT ?? 8799);

export default defineConfig({
  testDir: "./test/browser",
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "line" : "list",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    ...devices["Desktop Chrome"],
    viewport: { width: 1280, height: 900 },
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: {
    command: `node ./bin/aas-gui.mjs`,
    env: { AAS_GUI_PORT: String(port) },
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
