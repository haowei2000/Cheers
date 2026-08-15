import { describe, expect, it } from "vitest";
import { rendererCsp } from "./SandboxRenderer";

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
