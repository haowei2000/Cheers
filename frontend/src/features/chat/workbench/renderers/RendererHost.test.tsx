import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ThemeProvider } from "@/components/ui/theme";
import { RendererErrorBoundary, RendererFallbackView, RendererHost } from "./RendererHost";
import type { RendererDesc } from "./registry";
import type { WorkbenchContext } from "../context";
import type { FileSession } from "../jsonFile";
import "../lens/builtins"; // Register built-in lenses

const renderWithTheme = (node: React.ReactNode) =>
  renderToStaticMarkup(<ThemeProvider>{node}</ThemeProvider>);

const mockContext: WorkbenchContext = {
  active: true,
  channelId: "test-channel",
  fs: {
    ls: vi.fn().mockResolvedValue({ entries: [] }),
    read: vi.fn().mockResolvedValue({ content: "test content", version: 1 }),
    write: vi.fn().mockResolvedValue({ version: 2 }),
    patch: vi.fn().mockResolvedValue({ version: 2 }),
    rm: vi.fn().mockResolvedValue(undefined),
  },
  sendResourceReq: vi.fn().mockResolvedValue({}),
  pinned: [],
  togglePin: vi.fn(),
  rendererExtensions: [],
  bindings: {},
  setBinding: vi.fn(),
  configs: {},
};

const mockSession: FileSession = {
  path: "test.md",
  text: "# Hello World",
  data: "# Hello World",
  parsedText: "# Hello World",
  version: 1,
  dirty: false,
  saving: false,
  status: null,
  setStatus: vi.fn(),
  autoSave: true,
  setAutoSave: vi.fn(),
  parseError: null,
  conflictNotice: null,
  reload: vi.fn().mockResolvedValue(undefined),
  save: vi.fn().mockResolvedValue(undefined),
  editText: vi.fn(),
  setData: vi.fn(),
  applyOps: vi.fn().mockResolvedValue(undefined),
  resolveConflict: vi.fn().mockResolvedValue(undefined),
};

describe("RendererFallbackView", () => {
  it("renders failure notice and degrades gracefully with session", () => {
    const markup = renderWithTheme(
      <RendererFallbackView
        rendererTitle="Custom Kanban"
        reason="Extension crashed"
        path="board.json"
        session={mockSession}
        onRetry={vi.fn()}
      />
    );

    expect(markup).toContain('data-testid="renderer-fallback"');
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Custom Kanban failed: Extension crashed. Degraded to Raw mode.");
    expect(markup).toContain("Retry");
  });

  it("handles standalone view when session is absent", () => {
    const markup = renderWithTheme(
      <RendererFallbackView
        rendererTitle="Custom Kanban"
        reason="Extension crashed"
        path="board.json"
      />
    );

    expect(markup).toContain('data-testid="renderer-fallback"');
    expect(markup).toContain("Source editor unavailable for standalone view.");
  });
});

describe("RendererErrorBoundary", () => {
  it("derives state and reports error properly", () => {
    const derived = RendererErrorBoundary.getDerivedStateFromError(new Error("Crash boom"));
    expect(derived).toEqual({ hasError: true, error: "Crash boom" });
  });

  it("notifies onFailure callback on componentDidCatch", () => {
    const onFailure = vi.fn();
    const renderer: RendererDesc = {
      id: "personal:custom:board",
      title: "Board",
      format: ["json"],
      source: "extension",
      match: {},
    };

    const boundary = new RendererErrorBoundary({
      renderer,
      path: "board.json",
      onFailure,
      retryKey: 0,
      onRetry: vi.fn(),
      children: null,
    });

    const error = new Error("Component exploded");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    boundary.componentDidCatch(error, { componentStack: "" });
    spy.mockRestore();

    expect(onFailure).toHaveBeenCalledWith("personal:custom:board", "Component exploded");
  });

  it("renders fallback view when in error state", () => {
    const renderer: RendererDesc = {
      id: "personal:custom:board",
      title: "Board",
      format: ["json"],
      source: "extension",
      match: {},
    };

    const boundary = new RendererErrorBoundary({
      renderer,
      path: "board.json",
      session: mockSession,
      retryKey: 0,
      onRetry: vi.fn(),
      children: <div>Normal</div>,
    });

    boundary.state = { hasError: true, error: "Fatal render failure" };
    const markup = renderWithTheme(boundary.render());

    expect(markup).toContain('data-testid="renderer-fallback"');
    expect(markup).toContain("Board failed: Fatal render failure. Degraded to Raw mode.");
    expect(markup).toContain("Retry");
  });
});

describe("RendererHost", () => {
  it("degrades gracefully to Raw mode when extension is not installed", () => {
    const extensionRenderer: RendererDesc = {
      id: "personal:missing-ext:renderer",
      title: "Missing Ext",
      format: ["json"],
      source: "extension",
      extensionId: "missing-ext",
      rendererId: "renderer",
      match: {},
    };

    const markup = renderWithTheme(
      <RendererHost
        ctx={mockContext}
        path="data.json"
        renderer={extensionRenderer}
        session={mockSession}
      />
    );

    expect(markup).toContain('data-testid="renderer-fallback"');
    expect(markup).toContain("Missing Ext failed: Renderer extension not installed: missing-ext. Degraded to Raw mode.");
  });

  it("renders built-in markdown lens with session", () => {
    const builtinRenderer: RendererDesc = {
      id: "builtin:markdown",
      title: "Markdown",
      format: ["markdown"],
      source: "builtin",
      lensId: "markdown",
      match: {},
    };

    const markup = renderWithTheme(
      <RendererHost
        ctx={mockContext}
        path="notes.md"
        renderer={builtinRenderer}
        session={mockSession}
      />
    );

    expect(markup).toContain('data-workbench-context-target="markdown"');
    expect(markup).toContain("# Hello World");
  });
});
