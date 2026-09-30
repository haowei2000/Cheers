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

    const savingMarkup = renderToStaticMarkup(
      <WorkbenchStatusBar selectedPath="README.md" saving={true} />
    );
    expect(savingMarkup).toContain("Saving…");
  });

  it("renders status message", () => {
    const markup = renderToStaticMarkup(
      <WorkbenchStatusBar
        selectedPath="data.json"
        status="Added data.json to context"
      />
    );
    expect(markup).toContain("Added data.json to context");
  });
});
