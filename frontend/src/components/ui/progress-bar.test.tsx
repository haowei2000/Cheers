import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProgressBar } from "./progress-bar";

describe("ProgressBar", () => {
  it("carries a name and the full valuenow/min/max triplet", () => {
    const html = renderToStaticMarkup(<ProgressBar value={41} label="Uploading roadmap.md" />);
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-label="Uploading roadmap.md"');
    expect(html).toContain('aria-valuenow="41"');
    expect(html).toContain('aria-valuemin="0"');
    expect(html).toContain('aria-valuemax="100"');
    expect(html).toContain("width:41%");
  });

  it("clamps out-of-range values instead of rendering a bar past its track", () => {
    expect(renderToStaticMarkup(<ProgressBar value={140} label="x" />)).toContain('aria-valuenow="100"');
    expect(renderToStaticMarkup(<ProgressBar value={-8} label="x" />)).toContain('aria-valuenow="0"');
  });

  it("omits the value entirely when the end is unknown", () => {
    const html = renderToStaticMarkup(<ProgressBar label="Indexing workspace files" />);
    expect(html).toContain('role="progressbar"');
    expect(html).not.toContain("aria-valuenow");
    expect(html).toContain("animate-pulse");
  });

  it("uses the semantic tone rather than an ad-hoc colour", () => {
    expect(renderToStaticMarkup(<ProgressBar value={12} label="x" tone="danger" />)).toContain("bg-danger-400");
  });
});
