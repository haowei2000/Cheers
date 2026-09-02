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

  it("keeps primary navigation and panel context in one desktop chrome row", () => {
    const markup = render(
      <FloatingPanel
        title="Remote workspace"
        onClose={() => {}}
        storageKey="t.context"
        primaryNavigation={{
          ariaLabel: "Workspace views",
          items: [
            { id: "files", label: "Files", selected: true },
            { id: "changes", label: "Changes" },
          ],
        }}
        panelContext={<select aria-label="Select a bot"><option>Bot</option></select>}
      >
        <p>workspace-content</p>
      </FloatingPanel>
    );

    const navigationIndex = markup.indexOf('data-floating-panel-navigation=""');
    const primaryIndex = markup.indexOf('data-floating-panel-primary-navigation=""');
    const contextIndex = markup.indexOf('data-floating-panel-context=""');
    const contentIndex = markup.indexOf('data-floating-panel-content=""');
    expect(navigationIndex).toBeGreaterThan(-1);
    expect(primaryIndex).toBeGreaterThan(navigationIndex);
    expect(contextIndex).toBeGreaterThan(primaryIndex);
    expect(contentIndex).toBeGreaterThan(contextIndex);
    expect(markup).toContain("whitespace-nowrap");
    expect(markup).toContain("w-0 overflow-hidden");
    // `top-12` in the CHROME would mean a second stacked row. On the content element it
    // means the opposite — the body clearing the chrome band — so the assertion has to
    // name where it looks, not just whether the string is present anywhere.
    expect(markup.slice(0, contentIndex)).not.toContain("top-12");
    expect(markup.slice(contentIndex)).toContain("md:top-12");
    expect(markup).toContain("--floating-panel-chrome-top");
    expect(markup).toContain("--floating-panel-safe-top");
    expect(markup).toContain("workspace-content");
  });

  it("keeps floating chrome in the corners and off the content", () => {
    // Two rules, one cause. The chrome used to put three islands on one edge with the
    // navigation CENTERED between the title and the actions, over a body that started at
    // y=0. So the middle island was squeezed until it slid under a neighbour, and every
    // panel lost its first row to the islands — a table its column headers, a file
    // browser its path and controls — at exactly the moment the pointer was over the
    // panel and the chrome faded in.
    const markup = renderToStaticMarkup(
      <FloatingPanel
        title="Workbench"
        open
        onClose={() => {}}
        storageKey="t.corners"
        primaryNavigation={{
          ariaLabel: "Scenes",
          items: [{ id: "a", label: "Alpha", selected: true }, { id: "b", label: "Beta" }],
        }}
      >
        <p>panel-content</p>
      </FloatingPanel>
    );

    const contentIndex = markup.indexOf('data-floating-panel-content=""');
    // Just the islands: `left-1/2` also appears on the panel ROOT, which is where the
    // window sits on screen and has nothing to do with where its chrome sits inside it.
    const chrome = markup.slice(markup.indexOf('data-floating-panel-title=""'), contentIndex);
    const content = markup.slice(contentIndex);

    // No island is centred: a centre cluster has no width of its own, because the two
    // sides claim theirs first.
    expect(chrome).not.toContain("left-1/2");
    expect(chrome).not.toContain("-translate-x-1/2");
    // The left island is a CORNER, capped so it cannot stretch across the top and become
    // the centered toolbar again.
    expect(markup.slice(0, contentIndex)).toContain("45%");
    // Both top islands anchor to their own corner.
    expect(markup.slice(0, contentIndex)).toContain("left-2 top-2");
    expect(chrome).toContain("right-2 top-2");
    // The body starts below the chrome band rather than underneath it.
    expect(content).toContain("md:top-12");
    expect(content).not.toContain("md:inset-0");

    // Just the top-LEFT island: from where it opens to where the actions island starts.
    const actionsIndex = markup.indexOf('data-floating-panel-actions=""');
    const leftIsland = markup.slice(markup.indexOf("floating-control-surface"), actionsIndex);

    // The grip and the tabs are ONE island, not two pills with a gap between them — so
    // the surface class appears once across the whole of it.
    expect(leftIsland.match(/floating-control-surface/g)).toHaveLength(1);

    // No panel NAME in the expanded desktop chrome: the mark and the lit tab identify it,
    // and an uppercase tracked word was the widest thing in that corner while being the
    // one thing you never click. It stays where it IS the only identity — the collapsed
    // pill and the mobile header, which is why this looks at the island and not the
    // whole markup.
    expect(leftIsland).not.toContain("tracking-section");
    // Gone from the DISPLAY, not from the accessibility tree: the grip still announces
    // which panel it moves.
    expect(leftIsland).toContain('aria-label="Workbench — drag to move"');
  });
});
