import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FloatingPanel } from "./floating-panel";

// FloatingPanel became the host for the Workbench and ViewBoard drawers, which used to
// hand-roll their own shells. Those two need three things the other callers never did,
// and each one is a way the migration could silently regress:
//
//   open       — a CLOSED panel must stay MOUNTED (the Workbench's file tree and the
//                ViewBoard's visited tabs are body state that must survive a close).
//                Conditional rendering, which every other caller uses, would lose it.
//   collapsed  — controlled, because useChannelInstruments owns the ViewBoard's flag.
//   dropTarget — the Workbench accepts a dropped .cheers-extension on the whole panel.
//
// The repo has no jsdom/RTL, so these are SSR-markup assertions: they verify what is
// rendered, not what happens on click. That is enough for the regressions above —
// "state survives" IS "the children are still in the tree" — but a click-driven test
// of the controlled toggle would need a DOM and is not covered here.

function render(ui: React.ReactElement): string {
  return renderToStaticMarkup(ui);
}

/** The ROOT element's class list. Asserting against whole markup is a trap: child
 *  controls carry `max-md:hidden`, so a naive /hidden/ match passes either way. */
function rootClasses(markup: string): string[] {
  const match = /^<div[^>]*\sclass="([^"]*)"/.exec(markup);
  if (!match) throw new Error("no root class attribute in markup");
  return match[1].split(/\s+/);
}

describe("FloatingPanel visibility", () => {
  it("keeps a closed panel's children mounted", () => {
    const markup = render(
      <FloatingPanel title="Workbench" onClose={() => {}} storageKey="t.closed" open={false}>
        <p>tree-state</p>
      </FloatingPanel>
    );

    // The point of `open` over conditional rendering: the body is still there.
    expect(markup).toContain("tree-state");
  });

  it("hides a closed panel with a display class that beats the base `flex`", () => {
    const closed = render(
      <FloatingPanel title="Workbench" onClose={() => {}} storageKey="t.a" open={false}>
        <p>body</p>
      </FloatingPanel>
    );
    const open = render(
      <FloatingPanel title="Workbench" onClose={() => {}} storageKey="t.b" open>
        <p>body</p>
      </FloatingPanel>
    );

    // cn() is tailwind-merge and display is last-wins, so `hidden` has to survive the
    // merge against the base `flex`. If it were ordered earlier it would be dropped
    // and a closed panel would render visible.
    expect(rootClasses(closed)).toContain("hidden");
    expect(rootClasses(closed)).not.toContain("flex");
    expect(rootClasses(open)).not.toContain("hidden");
    expect(rootClasses(open)).toContain("flex");
  });

  it("re-asserts flex on mobile so the closed sheet keeps its column layout", () => {
    const markup = render(
      <FloatingPanel title="Workbench" onClose={() => {}} storageKey="t.m" open={false}>
        <p>body</p>
      </FloatingPanel>
    );

    expect(rootClasses(markup)).toContain("max-md:flex");
    expect(rootClasses(markup)).toContain("max-md:opacity-0");
    expect(rootClasses(markup)).toContain("max-md:pointer-events-none");
  });

  it("defaults to open, so existing callers are unaffected", () => {
    const markup = render(
      <FloatingPanel title="Files" onClose={() => {}} storageKey="t.default">
        <p>body</p>
      </FloatingPanel>
    );

    expect(rootClasses(markup)).not.toContain("hidden");
    expect(markup).toContain("body");
  });
});

describe("FloatingPanel collapse", () => {
  it("renders the summary instead of the body when controlled-collapsed", () => {
    const markup = render(
      <FloatingPanel
        title="ViewBoard"
        onClose={() => {}}
        storageKey="t.collapsed"
        collapsed
        onToggleCollapsed={() => {}}
        collapsedSummary={() => <p>glance</p>}
      >
        <p>full-board</p>
      </FloatingPanel>
    );

    expect(markup).toContain("glance");
    expect(markup).not.toContain("full-board");
  });

  it("renders the body when controlled-expanded, whatever the persisted flag says", () => {
    // The controlled value must win outright: the ViewBoard's flag lives in
    // useChannelInstruments, and a stale internal copy would fight it.
    const markup = render(
      <FloatingPanel
        title="ViewBoard"
        onClose={() => {}}
        storageKey="t.expanded"
        collapsed={false}
        onToggleCollapsed={() => {}}
        collapsedSummary={() => <p>glance</p>}
      >
        <p>full-board</p>
      </FloatingPanel>
    );

    expect(markup).toContain("full-board");
    expect(markup).not.toContain("glance");
  });

  it("hides panel chrome actions while collapsed", () => {
    const markup = render(
      <FloatingPanel
        title="Workbench"
        onClose={() => {}}
        storageKey="t.hx"
        collapsed
        onToggleCollapsed={() => {}}
        panelActions={[{ id: "toolbar", label: "Toolbar", control: <span>toolbar</span> }]}
        collapsedSummary={() => <p>glance</p>}
      >
        <p>body</p>
      </FloatingPanel>
    );

    // The drawers used to guard every toolbar control with `!minimized` by hand.
    expect(markup).not.toContain("toolbar");
  });
});

describe("FloatingPanel drop target", () => {
  it("paints the highlight only while active", () => {
    const inactive = render(
      <FloatingPanel
        title="Workbench"
        onClose={() => {}}
        storageKey="t.d1"
        dropTarget={{ active: false, onDrop: () => {}, onDragOver: () => {}, onDragLeave: () => {} }}
      >
        <p>body</p>
      </FloatingPanel>
    );
    const active = render(
      <FloatingPanel
        title="Workbench"
        onClose={() => {}}
        storageKey="t.d2"
        dropTarget={{ active: true, onDrop: () => {}, onDragOver: () => {}, onDragLeave: () => {} }}
      >
        <p>body</p>
      </FloatingPanel>
    );

    expect(rootClasses(inactive)).not.toContain("ring-amber-500/60");
    expect(rootClasses(active)).toContain("ring-amber-500/60");
  });
});

describe("FloatingPanel window chrome", () => {
  it("remains interactive inside the pointer-transparent desktop canvas", () => {
    const markup = render(
      <FloatingPanel title="Workbench" onClose={() => {}} storageKey="t.canvas">
        <p>body</p>
      </FloatingPanel>
    );

    expect(rootClasses(markup)).toContain("pointer-events-auto");
    expect(markup).toContain('data-floating-panel=""');
    expect(markup).toContain('data-floating-panel-handle=""');
    expect(markup).toContain("cursor-grab");
  });

  it("makes desktop content fill the complete panel client rect", () => {
    const markup = render(
      <FloatingPanel title="Workbench" onClose={() => {}} storageKey="t.content">
        <p>full-size-content</p>
      </FloatingPanel>
    );

    expect(markup).toContain('data-floating-panel-content=""');
    expect(markup).toContain("md:absolute");
    expect(markup).toContain("md:inset-0");
    expect(markup).toContain("full-size-content");
  });

  it("renders title, primary navigation, and actions as independent desktop islands", () => {
    const markup = render(
      <FloatingPanel
        title="Remote workspace"
        onClose={() => {}}
        storageKey="t.chrome"
        primaryNavigation={{
          ariaLabel: "Workspace views",
          items: [
            { id: "files", label: "Files", selected: true },
            { id: "changes", label: "Changes" },
            { id: "history", label: "History" },
          ],
        }}
        panelActions={[{ id: "refresh", label: "Refresh", control: <span>Refresh</span> }]}
      >
        <p>workspace</p>
      </FloatingPanel>
    );

    expect(markup).toContain('data-floating-panel-title=""');
    expect(markup).toContain('data-floating-panel-navigation=""');
    expect(markup).toContain('data-floating-panel-actions=""');
    expect(markup).toContain("Files");
    expect(markup).toContain("Changes");
    expect(markup).toContain("History");
    expect(markup).toContain("Refresh");
    expect(markup).toContain("Minimize panel");
    expect(markup).toContain("Close panel");
  });

  it("keeps panel context controls outside the full-size content surface", () => {
    const markup = render(
      <FloatingPanel
        title="Remote workspace"
        onClose={() => {}}
        storageKey="t.context"
        panelContext={<select aria-label="Select a bot"><option>Bot</option></select>}
      >
        <p>workspace-content</p>
      </FloatingPanel>
    );

    const contextIndex = markup.indexOf('data-floating-panel-context=""');
    const contentIndex = markup.indexOf('data-floating-panel-content=""');
    expect(contextIndex).toBeGreaterThan(-1);
    expect(contentIndex).toBeGreaterThan(contextIndex);
    expect(markup).toContain("--floating-panel-chrome-top");
    expect(markup).toContain("--floating-panel-safe-top");
    expect(markup).toContain("workspace-content");
  });
});
