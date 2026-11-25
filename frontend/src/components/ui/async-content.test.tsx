import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AsyncContent } from "./async-content";

describe("AsyncContent", () => {
  it("never renders an empty-success message after a request fails", () => {
    const markup = renderToStaticMarkup(<AsyncContent loading={false} error="Network unavailable" onRetry={vi.fn()}><p>No records</p></AsyncContent>);
    expect(markup).toContain("Network unavailable");
    expect(markup).toContain("Retry");
    expect(markup).not.toContain("No records");
  });
  it("shows content only after the initial load succeeds", () => {
    expect(renderToStaticMarkup(<AsyncContent loading error={null} onRetry={vi.fn()}>No records</AsyncContent>)).not.toContain("No records");
    expect(renderToStaticMarkup(<AsyncContent loading={false} error={null} onRetry={vi.fn()}>No records</AsyncContent>)).toContain("No records");
  });
});
