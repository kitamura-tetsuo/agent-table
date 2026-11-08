import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "test/e2e",
  retries: process.env.CI ? 2 : 0,
  use: {
    baseURL: "http://localhost:8787",
    browserName: "chromium",
  },
  webServer: {
    // Test-only admission switch; the committed Worker default remains disabled.
    command: "npm run dev -- --port 8787 --var ALLOW_NEW_GUESTS:true",
    url: "http://localhost:8787/health",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
