import { mergeConfig } from "vitest/config";
import base from "./vitest.config";
export default mergeConfig(base, {
  define: {
    __OPERATOR_BRIDGE__: JSON.stringify(process.env.OPERATOR_BRIDGE ?? ""),
  },
  test: { testTimeout: 30000 },
});
