import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// The generated restore candidate is the real Workerd runtime configuration.
// No fetch-time environment overrides or test-only Durable Object receivers.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: "./test/fixtures/quarantined-restore-generated.json",
      },
    }),
  ],
  test: {
    include: ["test/recovery-runtime/**/*.test.ts"],
    testTimeout: 15_000,
  },
});
