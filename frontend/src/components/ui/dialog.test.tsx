import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Dialog } from "./dialog";

describe("Dialog component", () => {
  it("keeps the header with close button outside the scrollable body container", () => {
    const markup = renderToStaticMarkup(
      <Dialog title="Channel settings" onClose={() => undefined}>
        <div>Dialog content</div>
      </Dialog>,
    );

    // Title and close button exist
    expect(markup).toContain("Channel settings");
    expect(markup).toContain('aria-label="Close dialog"');

    // Header has shrink-0 and is separate from the scrollable body container
    expect(markup).toContain("shrink-0 px-4 pt-4 pb-3");
    // Body has overflow-y-auto and min-h-0 flex-1
    expect(markup).toContain("min-h-0 flex-1 overflow-y-auto overscroll-contain");
  });

  it("renders headless dialog with full-body scroll when title is omitted", () => {
    const markup = renderToStaticMarkup(
      <Dialog ariaLabel="Preview" onClose={() => undefined}>
        <div>Preview content</div>
      </Dialog>,
    );

    expect(markup).toContain('aria-label="Preview"');
    expect(markup).not.toContain("Close dialog");
    expect(markup).toContain("min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4 space-y-3 pt-4");
  });
});
