import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SessionAttachBanner } from "./SessionAttachBanner";
import type { SessionReferenceMatch } from "@/api/sessionControl";

const reference = {
  raw: "codex://threads/01a1422e-d5e6-7e10-be3b-040fa49834a4",
  app: "Codex thread",
};

function match(overrides: Partial<SessionReferenceMatch["session"]> = {}): SessionReferenceMatch {
  return {
    bot_id: "bot-1",
    username: "hwcodex",
    display_name: "Codex",
    host_id: "host-1",
    device_name: "MacBook",
    session: {
      session_id: "01a1422e-d5e6-7e10-be3b-040fa49834a4",
      cwd: "/Users/me/project",
      title: "Fix the login flow",
      updated_at: null,
      cwd_allowed: true,
      cwd_error: null,
      ...overrides,
    },
  };
}

const handlers = { onLookUp: vi.fn(), onAttach: vi.fn(), onDismiss: vi.fn() };

describe("SessionAttachBanner", () => {
  it("offers a lookup for a detected link", () => {
    const markup = renderToStaticMarkup(
      <SessionAttachBanner reference={reference} phase="idle" matches={[]} {...handlers} />,
    );
    expect(markup).toContain("Codex thread link in your draft");
    expect(markup).toContain("Look up");
    expect(markup).not.toContain('role="list"');
  });

  it("lists where the session was found with an Attach action", () => {
    const markup = renderToStaticMarkup(
      <SessionAttachBanner reference={reference} phase="choosing" matches={[match()]} {...handlers} />,
    );
    expect(markup).toContain("Codex thread found");
    expect(markup).toContain("Fix the login flow");
    expect(markup).toContain("Codex on MacBook · /Users/me/project");
    expect(markup).toContain(">Attach<");
    expect(markup).not.toContain("Folder not allowed");
  });

  it("keeps a disallowed folder visible and blocks attaching it", () => {
    const markup = renderToStaticMarkup(
      <SessionAttachBanner
        reference={reference}
        phase="choosing"
        matches={[match({ cwd_allowed: false, cwd_error: "cwd is outside local allowed workspace roots" })]}
        {...handlers}
      />,
    );
    expect(markup).toContain("Folder not allowed");
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Attach Fix the login flow/);
  });

  it("surfaces errors as an alert", () => {
    const markup = renderToStaticMarkup(
      <SessionAttachBanner
        reference={reference}
        phase="idle"
        matches={[]}
        error="No connected agent has this session."
        {...handlers}
      />,
    );
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("No connected agent has this session.");
  });
});
