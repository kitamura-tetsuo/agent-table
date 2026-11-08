import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "test/e2e",
  retries: process.env.CI ? 2 : 0,
  use: {
    baseURL: "http://127.0.0.1:8787",
    browserName: "chromium",
  },
  webServer: {
    command: "npm run dev -- --port 8787",
    url: "http://127.0.0.1:8787/health",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
