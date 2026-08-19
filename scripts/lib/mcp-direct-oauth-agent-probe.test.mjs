import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  agentCommand,
  classifyFailure,
  oauthUrls,
  parseCommand,
  providerAuthMethod,
  redact,
} from "../mcp-direct-oauth-agent-probe.mjs";
import { redactFile } from "../redact-mcp-oauth-spike-evidence.mjs";

test("redact removes OAuth and host credentials", () => {
  const value = redact({
    access_token: "secret-access",
    code: -32601,
    nested: "Bearer abc.def.ghi",
    url: "https://example.test/callback?code=one&state=ok",
    form: "refresh_token=refresh-me&code_verifier=verify-me",
    host: "agbi_super-secret",
    message: "Enter ABCD-EFGHI to continue",
  });
  assert.equal(value.access_token, "[REDACTED]");
  assert.equal(value.code, -32601);
  assert.equal(value.nested, "Bearer [REDACTED]");
  assert.equal(value.url, "https://example.test/callback?code=[REDACTED]&state=[REDACTED]");
  assert.equal(value.form, "refresh_token=[REDACTED]&code_verifier=[REDACTED]");
  assert.equal(value.host, "agbi_[REDACTED]");
  assert.equal(value.message, "Enter [REDACTED-DEVICE-CODE] to continue");
});

test("failure classification distinguishes compatibility from harness failures", () => {
  assert.equal(
    classifyFailure({ http_capability: false, failure: "Agent does not advertise HTTP MCP capability" }),
    "missing_http_capability",
  );
  assert.equal(
    classifyFailure({ http_capability: true, failure: "permission denied opening ~/.codex/state.sqlite" }),
    "harness_environment_failure",
  );
  assert.equal(
    classifyFailure({ http_capability: true, failure: "CIMD client metadata must use public HTTPS" }),
    "cimd_incompatible",
  );
});

test("oauthUrls returns unique redacted authorization URLs", () => {
  assert.deepEqual(
    oauthUrls("open https://auth.example/oauth/authorize?code=secret twice https://auth.example/oauth/authorize?code=secret"),
    ["https://auth.example/oauth/authorize?code=[REDACTED]"],
  );
});

test("registry commands are pinned", () => {
  assert.deepEqual(agentCommand("codex"), ["npx", "-y", "@agentclientprotocol/codex-acp@1.2.0"]);
  assert.deepEqual(agentCommand("claude"), ["npx", "-y", "@agentclientprotocol/claude-agent-acp@0.66.0"]);
  assert.deepEqual(agentCommand("gemini"), ["npx", "-y", "@google/gemini-cli@0.55.1", "--acp"]);
  assert.deepEqual(agentCommand("opencode"), ["npx", "-y", "opencode-ai@1.18.18", "acp"]);
});

test("command overrides must be non-empty string arrays", () => {
  assert.deepEqual(parseCommand("codex", '["custom","acp"]'), ["custom", "acp"]);
  assert.throws(() => parseCommand("codex", "[]"));
  assert.throws(() => parseCommand("codex", '["ok",1]'));
});

test("provider auth prefers an ACP-visible Codex device-code flow", () => {
  assert.equal(
    providerAuthMethod({
      authMethods: [
        { id: "api-key" },
        { id: "chat-gpt" },
        { id: "chat-gpt-device-code" },
      ],
    }).id,
    "chat-gpt-device-code",
  );
  assert.equal(providerAuthMethod({ authMethods: [{ id: "chat-gpt" }] }).id, "chat-gpt");
  assert.equal(providerAuthMethod({ authMethods: [{ id: "api-key" }] }), null);
});

test("redactFile sanitizes retained text evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cheers-oauth-redact-"));
  const path = join(directory, "gateway.log");
  try {
    await writeFile(path, "Authorization: Bearer abc.def refresh_token=very-secret agbi_raw\n");
    await redactFile(path);
    const contents = await readFile(path, "utf8");
    assert.equal(contents, "Authorization: Bearer [REDACTED] refresh_token=[REDACTED] agbi_[REDACTED]\n");
  } finally {
    await rm(directory, { recursive: true });
  }
});
