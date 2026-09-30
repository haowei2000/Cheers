import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkbenchStatusBar } from "./WorkbenchStatusBar";

describe("WorkbenchStatusBar", () => {
  it("renders nothing when no file, status, or collaborators are active", () => {
    const markup = renderToStaticMarkup(
      <WorkbenchStatusBar selectedPath={null} status={null} />
    );
    expect(markup).toBe("");
  });

  it("renders selected file path", () => {
    const markup = renderToStaticMarkup(
      <WorkbenchStatusBar selectedPath="src/index.ts" />
    );
    expect(markup).toContain("src/index.ts");
  });

  it("renders status indicator when dirty or saving", () => {
    const dirtyMarkup = renderToStaticMarkup(
      <WorkbenchStatusBar selectedPath="README.md" dirty={true} />
    );
    expect(dirtyMarkup).toContain('title="Unsaved changes"');
    expect(dirtyMarkup).toContain('role="img"');
    expect(dirtyMarkup).toContain('aria-label="Unsaved changes"');

    const savingMarkup = renderToStaticMarkup(
      <WorkbenchStatusBar selectedPath="README.md" saving={true} />
    );
    expect(savingMarkup).toContain("Saving…");
  });

  it("renders status message with live region and role=status", () => {
    const markup = renderToStaticMarkup(
      <WorkbenchStatusBar
        selectedPath="data.json"
        status="Added data.json to context"
        parseError="Invalid JSON"
      />
    );
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-label="Workbench status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain("Added data.json to context");
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("syntax error");
  });
});
