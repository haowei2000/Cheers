import { useEffect, useMemo, useState, type ReactNode, type RefCallback } from "react";
import {
  ArrowLeft,
  Bell,
  Building2,
  Hash,
  PanelLeftClose,
  PanelLeftOpen,
  Radar,
  Search,
  Settings,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { Dialog } from "@/components/ui/dialog";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { ItemList, NavigationItem } from "@/components/ui/item";
import { controlIconClasses } from "@/components/ui/control-size";
import { useAuthStore } from "@/stores/authStore";
import { useChatStore } from "@/stores/chatStore";
import { WindowChromeProvider } from "./WindowChromeContext";
import {
  resolveDesktopPlatform,
  resolveWindowChromeVariant,
  type DesktopPlatform,
  type WindowChromeVariant,
} from "./desktopPlatform";
import {
  useDesktopWindowState,
  type DesktopWindowState,
} from "./WindowStateBridge";
import {
  createWindowChromePaneGeometry,
  macosNativeControlsInset,
  type WindowChromePaneGeometry,
} from "./WindowChromeModel";
import type { Channel, Workspace as WorkspaceModel } from "@/types";

type TitlebarContext = {
  title: string;
  subtitle?: string;
};

type ChatContext = {
  workspace?: WorkspaceModel;
  channel?: Channel;
};

const pageTitles: Record<string, string> = {
  activity: "Activity",
  fleet: "Fleet",
  friends: "Friends",
  settings: "Settings",
  login: "Sign in",
  register: "Create account",
  forgot: "Reset password",
  reset: "Reset password",
  invite: "Invitation",
  "mcp-authorize": "Connect Cheers MCP",
  auth: "Signing in",
};

export function resolveDesktopTitlebarContext(pathname: string, chat: ChatContext): TitlebarContext {
  const section = pathname.split("/").filter(Boolean)[0] ?? "chat";
  if (section === "chat") {
    const title = chat.workspace?.name ?? "Cheers";
    if (!chat.channel) return { title };
    const channelName = chat.channel.peer_name || chat.channel.name || "Conversation";
    return {
      title,
      subtitle: chat.channel.type === "dm" ? channelName : `#${channelName}`,
    };
  }
  return { title: pageTitles[section] ?? "Cheers" };
}

export function resolveDesktopParentPath(pathname: string): string | null {
  const segments = pathname.split("/").filter(Boolean);
  const [section] = segments;

  if (section === "chat") {
    if (segments.length >= 3) return `/chat/${segments[1]}`;
    return null;
  }

  if (section === "fleet") {
    if (segments[1] === "bots" && segments.length > 2) return "/fleet/bots";
    if (segments.length > 1) return "/fleet";
    return "/chat";
  }

  if (section === "settings" || section === "friends") {
    if (segments.length > 1) return `/${section}`;
    return "/chat";
  }

  if (section === "activity") return "/chat";
  return null;
}

type SearchEntry = {
  id: string;
  label: string;
  detail: string;
  path: string;
  Icon: typeof Search;
};

function DesktopSearch({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const { workspaces, personalWorkspace, channels, selectedWorkspaceId } = useChatStore();

  const entries = useMemo<SearchEntry[]>(() => {
    const destinations: SearchEntry[] = [
      { id: "activity", label: "Activity", detail: "Approvals and invitations", path: "/activity", Icon: Bell },
      { id: "fleet", label: "Fleet", detail: "Bots, installations, and audit", path: "/fleet", Icon: Radar },
      { id: "friends", label: "Friends", detail: "Friends and requests", path: "/friends", Icon: Users },
      { id: "settings", label: "Settings", detail: "Account and application settings", path: "/settings", Icon: Settings },
    ];
    const allWorkspaces = [personalWorkspace, ...workspaces].filter(
      (workspace, index, items): workspace is WorkspaceModel =>
        !!workspace && items.findIndex((candidate) => candidate?.workspace_id === workspace.workspace_id) === index
    );
    const workspaceEntries = allWorkspaces.map<SearchEntry>((workspace) => ({
      id: `workspace:${workspace.workspace_id}`,
      label: workspace.name,
      detail: workspace.kind === "personal" ? "Personal workspace" : "Workspace",
      path: `/chat/${workspace.workspace_id}`,
      Icon: Building2,
    }));
    const channelEntries = selectedWorkspaceId
      ? channels.map<SearchEntry>((channel) => ({
          id: `channel:${channel.channel_id}`,
          label: channel.peer_name || channel.name || "Conversation",
          detail: channel.type === "dm" ? "Direct message" : "Channel",
          path: `/chat/${selectedWorkspaceId}/${channel.channel_id}`,
          Icon: Hash,
        }))
      : [];
    return [...destinations, ...workspaceEntries, ...channelEntries];
  }, [channels, personalWorkspace, selectedWorkspaceId, workspaces]);

  const normalized = query.trim().toLocaleLowerCase();
  const visible = entries.filter((entry) =>
    !normalized || `${entry.label} ${entry.detail}`.toLocaleLowerCase().includes(normalized)
  );

  const open = (path: string) => {
    onClose();
    navigate(path);
  };

  return (
    <Dialog title="Search Cheers" onClose={onClose} maxWidth="max-w-lg">
      <div className="space-y-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" aria-hidden="true" />
          <span className="sr-only">Search pages, workspaces, and channels</span>
          <Input
            autoFocus
            inset="leading"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search pages, workspaces, and channels…"
            aria-label="Search pages, workspaces, and channels"
          />
        </div>
        {visible.length > 0 ? (
          <ItemList presentationLevel="medium" controlSize="regular" className="max-h-80 overflow-y-auto">
            {visible.map((entry) => (
              <NavigationItem
                key={entry.id}
                title={entry.label}
                subtitle={entry.detail}
                leading={<entry.Icon className="h-4 w-4 text-zinc-400" aria-hidden="true" />}
                onClick={() => open(entry.path)}
              />
            ))}
          </ItemList>
        ) : (
          <p className="py-5 text-center text-compact text-zinc-400">No matching destination</p>
        )}
      </div>
    </Dialog>
  );
}

export function DesktopTitlebar({
  platform,
  variant,
  windowState,
  panes,
  onToggleSidebar,
  actionsRef,
}: {
  platform: DesktopPlatform;
  variant: Exclude<WindowChromeVariant, "inline">;
  windowState: DesktopWindowState;
  panes?: WindowChromePaneGeometry;
  onToggleSidebar?: () => void;
  actionsRef?: RefCallback<HTMLElement>;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const user = useAuthStore((state) => state.user);
  const { workspaces, personalWorkspace, channels, selectedWorkspaceId, selectedChannelId } = useChatStore();
  const [searchOpen, setSearchOpen] = useState(false);

  const workspace =
    selectedWorkspaceId === personalWorkspace?.workspace_id
      ? personalWorkspace
      : workspaces.find((candidate) => candidate.workspace_id === selectedWorkspaceId);
  const channel = channels.find((candidate) => candidate.channel_id === selectedChannelId);
  const context = resolveDesktopTitlebarContext(location.pathname, { workspace, channel });
  const section = location.pathname.split("/").filter(Boolean)[0] ?? "chat";
  const contextIcons: Record<string, LucideIcon> = {
    activity: Bell,
    fleet: Radar,
    friends: Users,
    settings: Settings,
  };
  const ContextIcon = section === "chat" ? (channel ? Hash : Building2) : (contextIcons[section] ?? Building2);
  const parentPath = user ? resolveDesktopParentPath(location.pathname) : null;

  useEffect(() => {
    if (!user) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const modifier = platform === "macos" ? event.metaKey : event.ctrlKey;
      if (modifier && !event.altKey && !event.shiftKey && event.key.toLocaleLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [platform, user]);

  return (
    <>
      <DesktopTitlebarChrome
        context={context}
        contextIcon={ContextIcon}
        authenticated={!!user}
        activePath={location.pathname}
        canNavigateUp={!!parentPath}
        platform={platform}
        variant={variant}
        windowState={windowState}
        panes={panes}
        onToggleSidebar={onToggleSidebar}
        onNavigateUp={() => {
          if (parentPath) navigate(parentPath);
        }}
        actionsRef={actionsRef}
      />
      {searchOpen && <DesktopSearch onClose={() => setSearchOpen(false)} />}
    </>
  );
}

export function DesktopTitlebarChrome({
  context,
  contextIcon: ContextIcon,
  authenticated,
  activePath,
  canNavigateUp,
  platform = "macos",
  variant = "macos-overlay",
  windowState,
  panes,
  sidebarOpen,
  onToggleSidebar,
  onNavigateUp,
  actionsRef,
}: {
  context: TitlebarContext;
  contextIcon: LucideIcon;
  authenticated: boolean;
  activePath: string;
  canNavigateUp: boolean;
  platform?: DesktopPlatform;
  variant?: Exclude<WindowChromeVariant, "inline">;
  windowState?: DesktopWindowState;
  panes?: WindowChromePaneGeometry;
  /** Compatibility input for focused renderer tests; frames pass `panes`. */
  sidebarOpen?: boolean;
  onToggleSidebar?: () => void;
  onNavigateUp: () => void;
  actionsRef?: RefCallback<HTMLElement>;
}) {
  const resolvedWindowState = windowState ?? {
    active: true,
    fullscreen: false,
    maximized: false,
    scaleFactor: 1,
  };
  const resolvedPanes = panes ?? createWindowChromePaneGeometry(sidebarOpen);
  const isMacOverlay = variant === "macos-overlay";
  const nativeControlsInset = isMacOverlay
    ? macosNativeControlsInset(resolvedWindowState.fullscreen)
    : 0;
  const shortcut = platform === "macos" ? "Command B" : "Control B";
  const dragRegion = isMacOverlay ? { "data-tauri-drag-region": true } : {};

  return (
    <header
      className="relative z-40 flex h-11 flex-shrink-0 select-none items-center bg-zinc-950 text-zinc-100"
      data-window-chrome={variant}
      data-window-active={resolvedWindowState.active ? "true" : "false"}
      data-window-fullscreen={resolvedWindowState.fullscreen ? "true" : "false"}
      aria-label={isMacOverlay ? "Window toolbar" : "Application toolbar"}
    >
      {resolvedPanes?.sidebarOpen && (
        <div
          className="pointer-events-none absolute inset-y-0 left-0 bg-sidebar"
          style={{ width: resolvedPanes.railWidth + resolvedPanes.sidebarWidth }}
          data-window-sidebar-surface="true"
          aria-hidden="true"
        />
      )}
      <div
        {...dragRegion}
        className={`relative z-10 h-full flex-shrink-0 ${
          nativeControlsInset === 96 ? "w-24" : "w-2"
        }`}
        aria-hidden="true"
      />
      <nav aria-label="Window navigation" className="relative z-10 flex flex-shrink-0 items-center gap-1">
        {authenticated && activePath.startsWith("/chat") && onToggleSidebar && (
          <IconButton
            label={`${resolvedPanes?.sidebarOpen ? "Hide" : "Show"} channel sidebar (${shortcut})`}
            controlSize="regular"
            onClick={onToggleSidebar}
          >
            {resolvedPanes?.sidebarOpen ? (
              <PanelLeftClose className={controlIconClasses.regular} aria-hidden="true" />
            ) : (
              <PanelLeftOpen className={controlIconClasses.regular} aria-hidden="true" />
            )}
          </IconButton>
        )}
        <IconButton label="Up one level" controlSize="regular" disabled={!canNavigateUp} onClick={onNavigateUp}>
          <ArrowLeft className={controlIconClasses.regular} aria-hidden="true" />
        </IconButton>
      </nav>
      <div {...dragRegion} className="relative z-10 flex h-full min-w-0 flex-1 items-center justify-center px-3">
        <div {...dragRegion} className="flex min-w-0 items-center gap-2 text-regular">
          <ContextIcon {...dragRegion} className="h-4 w-4 flex-shrink-0 text-zinc-400" aria-hidden="true" />
          <span {...dragRegion} className="truncate font-semibold">{context.title}</span>
          {context.subtitle && (
            <>
              <span {...dragRegion} className="text-zinc-400" aria-hidden="true">/</span>
              <span {...dragRegion} className="truncate text-zinc-400">{context.subtitle}</span>
            </>
          )}
        </div>
      </div>
      <nav
        ref={actionsRef}
        aria-label="Context toolbar"
        className="relative z-10 flex flex-shrink-0 items-center gap-1 pr-2"
      />
      <div {...dragRegion} className="relative z-10 h-full w-2 flex-shrink-0" aria-hidden="true" />
    </header>
  );
}

export function DesktopWindowFrame({ children }: { children: ReactNode }) {
  if (resolveDesktopPlatform() === "web") return <>{children}</>;
  return (
    <div className="h-full min-h-0 bg-zinc-950">{children}</div>
  );
}

export function DesktopPageFrame({ children }: { children: ReactNode }) {
  const [actionsTarget, setActionsTarget] = useState<HTMLElement | null>(null);
  const platform = resolveDesktopPlatform();
  const windowState = useDesktopWindowState(platform);
  const variant = resolveWindowChromeVariant(platform);
  if (platform === "web" || variant === "inline") return <>{children}</>;
  return (
    <WindowChromeProvider
      placement="window"
      actionsTarget={actionsTarget}
      platform={platform}
      variant={variant}
      windowState={windowState}
    >
      <div className="flex h-full min-h-0 flex-col bg-zinc-950">
        <DesktopTitlebar
          platform={platform}
          variant={variant}
          windowState={windowState}
          actionsRef={setActionsTarget}
        />
        <div className="min-h-0 flex-1">{children}</div>
      </div>
    </WindowChromeProvider>
  );
}

export function DesktopChatFrame({
  sidebarOpen,
  onToggleSidebar,
  children,
}: {
  sidebarOpen: boolean;
  onToggleSidebar?: () => void;
  children: ReactNode;
}) {
  const [actionsTarget, setActionsTarget] = useState<HTMLElement | null>(null);
  const platform = resolveDesktopPlatform();
  const windowState = useDesktopWindowState(platform);
  const variant = resolveWindowChromeVariant(platform);
  const panes = createWindowChromePaneGeometry(sidebarOpen);
  if (platform === "web" || variant === "inline") return <>{children}</>;
  return (
    <WindowChromeProvider
      placement="window"
      actionsTarget={actionsTarget}
      platform={platform}
      variant={variant}
      windowState={windowState}
      panes={panes}
    >
      <div className="flex h-full min-h-0 flex-col bg-zinc-950">
        <DesktopTitlebar
          platform={platform}
          variant={variant}
          windowState={windowState}
          panes={panes}
          onToggleSidebar={onToggleSidebar}
          actionsRef={setActionsTarget}
        />
        <div className="min-h-0 flex-1">{children}</div>
      </div>
    </WindowChromeProvider>
  );
}
