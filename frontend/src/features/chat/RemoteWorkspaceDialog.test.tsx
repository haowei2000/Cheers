import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { WorkspaceEntry } from "@/api/workspace";
import { ContextActionsProvider } from "@/components/ui/context-actions";
import { WorkspaceEntryRow, WorkspacePathLabel } from "./RemoteWorkspaceDialog";

function file(name: string): WorkspaceEntry {
  return { name, path: name, is_dir: false, size_bytes: 132 };
}

function row(entry: WorkspaceEntry, mark: { m: string; cls: string } | null = null) {
  return renderToStaticMarkup(
    <ContextActionsProvider>
      <WorkspaceEntryRow entry={entry} selected={false} mark={mark} actions={() => []} onOpen={() => {}} />
    </ContextActionsProvider>
  );
}

describe("WorkspaceEntryRow", () => {
  // The row IS the whole affordance: one control, opened by click, with secondary
  // actions behind the shared context surface. The old row nested hover-revealed
  // buttons beside it, which touch could not reach and `hidden` removed from the
  // keyboard's tab order.
  it("renders one control per entry, with no nested action buttons", () => {
    const markup = row(file("test-sample.txt"));
    expect(markup.match(/<button/g)).toHaveLength(1);
    expect(markup).toContain("test-sample.txt");
  });

  it("keeps the git marker inside the row instead of under an overlay", () => {
    const markup = row(file("test.md"), { m: "M", cls: "text-warning-400" });
    expect(markup).toContain('title="git: M"');
    expect(markup.match(/<button/g)).toHaveLength(1);
  });
});

describe("RemoteWorkspaceDialog gestures", () => {
  const source = readFileSync(new URL("./RemoteWorkspaceDialog.tsx", import.meta.url), "utf8");

  // Hover is not an input every device has. An action that only appears on hover is
  // missing on touch and absent from the tab order, so row and viewer actions live in
  // the context surface (right-click, long-press, the ContextMenu key) instead.
  it("reveals no actions on hover alone", () => {
    expect(source).not.toMatch(/hidden\s+group-hover\/[\w-]+:(?:flex|block|inline-flex)/);
  });

  it("routes rows and the open file through the shared context surface", () => {
    expect(source.match(/useContextSurface\(/g)?.length).toBeGreaterThanOrEqual(2);
  });
});

describe("WorkspacePathLabel", () => {
  // The panel used to render a bare "/" for the browse root. That is relative to a
  // root it never displayed, so with a single workspace — the common case, and the
  // one where no picker names the root either — nothing on screen said which folder
  // you were actually in.
  it("names the root instead of showing a bare slash", () => {
    const markup = renderToStaticMarkup(
      <WorkspacePathLabel treeRoot="/Users/haowei/.cheers/workspace" cwd="" />
    );
    expect(markup).toContain("/Users/haowei/.cheers/workspace");
    expect(markup).toContain('title="/Users/haowei/.cheers/workspace"');
  });

  it("keeps the navigated path whole and lets the root truncate first", () => {
    const markup = renderToStaticMarkup(
      <WorkspacePathLabel treeRoot="/Users/haowei/.cheers/workspace" cwd="docs/api" />
    );
    expect(markup).toContain('title="/Users/haowei/.cheers/workspace/docs/api"');
    // The root gives way under pressure; the part you navigated does not.
    expect(markup).toMatch(/truncate[^"]*">\/Users\/haowei\/\.cheers\/workspace</);
    expect(markup).toMatch(/shrink-0">\/docs\/api</);
  });

  it("falls back to the relative path before the root is known", () => {
    const markup = renderToStaticMarkup(<WorkspacePathLabel treeRoot={null} cwd="docs" />);
    expect(markup).toContain('title="/docs"');
  });
});
