import { randomBytes } from "node:crypto";
import { defineConfig } from "@playwright/test";

// The local E2E Worker receives a fresh synthetic invitation key on each run.
// Actual deployments require a separately provisioned Workers secret.
const syntheticInvitationKeyring = JSON.stringify({
  current: {
    id: "playwright-ephemeral",
    key: randomBytes(32).toString("base64url"),
  },
  previous: [],
});

export default defineConfig({
  testDir: "test/e2e",
  retries: process.env.CI ? 2 : 0,
  use: {
    baseURL: "http://localhost:8787",
    browserName: "chromium",
  },
  webServer: {
    // Test-only admission switch; the committed Worker default remains disabled.
    command:
      "npm run dev -- --port 8787 --var ALLOW_NEW_GUESTS:true --var " +
      "'INVITATION_RESPONSE_KEYRING:" +
      syntheticInvitationKeyring +
      "'",
    url: "http://localhost:8787/health",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
