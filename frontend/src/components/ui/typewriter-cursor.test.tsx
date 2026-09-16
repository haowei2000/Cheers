import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TypewriterCursor } from "./typewriter-cursor";

describe("TypewriterCursor", () => {
  it("renders mechanical typewriter block cursor with blinking animation", () => {
    const markup = renderToStaticMarkup(<TypewriterCursor />);
    expect(markup).toContain("w-2 h-4");
    expect(markup).toContain("bg-content-strong");
    expect(markup).toContain("animate-blink");
    expect(markup).toContain('aria-label="Typewriter cursor"');
  });

  it("renders with accessible status role and custom label when specified", () => {
    const markup = renderToStaticMarkup(<TypewriterCursor label="Agent thinking" />);
    expect(markup).toContain('aria-label="Agent thinking"');
    expect(markup).toContain('role="status"');
  });
});
