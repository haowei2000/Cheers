import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NewSessionDialog } from "./NewSessionDialog";

describe("NewSessionDialog", () => {
  const source = readFileSync(new URL("./NewSessionDialog.tsx", import.meta.url), "utf8");
  const bots = [
    { id: "bot-1", label: "hwcodex" },
    { id: "bot-2", label: "claude-bot" },
  ];

  it("renders the dialog shell with DropdownSelect and form fields", () => {
    const markup = renderToStaticMarkup(
      <NewSessionDialog
        channelId="chan-1"
        bots={bots}
        onClose={() => {}}
        onCreated={() => {}}
      />
    );

    expect(markup).toContain("New session");
    expect(markup).toContain("hwcodex");
    expect(markup).toContain("Working directory (optional)");
    expect(markup).toContain("Extra roots (optional)");
    expect(markup).toContain("Create");
    expect(markup).toContain("Cancel");
  });

  it("uses standard DropdownSelect for bot selection", () => {
    expect(source).toContain("<DropdownSelect");
    expect(source).not.toContain("<UiSelect");
  });

  it("renders allowed root suggestions as compact content-width chips with role=option", () => {
    expect(source).toContain('role="option"');
    expect(source).toContain('controlWidth="content"');
    expect(source).toContain('controlSize="compact"');
    expect(source).toContain('variant="secondary"');
    // Ensure it no longer tries to cram inline buttons inside text sentence
    expect(source).not.toContain("Must be inside an allowed root: ");
    expect(source).toContain("Allowed roots:");
  });

  it("supports recent projects and desktop folder browsing", () => {
    expect(source).toContain("Recent projects");
    expect(source).toContain("handlePickFolder");
    expect(source).toContain("addRecentWorkspace");
    expect(source).toContain("pickFolder");
  });
});
