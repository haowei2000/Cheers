import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EntityItem, ItemChip, ItemGroup, ItemList, ItemRow, ItemSection, NavigationItem, OperationsItem, WorkbenchItem } from "@/components/ui/item";
import { PresentationProvider } from "@/components/ui/presentation";
import { ControlSizeProvider } from "@/components/ui/control-size";

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
    expect(markup).toContain('role="listitem"');
    expect(markup.match(/<button/g)).toHaveLength(1);
    expect(markup).not.toMatch(/<button[^>]*>.*<button/s);
  });

  it("inherits control height independently from presentation anatomy", () => {
    const markup = renderToStaticMarkup(
      <PresentationProvider level="max">
        <ControlSizeProvider size="compact">
          <EntityItem title="Ada" subtitle="Engineer" />
        </ControlSizeProvider>
      </PresentationProvider>
    );
    expect(markup).toContain('data-presentation-level="max"');
    expect(markup).toContain('data-control-size="compact"');
    expect(markup).toContain("Engineer");
    expect(markup).toContain("min-h-7");
  });

  it.each(["max", "medium", "minimal"] as const)(
    "lets an ItemList provide the %s anatomy to its rows",
    (level) => {
      const markup = renderToStaticMarkup(
        <ItemList presentationLevel={level} controlSize="regular">
          <EntityItem title="Ada" subtitle="Engineer" metadata="Online" />
        </ItemList>,
      );
      expect(markup).toContain(`data-presentation-level="${level}"`);
      expect(markup).toContain('data-control-size="regular"');
      expect(markup).toContain("min-h-9");
      expect(markup.includes("Engineer")).toBe(level !== "minimal");
      expect(markup.includes("Online")).toBe(level === "max");
    },
  );

  it("groups an expandable summary and detail into one list position", () => {
    const markup = renderToStaticMarkup(
      <ItemList presentationLevel="medium" controlSize="regular">
        <ItemGroup>
          <WorkbenchItem containerRole="presentation" title="changed.ts" />
          <div>Diff detail</div>
        </ItemGroup>
      </ItemList>,
    );
    expect(markup.match(/role="listitem"/g)).toHaveLength(1);
    expect(markup).toContain("Diff detail");
  });

  it("keeps composite chip actions inside the registered control height", () => {
    const markup = renderToStaticMarkup(
      <ItemChip
        label="Cost"
        controlSize="regular"
        actions={<button type="button" data-control-size="compact">Remove</button>}
      />,
    );
    expect(markup).toContain('data-control-size="regular"');
    expect(markup).toContain("min-h-9");
    expect(markup).toContain("data-item-actions");
    expect(markup).toContain('data-control-size="compact"');
  });

  it("renders section labels as static dividers while rows inherit regular size", () => {
    const markup = renderToStaticMarkup(
      <ItemSection label="Channels" controlSize="regular" headerControlSize="compact">
        <NavigationItem title="general" />
      </ItemSection>,
    );
    expect(markup).toContain("<header");
    expect(markup).toContain(">Channels</span>");
    expect(markup).not.toMatch(/<button[^>]*>[^<]*Channels/s);
    expect(markup).toContain("min-h-7");
    expect(markup).toContain('data-control-size="regular"');
    expect(markup).toContain("min-h-9");
  });

  it("gives selected navigation a visible fill and current-page semantics", () => {
    const markup = renderToStaticMarkup(
      <NavigationItem title="general" selected onClick={() => undefined} />,
    );
    expect(markup).toContain("bg-zinc-800");
    expect(markup).toContain('aria-current="page"');
    expect(markup).not.toContain("aria-pressed");
  });
});
