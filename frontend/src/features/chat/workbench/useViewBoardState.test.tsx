import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  formatScopeLabel,
  ATTACHABLE_BOARDS,
  ACTIVE_BOARD_KEY,
  type SessionOpt,
} from "./useViewBoardState";
import {
  ViewBoardScopeSelector,
  ViewBoardContextAction,
  ViewBoardMobileTabs,
  ViewBoardContent,
} from "./ViewBoardDrawer";
import type { PanelContext, PanelContribution } from "@/features/chat/panels/registry";

describe("formatScopeLabel", () => {
  const sampleSessions: SessionOpt[] = [
    {
      session_id: "s-1",
      bot_id: "bot-1234567890",
      bot_name: "CoderBot",
      is_primary: true,
      cwd: "/repo",
      created_at: "2026-09-30T08:00:00Z",
    },
    {
      session_id: "s-2",
      bot_id: "bot-abcdefghij",
      bot_name: null,
      is_primary: false,
      cwd: null,
      created_at: null,
    },
  ];

  it("returns 'All sessions' when scope is empty", () => {
    expect(formatScopeLabel("", sampleSessions)).toBe("All sessions");
  });

  it("returns bot name when present on matched session", () => {
    expect(formatScopeLabel("s-1", sampleSessions)).toBe("CoderBot");
  });

  it("falls back to bot_id prefix when bot name is absent", () => {
    expect(formatScopeLabel("s-2", sampleSessions)).toBe("bot-abcd");
  });

  it("returns 'All sessions' when session is not found in list", () => {
    expect(formatScopeLabel("non-existent", sampleSessions)).toBe("All sessions");
  });
});

describe("ATTACHABLE_BOARDS", () => {
  it("defines attachable board resource verbs and context kinds", () => {
    expect(ATTACHABLE_BOARDS.plan).toEqual({
      verb: "channel.plan.read",
      kind: "plan",
    });
    expect(ATTACHABLE_BOARDS.cost).toEqual({
      verb: "channel.usage.read",
      kind: "cost",
    });
    expect(ATTACHABLE_BOARDS.sessions).toEqual({
      verb: "channel.sessions.read",
      kind: "sessions",
    });
    expect(ATTACHABLE_BOARDS.activity).toEqual({
      verb: "channel.activity.read",
      kind: "activity",
    });
  });

  it("does not allow audit board to be attached as resource context", () => {
    expect(ATTACHABLE_BOARDS.audit).toBeUndefined();
  });

  it("defines the expected active board storage key", () => {
    expect(ACTIVE_BOARD_KEY).toBe("cheers.viewboard.active");
  });
});

describe("ViewBoard decomposed components", () => {
  const mockContext: PanelContext = {
    channelId: "c-1",
    sendResourceReq: vi.fn(),
  };

  const sampleBoards: PanelContribution[] = [
    {
      id: "plan",
      title: "Plan",
      surface: "lane",
      render: ({ visible }) => <div data-testid="plan-panel">Plan Content visible={String(visible)}</div>,
    },
    {
      id: "cost",
      title: "Cost",
      surface: "lane",
      render: ({ visible }) => <div data-testid="cost-panel">Cost Content visible={String(visible)}</div>,
    },
  ];

  it("renders ViewBoardMobileTabs with active tab indicator", () => {
    const markup = renderToStaticMarkup(
      <ViewBoardMobileTabs
        boards={sampleBoards}
        activeId="plan"
        onSelect={() => {}}
      />
    );
    expect(markup).toContain("Plan");
    expect(markup).toContain("Cost");
    expect(markup).toContain("aria-selected=\"true\"");
  });

  it("renders ViewBoardContextAction button with accessible title", () => {
    const markup = renderToStaticMarkup(
      <ViewBoardContextAction onAdd={() => {}} />
    );
    expect(markup).toContain("button");
    expect(markup).toContain("Add this board to context");
  });

  it("renders ViewBoardScopeSelector with session count options", () => {
    const markup = renderToStaticMarkup(
      <ViewBoardScopeSelector
        scope=""
        scopeLabel="All sessions"
        sessions={[
          {
            session_id: "sess-1",
            bot_id: "bot-1",
            bot_name: "Lead",
            is_primary: true,
          },
        ]}
        onSelect={() => {}}
      />
    );
    expect(markup).toContain("All sessions");
  });

  it("renders ViewBoardContent mounted and hidden panels based on visited set", () => {
    const markup = renderToStaticMarkup(
      <ViewBoardContent
        open={true}
        boards={sampleBoards}
        activeId="plan"
        visited={new Set(["plan", "cost"])}
        ctx={mockContext}
      />
    );
    // Active plan should be visible (h-full)
    expect(markup).toContain("Plan Content visible=true");
    // Visited cost should be mounted but hidden
    expect(markup).toContain("Cost Content visible=false");
    expect(markup).toContain("class=\"hidden\"");
  });

  it("does not render ViewBoardContent when closed", () => {
    const markup = renderToStaticMarkup(
      <ViewBoardContent
        open={false}
        boards={sampleBoards}
        activeId="plan"
        visited={new Set(["plan"])}
        ctx={mockContext}
      />
    );
    expect(markup).toBe("");
  });
});
