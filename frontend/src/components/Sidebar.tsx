import { useEffect, useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";
import type { Channel, DM, Workspace, CurrentUser } from "../types";
import { apiFetch } from "../api";
import { refreshChannels, refreshDMs, refreshWorkspaces } from "../lib/refresh";

type SearchResultsPayload = {
  q: string;
  channels: {
    channel_id: string;
    name: string;
    workspace_id: string;
    type: string;
  }[];
  users: {
    user_id: string;
    username: string;
    display_name: string | null;
    avatar_url: string | null;
  }[];
  bots: {
    bot_id: string;
    username: string;
    display_name: string | null;
    avatar_url: string | null;
  }[];
};

interface SidebarProps {
  isMobile: boolean;
  sidebarOpen: boolean;
  leftWidth: number;
  onLeftResize: (e: React.MouseEvent) => void;

  currentUser: CurrentUser;
  authToken: string | null;
  onLoginClick: () => void;

  workspaces: Workspace[];
  setWorkspaces: (w: Workspace[]) => void;
  selectedWorkspaceId: string;
  setSelectedWorkspaceId: (id: string) => void;

  channels: Channel[];
  setChannels: React.Dispatch<React.SetStateAction<Channel[]>>;
  dms?: DM[];
  setDMs?: React.Dispatch<React.SetStateAction<DM[]>>;
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;

  setSidebarOpen: (open: boolean) => void;

  onOpenCreateWorkspace: () => void;
  onOpenInviteWsMember: () => void;
  onOpenCreateChannel: () => void;
  onOpenSettings: () => void;
}

const WS_LETTER_COLORS = ["#7c6cf5", "#3ecf8e", "#f5a623", "#56a7ff", "#f05454", "#9586ff"];
const wsColor = (id: string) => {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return WS_LETTER_COLORS[h % WS_LETTER_COLORS.length];
};

export function Sidebar({
  isMobile,
  sidebarOpen,
  leftWidth,
  onLeftResize,
  currentUser,
  authToken,
  onLoginClick,
  workspaces,
  setWorkspaces,
  selectedWorkspaceId,
  setSelectedWorkspaceId,
  channels,
  setChannels,
  dms = [],
  setDMs,
  selectedId,
  setSelectedId,
  setSidebarOpen,
  onOpenCreateWorkspace,
  onOpenInviteWsMember,
  onOpenCreateChannel,
  onOpenSettings,
}: SidebarProps) {
  const currentWs = workspaces.find((w) => w.workspace_id === selectedWorkspaceId);
  const currentWsLabel = currentWs ? currentWs.name : "全部工作空间";
  const currentWsLetter = currentWs ? currentWs.name.slice(0, 1).toUpperCase() : "∗";
  const currentWsAccent = currentWs ? wsColor(currentWs.workspace_id) : "var(--accent)";

  const [wsMenuOpen, setWsMenuOpen] = useState(false);
  const wsMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!wsMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (wsMenuRef.current && !wsMenuRef.current.contains(e.target as Node)) {
        setWsMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [wsMenuOpen]);

  const userInitial = currentUser?.display_name?.slice(0, 1)?.toUpperCase() || "?";
  const userColor = currentUser
    ? wsColor(currentUser.user_id || currentUser.display_name || "u")
    : "var(--accent)";

  // ── ⌘K global search ────────────────────────────────────────────────────
  const [searchQ, setSearchQ] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResultsPayload | null>(
    null,
  );
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const searchWrapRef = useRef<HTMLDivElement | null>(null);

  // ⌘K / Ctrl-K focus; Esc closes
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      } else if (e.key === "Escape" && searchOpen) {
        setSearchOpen(false);
        searchInputRef.current?.blur();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [searchOpen]);

  // Click-outside closes popover
  useEffect(() => {
    if (!searchOpen) return;
    const handler = (e: MouseEvent) => {
      if (
        searchWrapRef.current &&
        !searchWrapRef.current.contains(e.target as Node)
      ) {
        setSearchOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [searchOpen]);

  // Debounced query
  useEffect(() => {
    const q = searchQ.trim();
    if (!q) {
      setSearchResults(null);
      setSearchBusy(false);
      return;
    }
    setSearchBusy(true);
    const timer = setTimeout(() => {
      apiFetch(`search?q=${encodeURIComponent(q)}&limit=5`, {
        token: authToken ?? undefined,
      })
        .then((r) => r.json())
        .then((d) => {
          if (d?.data) setSearchResults(d.data as SearchResultsPayload);
        })
        .catch(() => {})
        .finally(() => setSearchBusy(false));
    }, 150);
    return () => clearTimeout(timer);
  }, [searchQ, authToken]);

  const dmWorkspaceId = useMemo(
    () => selectedWorkspaceId || workspaces[0]?.workspace_id || "",
    [selectedWorkspaceId, workspaces],
  );

  const resetSearch = () => {
    setSearchQ("");
    setSearchResults(null);
    setSearchOpen(false);
  };

  const openChannelHit = (channelId: string) => {
    setSelectedId(channelId);
    resetSearch();
    if (isMobile) setSidebarOpen(false);
  };

  const openDmWith = async (
    memberId: string,
    memberType: "user" | "bot",
  ) => {
    if (!dmWorkspaceId) {
      toast.error("请先选择工作空间");
      return;
    }
    try {
      const r = await apiFetch("dms", {
        method: "POST",
        body: {
          workspace_id: dmWorkspaceId,
          member_id: memberId,
          member_type: memberType,
        },
        token: authToken ?? undefined,
      });
      if (!r.ok) throw new Error("dm create failed");
      const d = await r.json();
      const dm = d?.data as DM | undefined;
      if (!dm) throw new Error("empty dm response");
      setDMs?.((prev) =>
        prev.some((x) => x.channel_id === dm.channel_id)
          ? prev.map((x) => (x.channel_id === dm.channel_id ? dm : x))
          : [...prev, dm],
      );
      setSelectedId(dm.channel_id);
      resetSearch();
      if (isMobile) setSidebarOpen(false);
    } catch {
      toast.error("发起私信失败");
      // Still refresh so any partial state reconciles.
      if (setDMs) refreshDMs(setDMs, authToken ?? undefined);
    }
  };

  const hasHits =
    !!searchResults &&
    (searchResults.channels.length > 0 ||
      searchResults.users.length > 0 ||
      searchResults.bots.length > 0);

  return (
    <aside
      className={`an-rail flex flex-col flex-shrink-0 ${isMobile ? "fixed inset-y-0 left-0 z-[60] shadow-2xl transition-transform duration-300 ease-in-out" : "relative"}`}
      style={{
        width: isMobile ? "280px" : leftWidth,
        transform:
          isMobile && !sidebarOpen ? "translateX(-100%)" : "translateX(0)",
        minHeight: 0,
      }}
    >
      {/* Rail head: workspace picker (matches design's .rail-head) */}
      <div className="an-rail-head">
        <div className="relative flex-1 min-w-0" ref={wsMenuRef}>
          <button
            type="button"
            className="an-ws"
            aria-label="切换工作空间"
            aria-haspopup="menu"
            aria-expanded={wsMenuOpen}
            onClick={() => setWsMenuOpen((o) => !o)}
          >
            <span
              className="an-ws-letter"
              style={{ background: currentWsAccent }}
            >
              {currentWsLetter}
            </span>
            <span className="truncate flex-1 text-left">{currentWsLabel}</span>
            <span style={{ color: "var(--fg-3)", fontSize: 10 }}>▾</span>
          </button>
          {wsMenuOpen && (
            <div
              className="an-menu absolute"
              style={{ left: 0, right: 0, top: "calc(100% + 4px)", minWidth: 220 }}
              role="menu"
            >
              <button
                type="button"
                className={`an-menu-item ${!selectedWorkspaceId ? "on" : ""}`}
                onClick={() => {
                  setSelectedWorkspaceId("");
                  setWsMenuOpen(false);
                }}
              >
                <span className="an-mi-ico">∗</span>
                <span>全部工作空间</span>
                {!selectedWorkspaceId && <span className="an-mi-ck">✓</span>}
              </button>
              {workspaces.length > 0 && <div className="an-menu-sep" />}
              {workspaces.map((w) => {
                const isOn = w.workspace_id === selectedWorkspaceId;
                return (
                  <button
                    key={w.workspace_id}
                    type="button"
                    className={`an-menu-item ${isOn ? "on" : ""}`}
                    onClick={() => {
                      setSelectedWorkspaceId(w.workspace_id);
                      setWsMenuOpen(false);
                    }}
                  >
                    <span
                      className="an-mi-ico"
                      style={{
                        background: wsColor(w.workspace_id),
                        color: "#fff",
                        width: 18,
                        height: 18,
                        borderRadius: 4,
                        fontWeight: 700,
                        fontSize: 10,
                      }}
                    >
                      {w.name.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="truncate">{w.name}</span>
                    {isOn && <span className="an-mi-ck">✓</span>}
                  </button>
                );
              })}
              <div className="an-menu-sep" />
              <button
                type="button"
                className="an-menu-item"
                onClick={() => {
                  setWsMenuOpen(false);
                  onOpenCreateWorkspace();
                }}
              >
                <span className="an-mi-ico">＋</span>
                <span>创建工作空间</span>
              </button>
              {selectedWorkspaceId && (
                <>
                  <button
                    type="button"
                    className="an-menu-item"
                    onClick={() => {
                      setWsMenuOpen(false);
                      onOpenInviteWsMember();
                    }}
                  >
                    <span className="an-mi-ico">👤</span>
                    <span>邀请成员</span>
                  </button>
                  <button
                    type="button"
                    className="an-menu-item"
                    style={{ color: "var(--red)" }}
                    onClick={() => {
                      setWsMenuOpen(false);
                      if (
                        !confirm("确定删除该工作空间？删除后其下的频道也将被删除。")
                      )
                        return;
                      apiFetch(`/workspaces/${selectedWorkspaceId}`, {
                        method: "DELETE",
                        token: authToken,
                      })
                        .then((r) => r.json())
                        .then((d) => {
                          if (d.status === "success") {
                            toast.success("工作空间已删除");
                            setSelectedWorkspaceId("");
                            refreshWorkspaces(setWorkspaces, authToken);
                            refreshChannels(setChannels, authToken);
                          } else {
                            toast.error(d.detail || "删除失败");
                          }
                        })
                        .catch(() => toast.error("请求失败"));
                    }}
                  >
                    <span className="an-mi-ico" style={{ color: "var(--red)" }}>
                      ✕
                    </span>
                    <span>删除当前工作空间</span>
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ⌘K global search */}
      <div className="an-search" ref={searchWrapRef}>
        <span className="an-search-ico">⌕</span>
        <input
          ref={searchInputRef}
          value={searchQ}
          onChange={(e) => {
            setSearchQ(e.target.value);
            setSearchOpen(true);
          }}
          onFocus={() => setSearchOpen(true)}
          placeholder="搜索频道 / 成员 / Bot"
          aria-label="全局搜索"
        />
        <kbd className="an-search-kbd">⌘K</kbd>
        {searchOpen && searchQ.trim() && (
          <div className="an-search-pop" role="listbox">
            {!searchResults && searchBusy && (
              <div className="an-search-empty">搜索中…</div>
            )}
            {searchResults && !hasHits && !searchBusy && (
              <div className="an-search-empty">没有匹配项</div>
            )}
            {searchResults && searchResults.channels.length > 0 && (
              <>
                <div className="an-search-group">频道</div>
                {searchResults.channels.map((c) => (
                  <button
                    key={c.channel_id}
                    type="button"
                    className="an-search-hit"
                    onClick={() => openChannelHit(c.channel_id)}
                  >
                    <span className="an-search-sigil">#</span>
                    <span className="an-search-name">{c.name}</span>
                  </button>
                ))}
              </>
            )}
            {searchResults && searchResults.users.length > 0 && (
              <>
                <div className="an-search-group">成员</div>
                {searchResults.users.map((u) => (
                  <button
                    key={u.user_id}
                    type="button"
                    className="an-search-hit"
                    onClick={() => openDmWith(u.user_id, "user")}
                  >
                    <span className="an-search-sigil">@</span>
                    <span className="an-search-name">
                      {u.display_name || u.username}
                    </span>
                    {u.display_name && u.display_name !== u.username && (
                      <span className="an-search-sub">@{u.username}</span>
                    )}
                  </button>
                ))}
              </>
            )}
            {searchResults && searchResults.bots.length > 0 && (
              <>
                <div className="an-search-group">Bot</div>
                {searchResults.bots.map((b) => (
                  <button
                    key={b.bot_id}
                    type="button"
                    className="an-search-hit"
                    onClick={() => openDmWith(b.bot_id, "bot")}
                  >
                    <span className="an-search-sigil">⦿</span>
                    <span className="an-search-name">
                      {b.display_name || b.username}
                    </span>
                    {b.display_name && b.display_name !== b.username && (
                      <span className="an-search-sub">@{b.username}</span>
                    )}
                  </button>
                ))}
              </>
            )}
          </div>
        )}
      </div>

      {/* Channels + Direct sections share a single scroller */}
      <div className="overflow-auto flex-1">
      <div className="an-rail-section-h">
        <span>频道</span>
        <button
          type="button"
          onClick={() => {
            if (!selectedWorkspaceId) {
              toast.error("请先选择工作空间");
              return;
            }
            onOpenCreateChannel();
          }}
          className="an-add"
          title="创建频道"
        >
          +
        </button>
      </div>
      <ul className="px-2 py-1">
        {channels
          .filter((c) => !selectedWorkspaceId || c.workspace_id === selectedWorkspaceId)
          .map((c) => {
            const isActive = selectedId === c.channel_id;
            const ws = !selectedWorkspaceId && c.workspace_id
              ? workspaces.find((w) => w.workspace_id === c.workspace_id)
              : null;
            const abbrev = ws ? ws.name.slice(0, 4) : "";
            return (
              <li
                key={c.channel_id}
                className="group relative"
                onClick={() => isMobile && setSidebarOpen(false)}
              >
                <button
                  type="button"
                  onClick={() => setSelectedId(c.channel_id)}
                  className={`an-rail-row w-full ${isActive ? "active" : ""} pr-7`}
                >
                  <span className="an-sigil">#</span>
                  <span className="an-name">{c.name}</span>
                  {abbrev && <span className="an-ws-abbrev">{abbrev}</span>}
                  {!isActive && (c.unread_count ?? 0) > 0 && (
                    <span className="an-unread">
                      {(c.unread_count ?? 0) > 99 ? "99+" : c.unread_count}
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  title="删除频道"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!confirm(`确定删除频道「${c.name}」？此操作不可恢复。`)) return;
                    apiFetch(`/channels/${c.channel_id}`, { method: "DELETE", token: authToken })
                      .then((r) => {
                        if (!r.ok) throw new Error("删除失败");
                        setChannels((prev) => prev.filter((x) => x.channel_id !== c.channel_id));
                        if (selectedId === c.channel_id) setSelectedId(null);
                      })
                      .catch(() => toast.error("删除频道失败"));
                  }}
                  className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity w-6 h-6 flex items-center justify-center rounded hover:bg-[var(--surface-hover)]"
                  style={{ color: "var(--fg-3)" }}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
                    <path fillRule="evenodd" d="M5 3.25V4H2.75a.75.75 0 0 0 0 1.5h.3l.815 8.15A1.5 1.5 0 0 0 5.357 15h5.285a1.5 1.5 0 0 0 1.493-1.35l.815-8.15h.3a.75.75 0 0 0 0-1.5H11v-.75A2.25 2.25 0 0 0 8.75 1h-1.5A2.25 2.25 0 0 0 5 3.25Zm2.25-.75a.75.75 0 0 0-.75.75V4h3v-.75a.75.75 0 0 0-.75-.75h-1.5ZM6.05 6a.75.75 0 0 1 .787.713l.275 5.5a.75.75 0 0 1-1.498.075l-.275-5.5A.75.75 0 0 1 6.05 6Zm3.9 0a.75.75 0 0 1 .712.787l-.275 5.5a.75.75 0 0 1-1.498-.075l.275-5.5a.75.75 0 0 1 .786-.711Z" clipRule="evenodd" />
                  </svg>
                </button>
              </li>
            );
          })}
      </ul>

      {/* Direct section — 1:1 DMs with users + bots. Header is always
          shown so users have an affordance to start a new DM even when
          the list is empty. */}
      <div className="an-rail-section-h">
        <span>私信</span>
        <button
          type="button"
          className="an-add"
          title="搜索用户/Bot 开始私信"
          onClick={() => {
            setSearchOpen(true);
            setSearchQ("");
            setTimeout(() => {
              searchInputRef.current?.focus();
              searchInputRef.current?.select();
            }, 0);
          }}
        >
          +
        </button>
      </div>
      {dms.length === 0 && (
        <div
          style={{
            fontSize: 11,
            color: "var(--fg-3)",
            padding: "0 12px 6px",
          }}
        >
          还没有 DM · 点 ＋ 开始一个
        </div>
      )}
      {dms.length > 0 && (
        <>
          <ul className="px-2 py-1 pb-2">
            {dms
              .filter(
                (d) =>
                  !selectedWorkspaceId || d.workspace_id === selectedWorkspaceId,
              )
              .map((d) => {
                const isActive = selectedId === d.channel_id;
                const cp = d.counterparty;
                const label =
                  cp.display_name ||
                  cp.username ||
                  (cp.member_type === "bot" ? "Bot" : "用户");
                const isBot = cp.member_type === "bot";
                return (
                  <li
                    key={d.channel_id}
                    className="group relative"
                    onClick={() => isMobile && setSidebarOpen(false)}
                  >
                    <button
                      type="button"
                      onClick={() => setSelectedId(d.channel_id)}
                      className={`an-rail-row w-full ${isActive ? "active" : ""}`}
                      title={
                        cp.username
                          ? `${label} · @${cp.username}`
                          : label
                      }
                    >
                      <span className="an-sigil">
                        {isBot ? "⦿" : "@"}
                      </span>
                      <span className="an-name">{label}</span>
                      {!isActive && (d.unread_count ?? 0) > 0 && (
                        <span className="an-unread">
                          {(d.unread_count ?? 0) > 99
                            ? "99+"
                            : d.unread_count}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
          </ul>
        </>
      )}

      </div>

      {/* .me footer — avatar + name + status + cog (matches design's .me) */}
      <div className="an-rail-foot">
        {currentUser ? (
          <>
            <div className="an-av" style={{ background: userColor }}>
              {userInitial}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="an-n truncate">{currentUser.display_name}</div>
              <div className="an-s">online</div>
            </div>
            <button
              type="button"
              className="an-cog ml-auto"
              onClick={onOpenSettings}
              title="设置"
              aria-label="设置"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                <path fillRule="evenodd" d="M7.84 1.804A1 1 0 0 1 8.82 1h2.36a1 1 0 0 1 .98.804l.331 1.652a6.993 6.993 0 0 1 1.929 1.115l1.598-.54a1 1 0 0 1 1.186.447l1.18 2.044a1 1 0 0 1-.205 1.251l-1.267 1.113a7.047 7.047 0 0 1 0 2.228l1.267 1.113a1 1 0 0 1 .206 1.25l-1.18 2.045a1 1 0 0 1-1.187.447l-1.598-.54a6.993 6.993 0 0 1-1.929 1.115l-.33 1.652a1 1 0 0 1-.98.804H8.82a1 1 0 0 1-.98-.804l-.331-1.652a6.993 6.993 0 0 1-1.929-1.115l-1.598.54a1 1 0 0 1-1.186-.447l-1.18-2.044a1 1 0 0 1 .205-1.251l1.267-1.114a7.05 7.05 0 0 1 0-2.227L1.821 7.773a1 1 0 0 1-.206-1.25l1.18-2.045a1 1 0 0 1 1.187-.447l1.598.54A6.992 6.992 0 0 1 7.51 3.456l.33-1.652ZM10 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" clipRule="evenodd" />
              </svg>
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={onLoginClick}
            className="w-full text-left px-2 py-1.5 rounded hover:bg-[var(--surface-soft)] transition-colors text-[13px]"
            style={{ color: "var(--fg-2)" }}
          >
            登录
          </button>
        )}
      </div>

      {/* Resize handle (desktop only) */}
      {!isMobile && (
        <div
          onMouseDown={onLeftResize}
          className="absolute top-0 right-0 h-full w-1 cursor-col-resize hover:bg-[var(--accent-ring)] transition-colors z-10"
        />
      )}
    </aside>
  );
}
