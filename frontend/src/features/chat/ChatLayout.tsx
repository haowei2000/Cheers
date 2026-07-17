import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { listWorkspaces, getPersonalWorkspace } from "@/api/workspaces";
import { listChannels, listDms } from "@/api/channels";
import toast from "react-hot-toast";
import { ErrorState } from "@/components/ui/error-state";
import { useChatStore } from "@/stores/chatStore";
import { useNotificationStore } from "@/stores/notificationStore";
import { useIsMobile } from "@/hooks/useIsMobile";
import { getActivePushChannel, markChatLayoutMounted } from "@/lib/push";
import { notifyNative } from "@/lib/desktop";
import { permissionContext } from "@/lib/desktopApproval";
import { isTauri } from "@/lib/serverConfig";
import { useUserSocket } from "./hooks/useUserSocket";
import { useTrayLiveness } from "@/features/desktop/useTrayLiveness";
import type { NotificationItem } from "@/api/notifications";
import type { PermissionContentData, PermissionOption } from "@/types";
import { WorkspaceRail } from "./WorkspaceRail";
import { Sidebar } from "./Sidebar";
import { ChannelView } from "./ChannelView";

// Human-readable byte size for the native banner context line.
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

// Best-effort filesystem path a permission request targets, for local stat +
// git status. Prefer the tool's working directory, then the first edit/read
// location (which may arrive as a bare string or a `{ path }` object).
function toolTargetPath(
  tool: PermissionContentData["tool"] | undefined
): string | null {
  if (!tool) return null;
  if (typeof tool.cwd === "string" && tool.cwd.trim()) return tool.cwd;
  const locs = tool.locations;
  if (Array.isArray(locs)) {
    for (const l of locs) {
      if (typeof l === "string" && l.trim()) return l;
      if (
        l &&
        typeof l === "object" &&
        typeof (l as { path?: unknown }).path === "string" &&
        (l as { path: string }).path.trim()
      ) {
        return (l as { path: string }).path;
      }
    }
  }
  return null;
}

export default function ChatLayout() {
  const {
    workspaces,
    channels,
    personalWorkspace,
    selectedWorkspaceId,
    selectedChannelId,
    setWorkspaces,
    setPersonalWorkspace,
    setChannels,
    selectWorkspace,
    hydrateSelection,
  } = useChatStore();
  const isMobile = useIsMobile();
  // Desktop tray + dock badge (no-op in the browser). Derives unread + pending
  // + agent-busy and pushes to the native shell.
  useTrayLiveness(selectedWorkspaceId, channels);
  const location = useLocation();
  const navigate = useNavigate();
  const { workspaceId: urlWorkspaceId, channelId: urlChannelId } = useParams();

  // Notification center bootstrap: hydrate the inbox once, then keep it live over a
  // user-scoped socket (invites arrive even with no channel open). Kept here because
  // ChatLayout is always mounted, whereas the rail (which shows the bell) is not on
  // mobile. See useUserSocket / NotificationCenter.
  const refreshNotifications = useNotificationStore((s) => s.refresh);
  const upsertNotification = useNotificationStore((s) => s.upsert);
  useEffect(() => {
    void refreshNotifications();
  }, [refreshNotifications]);
  useUserSocket((raw) => {
    // Desktop shell: permission_request / mention nudges arrive on this
    // user-scoped socket (the gateway mirrors its Web Push payloads here —
    // WKWebView has no Push API). Same suppression as the service worker:
    // don't nag about a channel that's focused on screen. Web ignores these
    // kinds, as before.
    const nudge = raw as {
      kind?: string;
      channel_id?: string;
      title?: string;
      body?: string;
      sender_name?: string | null;
      // Desktop-only enrichment fields the gateway adds to the WS copy (kept off
      // the 4 KB Web Push copy): the tool preview lets us stat the target path.
      request_id?: string;
      tool?: PermissionContentData["tool"];
      options?: PermissionOption[];
    } | null;
    if (nudge?.kind === "permission_request" || nudge?.kind === "mention") {
      if (
        isTauri() &&
        !(document.hasFocus() && nudge.channel_id === getActivePushChannel())
      ) {
        const title =
          nudge.kind === "mention"
            ? nudge.sender_name
              ? `${nudge.sender_name} mentioned you`
              : "You were mentioned"
            : nudge.title || "Approval needed";
        // For an approval, enrich the banner body with local context (repo
        // branch + dirty state, file size) statted from the tool's target
        // path. Best-effort: if the path is unknown or the stat fails, the
        // banner still fires with the plain body.
        const targetPath =
          nudge.kind === "permission_request" ? toolTargetPath(nudge.tool) : null;
        void (async () => {
          let body = nudge.body ?? "";
          if (targetPath) {
            const ctx = await permissionContext(targetPath);
            if (ctx) {
              const parts: string[] = [];
              if (ctx.branch) {
                parts.push(
                  ctx.dirty ? `${ctx.branch} (uncommitted)` : ctx.branch
                );
              }
              if (!ctx.exists) parts.push("new path");
              else if (!ctx.is_dir && ctx.size != null) {
                parts.push(formatBytes(ctx.size));
              }
              if (parts.length) {
                body = body ? `${body}\n${parts.join(" · ")}` : parts.join(" · ");
              }
            }
          }
          await notifyNative(title, body);
        })();
      }
      return;
    }
    const n = raw as NotificationItem | null;
    if (!n || (n.kind !== "workspace_invite" && n.kind !== "channel_invite")) return;
    upsertNotification(n);
    const where = n.kind === "channel_invite" ? `#${n.title}` : n.title;
    toast(`${n.invited_by ?? "Someone"} invited you to ${where}`, { icon: "🔔" });
  });
  // Mobile stacked navigation (Telegram-style): the conversation screen is "pushed"
  // over the list by writing `{ chat: true }` into the history entry's state, so the
  // browser/hardware Back button pops back to the list naturally.
  const chatPushed = Boolean((location.state as { chat?: boolean } | null)?.chat);
  // Mobile-only workspace/nav drawer (the desktop rail, slid in from the left).
  const [navOpen, setNavOpen] = useState(false);

  // ── URL ⇄ store selection sync ───────────────────────────────────────────────
  // The path owns the open workspace/channel: it's what survives a reload and what a
  // shared link carries. Every in-app selection still goes through the store (rail,
  // sidebar, dialogs), so the two are kept in step by a pair of effects. They can't
  // ping-pong: the first only runs when the *path* changed (its deps are the params),
  // the second only when the store disagrees with the path, and applying either makes
  // them agree.
  //
  // appliedPathRef records the last selection we reconciled, so a path we wrote
  // ourselves doesn't bounce back as an incoming change and undo a fresh selection.
  const appliedPathRef = useRef<string | null>(null);

  // Path → store: on mount, and on browser back/forward.
  useEffect(() => {
    const key = `${urlWorkspaceId ?? ""}/${urlChannelId ?? ""}`;
    if (appliedPathRef.current === key) return;
    appliedPathRef.current = key;
    // Bare /chat names no selection — leave the store alone and let the bootstrap
    // below pick the default, rather than blanking an already-good selection (this
    // is the path InvitePage/RegisterPage arrive on after joining a workspace).
    if (!urlWorkspaceId) return;
    hydrateSelection(urlWorkspaceId, urlChannelId ?? null);
  }, [urlWorkspaceId, urlChannelId, hydrateSelection]);

  // Store → path: mirror any in-app selection back out.
  useEffect(() => {
    if (!selectedWorkspaceId) return;
    const want = `/chat/${selectedWorkspaceId}${
      selectedChannelId ? `/${selectedChannelId}` : ""
    }`;
    if (want === location.pathname) return;
    appliedPathRef.current = `${selectedWorkspaceId}/${selectedChannelId ?? ""}`;
    // replace, not push: on mobile the conversation screen is itself a pushed history
    // entry (see openChatScreen), so a second entry per channel switch would make Back
    // land on the previous channel instead of popping to the channel list. `state` is
    // carried through for the same reason — dropping it would strip that push flag and
    // bounce the user out of the conversation they just opened.
    navigate(want, { replace: true, state: location.state });
  }, [
    selectedWorkspaceId,
    selectedChannelId,
    location.pathname,
    location.state,
    navigate,
  ]);

  // Load workspaces + the personal workspace on mount. The personal workspace is the
  // user's home (DMs + private space), so it's the default selection. On failure we
  // raise bootstrapFailed and show a retry panel in the main area instead of the
  // pristine empty states — an unreachable gateway must never look like a brand-new
  // account (mirrors BotsManager's loadFailed pattern).
  const [bootstrapFailed, setBootstrapFailed] = useState(false);
  const loadWorkspaces = useCallback(() => {
    Promise.all([listWorkspaces(), getPersonalWorkspace().catch(() => null)])
      .then(([ws, personal]) => {
        setWorkspaces(ws);
        if (personal) setPersonalWorkspace(personal);
        // Read the selection fresh instead of through this callback's closure: the
        // path hydrates the store while this request is in flight, so a captured
        // `null` here would overwrite the workspace the URL just restored.
        const current = useChatStore.getState().selectedWorkspaceId;
        const known =
          !!current &&
          (current === personal?.workspace_id ||
            ws.some((w) => w.workspace_id === current));
        // Fall back to the home workspace when nothing is selected, or when the path
        // named one this account can't see (a stale link, or someone else's). Without
        // the membership check the rail would sit on a workspace that renders empty.
        if (!known) {
          selectWorkspace(personal?.workspace_id ?? ws[0]?.workspace_id ?? null);
        }
        setBootstrapFailed(false);
      })
      .catch(() => {
        setBootstrapFailed(true);
        toast.error(
          "Couldn't load your workspaces — check the gateway connection, then retry."
        );
      });
  }, [setWorkspaces, setPersonalWorkspace, selectWorkspace]);
  useEffect(() => {
    loadWorkspaces();
    // Run once on mount; the Retry button re-invokes loadWorkspaces directly.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Load channels when the workspace changes. DMs are consolidated into the
  // personal workspace (the user's home), so they're fetched only there — team
  // workspaces show just their own channels, and DMs no longer duplicate across
  // every sidebar. Wrapped in a callback so mobile hardware-Back can re-run it
  // to refresh unread counts on return to the list.
  const refreshChannels = useCallback(() => {
    if (!selectedWorkspaceId) return;
    const isPersonal =
      !!personalWorkspace && selectedWorkspaceId === personalWorkspace.workspace_id;
    Promise.all([
      listChannels(selectedWorkspaceId),
      isPersonal ? listDms().catch(() => []) : Promise.resolve([]),
    ])
      .then(([chs, dms]) => setChannels([...chs, ...dms]))
      .catch(() => {
        toast.error("Couldn't load channels — check the gateway connection.");
      });
  }, [selectedWorkspaceId, personalWorkspace, setChannels]);

  useEffect(() => {
    refreshChannels();
  }, [refreshChannels]);

  // Desktop: collapsible channel sidebar (the workspace rail always stays). The
  // preference survives reloads; ⌘/Ctrl+B mirrors the header toggle button.
  const [sidebarOpen, setSidebarOpen] = useState(
    () => localStorage.getItem("cheers.sidebar.open") !== "0"
  );
  const toggleSidebar = useCallback(() => {
    setSidebarOpen((o) => {
      try {
        localStorage.setItem("cheers.sidebar.open", o ? "0" : "1");
      } catch {
        /* ignore */
      }
      return !o;
    });
  }, []);
  useEffect(() => {
    // Desktop-only chrome: on mobile the shortcut would do nothing visible but
    // still persist a hidden-sidebar preference for the next desktop session.
    if (isMobile) return;
    const isMac = /Mac/i.test(navigator.platform || navigator.userAgent);
    const onKey = (e: KeyboardEvent) => {
      // Platform-appropriate modifier ONLY: on macOS Ctrl+B is native
      // move-cursor-back in text fields — never intercept it there.
      const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      if (!mod || e.shiftKey || e.altKey || e.key.toLowerCase() !== "b") return;
      // Don't steal the keystroke from editable targets (composer, dialogs).
      const t = e.target;
      if (
        t instanceof HTMLElement &&
        (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))
      )
        return;
      e.preventDefault();
      toggleSidebar();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isMobile, toggleSidebar]);

  // Mobile: picking a channel pushes the conversation screen.
  const openChatScreen = useCallback(() => {
    setNavOpen(false);
    if (!chatPushed) navigate(location.pathname, { state: { chat: true } });
  }, [chatPushed, navigate, location.pathname]);

  // Web Push deep links: announce that store-driven channel selection can
  // navigate (the bridge itself lives in App). A clicked notification selects
  // the channel through the store; on mobile the conversation screen must
  // additionally be pushed, which is this layout's private history
  // convention — hence the event rather than a store field.
  useEffect(() => markChatLayoutMounted(), []);
  useEffect(() => {
    const onPushOpen = () => {
      if (isMobile) openChatScreen();
    };
    window.addEventListener("cheers:push-open-chat", onPushOpen);
    return () => window.removeEventListener("cheers:push-open-chat", onPushOpen);
  }, [isMobile, openChatScreen]);

  // Mobile: header back (or browser Back) returns to the list. Prefer a real history
  // pop so the stack stays clean; fall back to replace when this is the first entry
  // (e.g. the page was reloaded while the conversation was open).
  const closeChatScreen = useCallback(() => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) navigate(-1);
    else navigate(location.pathname, { replace: true });
  }, [navigate, location.pathname]);

  // Mobile: refetch the channel list whenever the conversation screen is popped, to
  // pick up read/unread changes made while chatting. Watching the chatPushed
  // transition covers both back paths — the header back button *and* the
  // browser/hardware back gesture, which pops the history entry without going
  // through closeChatScreen.
  const prevChatPushed = useRef(chatPushed);
  useEffect(() => {
    const wasPushed = prevChatPushed.current;
    prevChatPushed.current = chatPushed;
    if (isMobile && wasPushed && !chatPushed) refreshChannels();
  }, [isMobile, chatPushed, refreshChannels]);

  // The personal workspace is fetched separately (listWorkspaces excludes it), so
  // resolve it from personalWorkspace — otherwise Sidebar gets no workspace, treats
  // it as non-personal, and drops the Direct Messages section (+ its "New DM" button).
  const selectedWorkspace =
    personalWorkspace && selectedWorkspaceId === personalWorkspace.workspace_id
      ? personalWorkspace
      : workspaces.find((w) => w.workspace_id === selectedWorkspaceId);
  const selectedChannel =
    channels.find((c) => c.channel_id === selectedChannelId) ?? null;

  // Shown in the main area when the mount-time load failed, so a dead gateway
  // surfaces a reason + retry instead of silent empty states.
  const bootstrapErrorPanel = (
    <ErrorState
      className="flex-1"
      title="Couldn't load your workspaces"
      description="Check the gateway connection, then retry."
      action={{ label: "Retry", onClick: loadWorkspaces }}
    />
  );

  if (isMobile) {
    const showChat = chatPushed && !!selectedChannel;
    return (
      <div className="flex h-full bg-zinc-950 overflow-hidden">
        {showChat ? (
          <main className="flex-1 min-w-0 flex flex-col">
            <ChannelView channel={selectedChannel} onBack={closeChatScreen} />
          </main>
        ) : bootstrapFailed ? (
          <main className="flex-1 min-w-0 flex flex-col">{bootstrapErrorPanel}</main>
        ) : (
          <>
            <Sidebar
              workspace={selectedWorkspace}
              onOpenNav={() => setNavOpen(true)}
              onChannelSelected={openChatScreen}
            />
            {navOpen && (
              <div className="fixed inset-0 z-50 flex">
                <div
                  className="absolute inset-0 bg-black/50"
                  onClick={() => setNavOpen(false)}
                  aria-hidden
                />
                <div className="relative h-full flex shadow-2xl">
                  <WorkspaceRail onAction={() => setNavOpen(false)} />
                </div>
              </div>
            )}
          </>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full bg-zinc-950">
      <WorkspaceRail />
      {/* CSS-hidden (not unmounted) so sidebar-hosted dialogs (New DM / New
          channel / workspace settings) and their drafts survive a toggle. */}
      <div className={sidebarOpen ? "contents" : "hidden"}>
        <Sidebar workspace={selectedWorkspace} />
      </div>
      <main className="flex-1 min-w-0 flex flex-col">
        {bootstrapFailed ? (
          bootstrapErrorPanel
        ) : (
          <ChannelView
            channel={selectedChannel}
            sidebarOpen={sidebarOpen}
            onToggleSidebar={toggleSidebar}
          />
        )}
      </main>
    </div>
  );
}
