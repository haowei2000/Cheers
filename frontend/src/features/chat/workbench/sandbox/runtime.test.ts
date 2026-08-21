import { describe, expect, it } from "vitest";
import { buildRendererDocument, rendererCsp } from "./SandboxRenderer";

describe("renderer CSP", () => {
  it("blocks network by default", () => {
    const csp = rendererCsp(undefined, "nonce");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("form-action 'none'");
  });

  it("opens transport and media, but never external scripts", () => {
    const csp = rendererCsp("unrestricted", "nonce");
    expect(csp).toContain("connect-src http: https: ws: wss:");
    expect(csp).toContain("script-src 'nonce-nonce'");
    expect(csp).not.toContain("script-src http:");
  });
});

describe("renderer document", () => {
  it("separates host reset CSS from extension CSS", () => {
    const document = buildRendererDocument({
      extensionId: "example",
      title: "Example",
      manifest: { renderers: [{ id: "demo", title: "Demo", entry: "renderers/demo.js", style: "renderers/demo.css" }] },
      assets: { "renderers/demo.js": "globalThis.CheersWorkbenchRenderer={activate(){}}", "renderers/demo.css": ".demo{color:red}" },
    }, "demo");
    expect(document).toContain("margin:0;}\n.demo{color:red}");
    expect(document).toContain("automation.create");
    expect(document).toContain("context.pick");
    expect(document).toContain("Renderer must implement toContext(target)");
    expect(document).toContain("lifecycle.dispose");
  });
});
