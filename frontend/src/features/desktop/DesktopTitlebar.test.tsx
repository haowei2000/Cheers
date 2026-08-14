import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Hash } from "lucide-react";
import { DesktopTitlebarChrome, resolveDesktopTitlebarContext } from "./DesktopTitlebar";

describe("DesktopTitlebar", () => {
  it("shows the current workspace and channel in chat", () => {
    expect(resolveDesktopTitlebarContext("/chat/workspace/channel", {
      workspace: { workspace_id: "workspace", name: "Engineering" },
      channel: { channel_id: "channel", name: "release", type: "public" },
    })).toEqual({ title: "Engineering", subtitle: "#release" });
  });

  it("uses a personal page title outside chat", () => {
    expect(resolveDesktopTitlebarContext("/fleet/installations", {})).toEqual({ title: "Fleet" });
    expect(resolveDesktopTitlebarContext("/activity", {})).toEqual({ title: "Activity" });
  });

  it("keeps drag regions separate from interactive controls", () => {
    const markup = renderToStaticMarkup(
      <DesktopTitlebarChrome
        context={{ title: "Engineering", subtitle: "#release" }}
        contextIcon={Hash}
        authenticated
        activePath="/chat/workspace/channel"
        canBack
        canForward={false}
        sidebarOpen
        onToggleSidebar={() => {}}
        onBack={() => {}}
        onForward={() => {}}
      />
    );
    expect(markup).toContain("data-tauri-drag-region");
    expect(markup).toContain("<button");
    expect(markup).toContain('aria-label="Context toolbar"');
    expect(markup).toContain('data-window-chrome="macos-overlay"');
    expect(markup).toContain("bg-sidebar");
    expect(markup).toContain("bg-zinc-950");
    expect(markup).toContain('data-window-sidebar-surface="true"');
    expect(markup).toContain('style="width:296px"');
    expect(markup).not.toContain("bg-rail");
    expect(markup).toContain('aria-label="Hide channel sidebar (Command B)"');
    expect(markup).not.toContain("border-b border-zinc-800");
    expect(markup).not.toContain('aria-label="Activity"');
    expect(markup).not.toContain('aria-label="Fleet"');
    expect(markup).not.toMatch(/<nav[^>]*data-tauri-drag-region/);
  });

  it("removes the sidebar surface while preserving the native traffic-light safe area when closed", () => {
    const markup = renderToStaticMarkup(
      <DesktopTitlebarChrome
        context={{ title: "Engineering", subtitle: "#release" }}
        contextIcon={Hash}
        authenticated
        activePath="/chat/workspace/channel"
        canBack={false}
        canForward={false}
        sidebarOpen={false}
        onToggleSidebar={() => {}}
        onBack={() => {}}
        onForward={() => {}}
      />
    );

    expect(markup).toMatch(/class="[^"]*h-full[^"]*w-24[^"]*"/);
    expect(markup).not.toContain('data-window-sidebar-surface="true"');
    expect(markup).toContain('aria-label="Show channel sidebar (Command B)"');
  });

  it("does not invent a sidebar surface for non-chat route frames", () => {
    const markup = renderToStaticMarkup(
      <DesktopTitlebarChrome
        context={{ title: "Fleet" }}
        contextIcon={Hash}
        authenticated
        activePath="/fleet"
        canBack
        canForward={false}
        onBack={() => {}}
        onForward={() => {}}
      />
    );

    expect(markup).not.toContain("bg-rail");
    expect(markup).not.toContain("bg-sidebar");
  });

  it("releases the traffic-light inset in macOS fullscreen", () => {
    const markup = renderToStaticMarkup(
      <DesktopTitlebarChrome
        context={{ title: "Engineering" }}
        contextIcon={Hash}
        authenticated
        activePath="/chat/workspace"
        canBack={false}
        canForward={false}
        windowState={{ active: true, fullscreen: true, maximized: false, scaleFactor: 2 }}
        sidebarOpen={false}
        onToggleSidebar={() => {}}
        onBack={() => {}}
        onForward={() => {}}
      />
    );

    expect(markup).toContain('data-window-fullscreen="true"');
    expect(markup).toMatch(/class="[^"]*h-full[^"]*w-2[^"]*"/);
    expect(markup).not.toMatch(/class="[^"]*h-full[^"]*w-24[^"]*"/);
  });

  it("uses a non-draggable command bar below the native Windows title bar", () => {
    const markup = renderToStaticMarkup(
      <DesktopTitlebarChrome
        context={{ title: "Engineering", subtitle: "#release" }}
        contextIcon={Hash}
        authenticated
        activePath="/chat/workspace/channel"
        canBack
        canForward={false}
        platform="windows"
        variant="desktop-commandbar"
        sidebarOpen
        onToggleSidebar={() => {}}
        onBack={() => {}}
        onForward={() => {}}
      />
    );

    expect(markup).toContain('aria-label="Application toolbar"');
    expect(markup).toContain('data-window-chrome="desktop-commandbar"');
    expect(markup).toContain('aria-label="Hide channel sidebar (Control B)"');
    expect(markup).not.toContain("data-tauri-drag-region");
  });
});
