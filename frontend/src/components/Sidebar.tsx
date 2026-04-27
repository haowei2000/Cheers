import { useEffect, useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";
import {
  Cog6ToothIcon,
  MinusIcon,
  TrashIcon,
} from "@heroicons/react/24/solid";
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
  messages?: {
    msg_id: string;
    channel_id: string;
    channel_name: string;
    sender_label: string;
    snippet: string;
    created_at: string | null;
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
  /** True iff the active workspace is the Personal workspace — hides the
   *  channels section, pins the DMs section on top. */
  isPersonalWorkspace?: boolean;

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
  isPersonalWorkspace = false,
  channels,
  setChannels,
  dms = [],
  setDMs,
  selectedId,
  setSelectedId,
  setSidebarOpen,
  onOpenCreateWorkspace: _onOpenCreateWorkspace,
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
      const params = new URLSearchParams({ q, limit: "5" });
      // When a workspace is active, restrict channel + message hits to it.
      // Users and bots stay global since DMs cross workspaces.
      if (selectedWorkspaceId) params.set("workspace_id", selectedWorkspaceId);
      apiFetch(`search?${params.toString()}`, {
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
  }, [searchQ, authToken, selectedWorkspaceId]);

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
      searchResults.bots.length > 0 ||
      (searchResults.messages?.length ?? 0) > 0);

  const openMessageHit = (channelId: string, msgId: string) => {
    setSelectedId(channelId);
    resetSearch();
    if (isMobile) setSidebarOpen(false);
    // Give the chat column time to mount / fetch before we scroll.
    setTimeout(() => {
      const el = document.getElementById(`msg-${msgId}`);
      if (!el) return;
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      const orig = el.style.transition;
      const prev = el.style.background;
      el.style.transition = "background 200ms";
      el.style.background = "var(--accent-muted)";
      setTimeout(() => {
        el.style.background = prev;
        el.style.transition = orig;
      }, 1200);
    }, 400);
  };

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
      {/* Rail head: workspace picker has moved to the vertical WorkspaceRail
          on the left. This header now just names the active workspace with a
          minimal overflow ⋯ for invite / delete on team workspaces. */}
      <div className="an-rail-head">
        <div
          className="flex items-center gap-2 flex-1 min-w-0 relative"
          ref={wsMenuRef}
        >
          <span
            className="an-ws-letter"
            style={{ background: currentWsAccent }}
          >
            {currentWsLetter}
          </span>
          <span
            className="truncate flex-1"
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: "var(--fg-1)",
            }}
          >
            {currentWsLabel}
          </span>
          {selectedWorkspaceId && !isPersonalWorkspace && (
            <button
              type="button"
              onClick={() => setWsMenuOpen((o) => !o)}
              title="工作空间操作"
              aria-label="工作空间操作"
              aria-haspopup="menu"
              aria-expanded={wsMenuOpen}
              className="w-7 h-7 flex items-center justify-center rounded-md transition-colors hover:bg-[var(--surface-soft)]"
              style={{ color: "var(--fg-3)" }}
            >
              ⋯
            </button>
          )}
          {wsMenuOpen && (
            <div
              className="an-menu absolute"
              style={{ right: 0, top: "calc(100% + 4px)", minWidth: 180 }}
              role="menu"
            >
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
              <div className="an-menu-sep" />
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
                <span>删除工作空间</span>
              </button>
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
            {searchResults && (searchResults.messages?.length ?? 0) > 0 && (
              <>
                <div className="an-search-group">消息</div>
                {searchResults.messages!.map((m) => (
                  <button
                    key={m.msg_id}
                    type="button"
                    className="an-search-hit"
                    onClick={() =>
                      openMessageHit(m.channel_id, m.msg_id)
                    }
                    style={{ alignItems: "flex-start" }}
                  >
                    <span
                      className="an-search-sigil"
                      style={{
                        alignSelf: "flex-start",
                        marginTop: 2,
                        lineHeight: 1,
                      }}
                    >
                      #
                    </span>
                    <span
                      className="an-search-name"
                      style={{
                        whiteSpace: "normal",
                        display: "flex",
                        flexDirection: "column",
                        gap: 2,
                        lineHeight: 1.35,
                      }}
                    >
                      <span style={{ fontSize: 12 }}>
                        <span
                          style={{ color: "var(--fg-2)", fontWeight: 500 }}
                        >
                          {m.channel_name || "频道"}
                        </span>
                        <span style={{ color: "var(--fg-3)" }}> · </span>
                        <span style={{ color: "var(--fg-3)", fontSize: 11 }}>
                          {m.sender_label}
                        </span>
                      </span>
                      <span
                        style={{
                          color: "var(--fg-2)",
                          fontSize: 11.5,
                        }}
                      >
                        {m.snippet}
                      </span>
                    </span>
                  </button>
                ))}
              </>
            )}
          </div>
        )}
      </div>

      {/* Channels + Direct sections share a single scroller */}
      <div className="overflow-auto flex-1">
      {!isPersonalWorkspace && (
        <>
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
                  {(abbrev ||
                    (!isActive && (c.unread_count ?? 0) > 0)) && (
                    <span className="an-rail-tags">
                      {abbrev && (
                        <span className="an-ws-abbrev">{abbrev}</span>
                      )}
                      {!isActive && (c.unread_count ?? 0) > 0 && (
                        <span className="an-unread">
                          {(c.unread_count ?? 0) > 99
                            ? "99+"
                            : c.unread_count}
                        </span>
                      )}
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
                  <TrashIcon className="w-3 h-3" />
                </button>
              </li>
            );
          })}
      </ul>
        </>
      )}

      {/* Direct section — only in the Personal workspace. 1:1 DMs with
          users + bots. Header always shown so users have an affordance to
          start a new DM even when the list is empty. */}
      {isPersonalWorkspace && (
        <>
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
                      className={`an-rail-row w-full ${isActive ? "active" : ""} pr-7`}
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
                        <span className="an-rail-tags">
                          <span className="an-unread">
                            {(d.unread_count ?? 0) > 99
                              ? "99+"
                              : d.unread_count}
                          </span>
                        </span>
                      )}
                    </button>
                    <button
                      type="button"
                      title="退出此私信"
                      aria-label="退出此私信"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!currentUser) return;
                        if (
                          !confirm(
                            `从列表中移除与「${label}」的私信？对方再次消息时会重新出现。`,
                          )
                        )
                          return;
                        apiFetch(
                          `/channels/${d.channel_id}/members/${currentUser.user_id}`,
                          { method: "DELETE", token: authToken },
                        )
                          .then((r) => {
                            if (!r.ok) throw new Error("leave failed");
                            setDMs?.((prev) =>
                              prev.filter(
                                (x) => x.channel_id !== d.channel_id,
                              ),
                            );
                            if (selectedId === d.channel_id) {
                              setSelectedId(null);
                            }
                          })
                          .catch(() => toast.error("退出私信失败"));
                      }}
                      className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity w-6 h-6 flex items-center justify-center rounded hover:bg-[var(--surface-hover)]"
                      style={{ color: "var(--fg-3)" }}
                    >
                      <MinusIcon className="w-3 h-3" />
                    </button>
                  </li>
                );
              })}
          </ul>
        </>
      )}
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
              <Cog6ToothIcon className="w-4 h-4" />
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
