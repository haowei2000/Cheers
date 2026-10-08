import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AnnotationsButton } from "./AnnotationsButton";
vi.mock("@/features/annotations/AnnotationProvider", () => ({
  useAnnotationSurface: () => ({ open: vi.fn(), notes: [] }),
}));
describe("shared annotation launcher", () => {
  it("has a named, touch-sized action instead of another local popup", () => {
    const markup = renderToStaticMarkup(
      <AnnotationsButton notes={[]} currentPath="spec.md" />,
    );
    expect(markup).toContain('aria-label="Annotations (0)"');
    expect(markup).toContain('data-control-size="comfortable"');
    expect(markup).not.toContain('role="dialog"');
  });
});
