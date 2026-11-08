import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  test: {
    include: ["test/{unit,integration}/**/*.test.ts"],
    onUnhandledError(error) {
      // Cloudflare's Vitest bridge also emits a duplicate unhandled rejection
      // when a Durable Object constructor rejects an RPC call. The test itself
      // must still assert that the binding rejects on a future schema version.
      // See https://github.com/cloudflare/workers-sdk/issues/14736.
      if (
        error.name === "UnsupportedApplicationSchemaError" &&
        /^Application schema version 999 is newer than supported 1$/.test(
          error.message,
        )
      ) {
        return false;
      }
    },
  },
});
