import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EntityItem, ItemRow, OperationsItem } from "@/components/ui/item";
import { PresentationProvider } from "@/components/ui/presentation";

function render(level: "max" | "medium" | "minimal") {
  return renderToStaticMarkup(
    <PresentationProvider level={level}>
      <ItemRow
        kind="navigation"
        title="release"
        subtitle="supporting"
        metadata="metadata"
        preview="preview"
        criticalStatus={<span>critical</span>}
        status={<span>status</span>}
      />
    </PresentationProvider>
  );
}

describe("ItemRow presentation levels", () => {
  it("renders all supporting slots at max", () => {
    const markup = render("max");
    expect(markup).toContain("font-utility");
    expect(markup).not.toContain("truncate font-reading");
    expect(markup).toContain("supporting");
    expect(markup).toContain("metadata");
    expect(markup).toContain("preview");
    expect(markup).toContain("critical");
  });

  it("keeps critical state but removes supporting content at minimal", () => {
    const markup = render("minimal");
    expect(markup).toContain("critical");
    expect(markup).not.toContain("supporting");
    expect(markup).not.toContain("metadata");
    expect(markup).not.toContain("preview");
    expect(markup).not.toContain(">status<");
  });

  it("lets an explicit item level override its container", () => {
    const markup = renderToStaticMarkup(
      <PresentationProvider level="minimal">
        <ItemRow kind="identity" title="Ada" subtitle="Engineer" presentationLevel="max" />
      </PresentationProvider>
    );
    expect(markup).toContain('data-presentation-level="max"');
    expect(markup).toContain("Engineer");
  });

  it("renders a full-row item as one button", () => {
    const markup = renderToStaticMarkup(<EntityItem title="Ada" onClick={() => undefined} />);
    expect(markup.match(/<button/g)).toHaveLength(1);
    expect(markup).toContain('data-item-kind="identity"');
  });

  it("keeps composite actions outside a full-row button", () => {
    const markup = renderToStaticMarkup(
      <OperationsItem title="Approval" actions={<button type="button">Approve</button>} />
    );
    expect(markup).toContain("data-item-actions");
    expect(markup.match(/<button/g)).toHaveLength(1);
    expect(markup).not.toMatch(/<button[^>]*>.*<button/s);
  });
});
