import { describe, expect, it } from "vitest";
import { formatOf, candidatesFor } from "../renderers/registry";
import { buildArtifactHtml } from "./ArtifactLens";

describe("ArtifactLens format & registry matching", () => {
  it("formatOf correctly identifies .html, .htm, .tsx, .jsx", () => {
    expect(formatOf("index.html")).toBe("html");
    expect(formatOf("dev/preview.htm")).toBe("html");
    expect(formatOf("src/Widget.tsx")).toBe("react");
    expect(formatOf("components/Button.jsx")).toBe("react");
  });

  it("candidatesFor suggests builtin:html for HTML files", () => {
    const candidates = candidatesFor("page.html", "<div>Hello</div>", []);
    expect(candidates.some((r) => r.id === "builtin:html")).toBe(true);
    expect(candidates[0].id).toBe("builtin:html");
  });

  it("candidatesFor suggests builtin:react for TSX files", () => {
    const candidates = candidatesFor("Card.tsx", "export default function Card() { return <div>Card</div>; }", []);
    expect(candidates.some((r) => r.id === "builtin:react")).toBe(true);
    expect(candidates[0].id).toBe("builtin:react");
  });
});

describe("buildArtifactHtml", () => {
  it("wraps HTML snippets in a complete document with tailwind, inspector and bridge", () => {
    const html = buildArtifactHtml("<button class='btn'>Click</button>", "html");
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("tailwindcss.com");
    expect(html).toContain("cheers-inspector-overlay");
    expect(html).toContain("CheersBridge");
    expect(html).toContain("<button class='btn'>Click</button>");
  });

  it("injects inspector and bridge into full HTML documents without breaking markup", () => {
    const raw = `<!DOCTYPE html><html><head><title>Test</title></head><body><h1>Hi</h1></body></html>`;
    const html = buildArtifactHtml(raw, "html");
    expect(html).toContain("<title>Test</title>");
    expect(html).toContain("cheers-inspector-overlay");
    expect(html).toContain("CheersBridge");
  });

  it("wraps React TSX components with Babel, React, ReactDOM, and mount code", () => {
    const tsxCode = `
      import React, { useState } from 'react';
      export default function Counter() {
        const [n, setN] = useState(0);
        return <button onClick={() => setN(n + 1)}>Count: {n}</button>;
      }
    `;
    const html = buildArtifactHtml(tsxCode, "react");
    expect(html).toContain("react@18");
    expect(html).toContain("@babel/standalone");
    expect(html).toContain("cheers-inspector-overlay");
    expect(html).toContain("CheersBridge");
    expect(html).toContain("window.__CHEERS_ROOT_COMPONENT__");
  });
});
