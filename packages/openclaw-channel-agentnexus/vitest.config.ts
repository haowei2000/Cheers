import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const stub = `${here}test/sdk-stubs.ts`;

export default defineConfig({
  resolve: {
    alias: {
      // The OpenClaw SDK is provided by the CLI node_modules at runtime; tests use a minimal stub.
      "openclaw/plugin-sdk/channel-core": stub,
      "openclaw/plugin-sdk/conversation-runtime": stub,
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
  },
});
