import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const read = (relativePath) => readFile(path.join(root, relativePath), "utf8");

test("frontend startup contains no inline scripts", async () => {
  const html = await read("frontend/index.html");
  const scriptTags = [...html.matchAll(/<script\b([^>]*)>/gi)];
  assert.ok(scriptTags.length > 0, "expected frontend scripts");
  for (const [, attributes] of scriptTags) {
    assert.match(attributes, /\bsrc\s*=/i, `inline script violates strict CSP: ${attributes}`);
  }
  assert.match(html, /src="\/theme-bootstrap\.js"/);
});

test("web deployment CSPs reject inline scripts", async () => {
  for (const file of [
    "frontend/nginx.conf",
    "deploy/helm/cheers/templates/frontend.yaml",
  ]) {
    const source = await read(file);
    const policies = [...source.matchAll(/Content-Security-Policy\s+"([^"]+)"/g)];
    assert.ok(policies.length > 0, `${file} has no CSP`);
    for (const [, policy] of policies) {
      assert.match(policy, /script-src 'self'/, `${file} must restrict scripts to self`);
      assert.doesNotMatch(policy, /script-src[^;]*'unsafe-inline'/, `${file} permits inline scripts`);
    }
  }
});

test("desktop CSP rejects inline scripts", async () => {
  const config = JSON.parse(await read("apps/macos/src-tauri/tauri.conf.json"));
  const policy = config.app.security.csp;
  assert.match(policy, /script-src 'self'/);
  assert.doesNotMatch(policy, /script-src[^;]*'unsafe-inline'/);
});
