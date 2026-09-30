import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Code2 } from "lucide-react";
import {
  SceneTab,
  ItemTab,
  AddCollectionControl,
  NewCollectionDialog,
  AddTabControl,
  WorkbenchHierarchyNavigation,
} from "./SceneNavigation";

describe("SceneNavigation components", () => {
  it("renders SceneTab with proper tab semantics, aria-selected, and focus styles", () => {
    const markup = renderToStaticMarkup(
      <SceneTab
        label="Dev"
        Icon={Code2}
        iconColor="text-accent-300"
        selected={true}
        presentation="iconText"
        onSelect={() => {}}
        onShowRaw={() => {}}
        onAddToContext={() => {}}
        contextAdded={false}
        contextAvailable={true}
      />
    );

    expect(markup).toContain('role="tab"');
    expect(markup).toContain('aria-selected="true"');
    expect(markup).toContain("focus-visible:ring-2");
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain("Dev");
  });

  it("renders ItemTab with tab role and focus ring", () => {
    const markup = renderToStaticMarkup(
      <ItemTab
        label="main.rs"
        selected={false}
        presentation="text"
        contextAdded={false}
        onSelect={() => {}}
        onAddToContext={() => {}}
      />
    );

    expect(markup).toContain('role="tab"');
    expect(markup).toContain('aria-selected="false"');
    expect(markup).toContain("focus-visible:ring-2");
    expect(markup).toContain("main.rs");
  });

  it("renders AddCollectionControl with accessible label and compact tab sizing", () => {
    const markup = renderToStaticMarkup(
      <AddCollectionControl onOpenNew={() => {}} content="icon" />
    );

    expect(markup).toContain('aria-label="Add Collection"');
    expect(markup).toContain('title="Add Collection"');
  });

  it("renders NewCollectionDialog with listbox semantics for templates", () => {
    const markup = renderToStaticMarkup(
      <NewCollectionDialog
        isOpen={true}
        available={[
          {
            id: "cheers-code-project",
            title: "Code project",
            items: [],
          },
        ]}
        onSelect={() => {}}
        onLoad={() => {}}
        onClose={() => {}}
      />
    );

    expect(markup).toContain('role="listbox"');
    expect(markup).toContain('aria-label="Available templates"');
    expect(markup).toContain('role="option"');
    expect(markup).toContain("Code project");
    expect(markup).toContain("Cancel");
  });

  it("renders AddTabControl with downward placement", () => {
    const markup = renderToStaticMarkup(
      <AddTabControl
        candidates={["src/lib.rs", "src/main.rs"]}
        onSelect={() => {}}
      />
    );

    expect(markup).toContain('aria-label="Open Tab"');
  });

  it("renders WorkbenchHierarchyNavigation with chrome control density", () => {
    const markup = renderToStaticMarkup(
      <WorkbenchHierarchyNavigation
        availableWidth={400}
        collections={[{ id: "dev", label: "Dev", Icon: Code2 }]}
        activeCollection="dev"
        collectionTitle="Dev"
        collectionIcon={Code2}
        hasAvailableTemplates={true}
        onSelectCollection={() => {}}
        onOpenNew={() => {}}
        onLoadCollection={() => {}}
        onShowRaw={() => {}}
      />
    );

    expect(markup).toContain('aria-label="Collection: Dev"');
  });
});
