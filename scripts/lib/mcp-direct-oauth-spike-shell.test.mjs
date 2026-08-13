import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";

const script = new URL("../run-mcp-direct-oauth-spike.sh", import.meta.url).pathname;

test("dry run emits a direct HTTP case without static authorization", () => {
  const output = execFileSync("bash", [script, "--agent", "codex", "--mode", "interactive", "--dry-run"], { encoding: "utf8" });
  const plan = JSON.parse(output);
  assert.equal(plan.direct_http, true);
  assert.equal(plan.static_authorization_header, false);
  assert.equal(plan.hold_seconds, 620);
});

test("client credentials refuses an implicit generic secret mapping", () => {
  const result = spawnSync("bash", [script, "--agent", "gemini", "--mode", "client-credentials", "--phase", "session", "--dry-run"], {
    encoding: "utf8",
    env: { ...process.env, CHEERS_SPIKE_AGENT_ENV_JSON: "" },
  });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /documented credential provider/);
});

test("invalid matrix values fail before side effects", () => {
  const result = spawnSync("bash", [script, "--agent", "unknown", "--mode", "interactive", "--dry-run"], { encoding: "utf8" });
  assert.equal(result.status, 2);
});

test("matrix dry run describes all eight isolated cases", () => {
  const matrix = new URL("../run-mcp-direct-oauth-matrix.sh", import.meta.url).pathname;
  const result = spawnSync("bash", [matrix, "--dry-run"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim().split("\n").length, 8);
  assert.match(result.stderr, /codex \/ interactive/);
  assert.match(result.stderr, /opencode \/ client-credentials/);
});
