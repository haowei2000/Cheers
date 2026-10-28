import { defineConfig, devices } from "@playwright/test";
import { env } from "node:process";
import { fileURLToPath } from "node:url";

function isolatedOrigin(name: string): URL {
  const value = env[name];
  if (!value) throw new Error(`${name} must name the isolated E2E service`);
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    !url.port || url.username || url.password || url.pathname !== "/" ||
    url.search || url.hash
  ) {
    throw new Error(`${name} must be an HTTP loopback origin with an explicit port`);
  }
  return url;
}

const frontend = isolatedOrigin("INTEGRATION_BASE_URL");
const gateway = isolatedOrigin("E2E_GATEWAY_URL");
if (frontend.hostname !== "127.0.0.1") {
  throw new Error("INTEGRATION_BASE_URL must use 127.0.0.1 to match the Vite bind address");
}
if (frontend.origin === gateway.origin) {
  throw new Error("The isolated frontend and gateway must use different ports");
}

export default defineConfig({
  testDir: "./e2e",
  // Keep real browser scenarios out of Vitest's *.test/spec.ts discovery.
  testMatch: "**/*.e2e.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  globalTimeout: 180_000,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  outputDir: "./test-results",
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report", open: "never" }],
  ],
  use: {
    baseURL: frontend.origin,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    serviceWorkers: "block",
  },
  projects: [{
    name: "chromium",
    use: {
      ...devices["Desktop Chrome"],
      viewport: { width: 1440, height: 1000 },
      ...(env.E2E_BROWSER_CHANNEL ? { channel: env.E2E_BROWSER_CHANNEL } : {}),
    },
  }],
  webServer: {
    command: `pnpm exec vite --host 127.0.0.1 --port ${frontend.port} --strictPort`,
    cwd: fileURLToPath(new URL(".", import.meta.url)),
    url: `${frontend.origin}/login`,
    reuseExistingServer: false,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
    timeout: 180_000,
    env: {
      VITE_API_PROXY_TARGET: gateway.origin,
      VITE_WS_PROXY_TARGET: gateway.origin.replace(/^http:/, "ws:"),
      VITE_API_BASE_URL: "/api/v1",
      VITE_WS_BASE_URL: "",
      VITE_PUBLIC_BASE_PATH: "/",
    },
  },
});
