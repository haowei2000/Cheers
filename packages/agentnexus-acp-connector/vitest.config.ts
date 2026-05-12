import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@haowei0520/bridge-client": `${here}../agentnexus-bridge-client/src/index.ts`,
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 10_000,
  },
});
