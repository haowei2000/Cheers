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
  const policiesIn = (source) => [...source.matchAll(/Content-Security-Policy\s+"([^"]+)"/g)].map(([, p]) => p);

  const surfaces = {
    // Shipped in the image and included by every nginx location.
    "frontend/security-headers.conf": policiesIn(await read("frontend/security-headers.conf")),
    // The chart renders its own copy into a ConfigMap.
    "deploy/helm/cheers/templates/frontend.yaml": policiesIn(
      await read("deploy/helm/cheers/templates/frontend.yaml"),
    ),
  };

  for (const [file, policies] of Object.entries(surfaces)) {
    assert.ok(policies.length > 0, `${file} has no CSP`);
    for (const policy of policies) {
      assert.match(policy, /script-src 'self'/, `${file} must restrict scripts to self`);
      assert.doesNotMatch(policy, /script-src[^;]*'unsafe-inline'/, `${file} permits inline scripts`);
    }
  }

  const [snippet] = surfaces["frontend/security-headers.conf"];
  for (const policy of surfaces["deploy/helm/cheers/templates/frontend.yaml"]) {
    assert.equal(policy, snippet, "the chart's CSP has drifted from frontend/security-headers.conf");
  }

  // nginx.conf no longer carries the policy, so make sure it still pulls it in;
  // a location that lost the include would silently serve no headers at all.
  const nginx = await read("frontend/nginx.conf");
  assert.doesNotMatch(nginx, /Content-Security-Policy/, "nginx.conf must not re-declare the policy");
  const locations = [...nginx.matchAll(/location\s[^{]*\{[^}]*\}/g)].map(([block]) => block);
  for (const block of locations.filter((block) => block.includes("add_header"))) {
    assert.match(
      block,
      /include \/etc\/nginx\/security-headers\.conf;/,
      `an nginx location sets add_header without including the security headers:\n${block}`,
    );
  }
});

test("nginx body limits follow the gateway's settings", async () => {
  const [gateway, image, values, nginx, chart] = await Promise.all(
    [
      "server/src/config.rs",
      "frontend/Dockerfile",
      "deploy/helm/cheers/values.yaml",
      "frontend/nginx.conf",
      "deploy/helm/cheers/templates/frontend.yaml",
    ].map(read),
  );
  const limits = [
    ["location /api", "MAX_REQUEST_BODY_MIB", "maxRequestBodyMib"],
    ["location = /mcp", "MCP_MAX_BODY_MIB", "mcpMaxBodyMib"],
  ];
  const blockOf = (config, location) => config.match(new RegExp(`${location} \\{[\\s\\S]*?proxy_pass`))?.[0] ?? "";
  for (const [location, env, value] of limits) {
    const fallback = gateway.match(new RegExp(`const DEFAULT_${env}: usize = (\\d+);`))?.[1];
    assert.ok(fallback, `server/src/config.rs has no default for ${env}`);
    assert.match(image, new RegExp(`\\b${env}=${fallback}\\b`), `frontend/Dockerfile: ${env} must default to ${fallback}`);
    assert.match(values, new RegExp(`\\b${value}: ${fallback}\\b`), `values.yaml: ${value} must default to ${fallback}`);
    assert.ok(
      blockOf(nginx, location).includes(`client_max_body_size \${${env}}m;`),
      `frontend/nginx.conf: ${location} must use ${env}`,
    );
    assert.ok(
      blockOf(chart, location).includes(`client_max_body_size {{ .Values.gateway.${value} }}m;`),
      `the chart's ${location} must use ${value}`,
    );
  }
});

test("desktop CSP rejects inline scripts", async () => {
  const config = JSON.parse(await read("apps/macos/src-tauri/tauri.conf.json"));
  const policy = config.app.security.csp;
  assert.match(policy, /script-src 'self'/);
  assert.doesNotMatch(policy, /script-src[^;]*'unsafe-inline'/);
});
