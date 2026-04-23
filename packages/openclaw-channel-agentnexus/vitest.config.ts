import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const stub = `${here}test/sdk-stubs.ts`;

export default defineConfig({
  resolve: {
    alias: {
      // OpenClaw SDK 在运行时由 CLI 的 node_modules 提供；测试里给最小空实现
      "openclaw/plugin-sdk/channel-core": stub,
      "openclaw/plugin-sdk/conversation-runtime": stub,
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
  },
});
