import { describe, expect, it } from "vitest";
import { formatOf, candidatesFor } from "../renderers/registry";
import { artifactCsp, buildArtifactHtml } from "./ArtifactLens";
import { compileArtifactTsx } from "./artifactCompiler";
import { runInNewContext } from "node:vm";
import { version as reactVersion } from "react";
import reactRuntime from "virtual:artifact-react-runtime";

describe("ArtifactLens format & registry matching", () => {
  it("recognizes HTML and TSX canvas files", () => {
    expect(formatOf("index.html")).toBe("html");
    expect(formatOf("dev/preview.htm")).toBe("html");
    expect(formatOf("src/Widget.tsx")).toBe("react");
    expect(formatOf("components/Button.jsx")).toBe("react");
    expect(candidatesFor("page.html", "<div>Hello</div>", [])[0].id).toBe("builtin:html");
    expect(candidatesFor("Card.tsx", "export default function Card() { return <div>Card</div>; }", [])[0].id).toBe("builtin:react");
  });
});

describe("isolated artifact document", () => {
  it("bundles matching React globals without a module loader or network", () => {
    const window: { React?: { version: string; useState: unknown }; ReactDOM?: { createRoot: unknown } } = {};
    runInNewContext(reactRuntime, { window });
    expect(window.React?.version).toBe(reactVersion);
    expect(window.React?.useState).toBeTypeOf("function");
    expect(window.ReactDOM?.createRoot).toBeTypeOf("function");
  });

  it("places a default-deny policy before authored HTML", () => {
    const html = buildArtifactHtml('<script>window.authored = true</script><main data-cheers-canvas>Hi</main>', "html");
    expect(html).toContain("<!doctype html>");
    expect(html.indexOf("Content-Security-Policy")).toBeLessThan(html.indexOf("window.authored"));
    expect(html).toContain("CheersBridge");
    expect(html).toContain("canvas.move");
    expect(artifactCsp()).toContain("default-src 'none'");
    expect(artifactCsp()).toContain("connect-src 'none'");
    expect(artifactCsp()).toContain("form-action 'none'");
    expect(artifactCsp()).not.toContain("unsafe-eval");
    expect(html).not.toContain("tailwindcss.com");
    expect(html).not.toContain("unpkg.com");
  });

  it("compiles TSX ahead of iframe execution and adds source lines", () => {
    const source = '\n\nexport default function App() { return <main data-cheers-id="a">Hello</main>; }';
    const compiled = compileArtifactTsx(source);
    const html = buildArtifactHtml(source, "react", compiled);
    expect(compiled).toContain("data-cheers-source");
    expect(compiled).toContain('"3"');
    expect(html).toContain("ReactDOM.createRoot");
    expect(html).toContain("window.__CHEERS_ROOT_COMPONENT__");
    expect(html).toContain("data-cheers-id");
    expect(html).not.toContain("@babel/standalone");
    expect(html).not.toContain("eval(");
  });

  it("escapes script closing tags in embedded compiled code", () => {
    const html = buildArtifactHtml("export default function App() {}", "react", 'const marker = "</script><script>window.injected=true</script>";');
    expect(html).toContain("<\\/script><script>window.injected=true<\\/script>");
    expect(html).not.toContain("</script><script>window.injected=true</script>");
  });

  it("emits a syntactically valid bridge", () => {
    const html = buildArtifactHtml('<main data-cheers-canvas><div data-cheers-id="card" data-cheers-position="10,20"/></main>', "html");
    const bridge = html.match(/<script>([\s\S]*?canvas\.move[\s\S]*?)<\/script>/)?.[1];
    expect(bridge).toBeTruthy();
    expect(() => new Function(bridge ?? "")).not.toThrow();
  });
});
