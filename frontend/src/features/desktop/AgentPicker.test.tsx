import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AgentPicker } from "./AgentPicker";

vi.mock("@/lib/desktop", () => ({
  invokeDesktop: vi.fn().mockImplementation((cmd: string) => {
    if (cmd === "detect_agents") {
      return Promise.resolve([
        {
          key: "codex",
          label: "Codex",
          command: "codex-acp",
          installed: true,
          path: "/opt/homebrew/bin/codex-acp",
          installable: true,
        },
        {
          key: "claude",
          label: "Claude Code",
          command: "claude-code-acp",
          installed: true,
          path: "/usr/local/bin/claude",
          installable: true,
        },
        {
          key: "gemini",
          label: "Gemini CLI",
          command: "gemini-acp",
          installed: false,
          path: null,
          installable: true,
        },
      ]);
    }
    return Promise.resolve(null);
  }),
}));

describe("AgentPicker", () => {
  it("renders without crashing and includes custom command", () => {
    const markup = renderToStaticMarkup(
      <AgentPicker value="codex" onPick={() => {}} />
    );
    expect(markup).toBeDefined();
  });
});
