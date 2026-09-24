import { describe, expect, it } from "vitest";
import { buildRendererDocument, rendererCsp, summarize } from "./SandboxRenderer";
import type { RendererExtension } from "./rendererExtension";

const mockExtension: RendererExtension = {
  extensionId: "test-ext",
  title: "Test Extension",
  version: "1.0.0",
  assets: {
    "dist/renderer.js": "console.log('renderer active');",
    "dist/style.css": ".custom-theme { color: red; }",
  },
  manifest: {
    manifest_version: 1,
    id: "test-ext",
    title: "Test Extension",
    version: "1.0.0",
    description: "For testing sandbox inspector and form submission",
    renderers: [
      {
        id: "test-renderer",
        title: "Test Renderer",
        matches: ["*.yaml", "*.json"],
        entry: "dist/renderer.js",
        style: "dist/style.css",
      },
    ],
    permissions: {
      "file.write": true,
    },
  },
};

describe("SandboxRenderer document & bridge", () => {
  it("generates CSP with proper nonce and strict sandbox rules", () => {
    const csp = rendererCsp(undefined, "testnonce123");
    expect(csp).toContain("script-src 'nonce-testnonce123'");
    expect(csp).toContain("style-src 'nonce-testnonce123'");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("connect-src 'none'");
  });

  it("buildRendererDocument injects inspector styles and overlay", () => {
    const html = buildRendererDocument(mockExtension, "test-renderer");
    expect(html).toContain("cheers-inspector-overlay");
    expect(html).toContain("cheers-inspector-badge");
    expect(html).toContain("inspector.toggle");
    expect(html).toContain("inspector.inspect");
  });

  it("buildRendererDocument injects form and action submission methods", () => {
    const html = buildRendererDocument(mockExtension, "test-renderer");
    expect(html).toContain("form.submit");
    expect(html).toContain("action.trigger");
    expect(html).toContain("submit(formData, actionId = \"submit\")");
    expect(html).toContain("trigger(actionId, payload = {})");
  });

  it("summarize formats action parameters cleanly", () => {
    const summary = summarize({
      action: "deploy",
      replicas: 3,
      enabled: true,
      service: "gateway",
    });
    expect(summary).toContain("action=\"deploy\"");
    expect(summary).toContain("replicas=3");
    expect(summary).toContain("enabled=true");
    expect(summary).toContain("service=\"gateway\"");
  });
});
