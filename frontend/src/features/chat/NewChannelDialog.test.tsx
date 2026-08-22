import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import { NewChannelDialog } from "./NewChannelDialog";

describe("NewChannelDialog", () => {
  it("offers one flat channel-type choice instead of separate layout and profile choices", () => {
    const markup = renderToStaticMarkup(
      <NewChannelDialog workspaceId="workspace-1" onClose={() => undefined} />,
    );

    expect(markup).toContain("Channel type");
    expect(markup).toContain('aria-label="Channel type"');
    expect(markup).toContain("grid-cols-3");
    expect(markup).toContain(">Chat<");
    expect(markup).toContain(">Discuss<");
    expect(markup).toContain(">Code<");
    expect(markup).not.toContain("Conversation style");
    expect(markup).not.toContain("Channel purpose");
    expect(markup).not.toContain("GitHub installation");
  });
});
