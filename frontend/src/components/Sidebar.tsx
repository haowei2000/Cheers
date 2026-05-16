import { useEffect, useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";
import type { Channel, DM, Workspace, CurrentUser, FileInfo } from "../types";
import { apiFetch } from "../api";
import { makeBuiltinAvatarValue } from "../lib/avatar";
import { refreshChannels, refreshDMs, refreshWorkspaces } from "../lib/refresh";
import { AvatarVisual } from "./AvatarVisual";
import { AppIcon } from "./icons/AppIcon";
import {
  SearchPicker,
  type SearchPickerHandle,
  type SearchScopeOption,
  type SearchTypeFilterOption,
} from "./SearchPicker";
import { MemberAvatar, type MemberKind } from "./members";
import type { SearchSelection } from "../types";
import { WorkspaceSettingsModal } from "./WorkspaceSettingsModal";
import { Modal } from "./Modal";
import { Tooltip } from "./Tooltip";

interface SidebarProps {
  isMobile: boolean;
  sidebarOpen: boolean;
  leftWidth: number;
  onLeftResize: (e: React.MouseEvent) => void;

  currentUser: CurrentUser;
  authToken: string | null;
  onLoginClick: () => void;

  workspaces: Workspace[];
  setWorkspaces: React.Dispatch<React.SetStateAction<Workspace[]>>;
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
  onOpenFilePreview?: (file: FileInfo) => void;
  onOpenPersonalFileMain?: (file: FileInfo) => void;
  onPreloadChannel?: (channelId: string) => void;
}

const WS_LETTER_COLORS = ["#7c6cf5", "#3ecf8e", "#f5a623", "#56a7ff", "#f05454", "#9586ff"];
type PersonalAddDialogState = {
  kind: "dm" | "project" | "projectChat";
  projectId: string;
  projectTitle: string;
} | null;
type PersonalFileItem = FileInfo & {
  channel_id: string;
  channel_label: string;
  created_at?: string | null;
  summary_3lines?: string | null;
};

const wsColor = (id: string) => {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return WS_LETTER_COLORS[h % WS_LETTER_COLORS.length];
};
const ALL_WORKSPACES_AVATAR = makeBuiltinAvatarValue("main", "dashboard");

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
  onOpenCreateWorkspace,
  onOpenInviteWsMember,
  onOpenCreateChannel,
  onOpenSettings,
  onOpenFilePreview,
  onOpenPersonalFileMain,
  onPreloadChannel,
}: SidebarProps) {
  const currentWs = workspaces.find((w) => w.workspace_id === selectedWorkspaceId);
  const currentWsLabel = currentWs ? currentWs.name : "全部工作空间";
  const currentWsLetter = currentWs ? currentWs.name.slice(0, 1).toUpperCase() : "全";
  const currentWsAccent = currentWs ? wsColor(currentWs.workspace_id) : "var(--accent)";
  const currentWsAvatarUrl = currentWs?.avatar_url || (!currentWs ? ALL_WORKSPACES_AVATAR : "");
  const [searchWorkspaceId, setSearchWorkspaceId] = useState(selectedWorkspaceId);
  useEffect(() => {
    setSearchWorkspaceId(selectedWorkspaceId);
  }, [selectedWorkspaceId]);
  const searchWorkspace = searchWorkspaceId
    ? workspaces.find((w) => w.workspace_id === searchWorkspaceId)
    : null;
  const searchScopeName = searchWorkspaceId
    ? searchWorkspace?.name || "当前工作空间"
    : "全部工作空间";
  const searchScopeLabel = searchWorkspaceId ? searchScopeName : "全部空间";
  const searchScopeTitle = searchWorkspaceId
    ? `频道与消息范围：${searchScopeName}；成员和 Bot 全局搜索`
    : "频道、消息、成员和 Bot 全局搜索";
  const searchScopeOptions = useMemo<SearchScopeOption[]>(
    () => [
      {
        value: "",
        label: "全部空间",
        title: "频道、消息、成员和 Bot 全局搜索",
        marker: "∗",
      },
      ...workspaces.map((w) => {
        const trimmed = w.name.trim();
        const marker = w.kind === "personal"
          ? "个"
          : [...trimmed].slice(0, 2).join("").toUpperCase() || "?";
        return {
          value: w.workspace_id,
          label: w.name,
          title: w.kind === "personal" ? "Personal · 私信" : "Workspace · 频道",
          marker,
        };
      }),
    ],
    [workspaces],
  );
  const searchTypeOptions = useMemo<SearchTypeFilterOption[]>(
    () => [
      { type: "workspaces", label: "空间" },
      { type: "channels", label: "频道" },
      { type: "users", label: "成员" },
      { type: "bots", label: "Bot" },
      { type: "files", label: "文件" },
      { type: "messages", label: "消息" },
      { type: "todos", label: "待办" },
      { type: "tasks", label: "任务" },
    ],
    [],
  );

  const [wsMenuOpen, setWsMenuOpen] = useState(false);
  const [workspaceSettingsOpen, setWorkspaceSettingsOpen] = useState(false);
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

  const userInitial =
    (currentUser?.display_name || currentUser?.username || "?").slice(0, 1).toUpperCase();
  const userColor = currentUser
    ? wsColor(currentUser.user_id || currentUser.display_name || "u")
    : "var(--accent)";

  const searchPickerRef = useRef<SearchPickerHandle | null>(null);
  const [personalAddDialog, setPersonalAddDialog] =
    useState<PersonalAddDialogState>(null);
  const [projectDraftTitle, setProjectDraftTitle] = useState("");
  const [personalFiles, setPersonalFiles] = useState<PersonalFileItem[]>([]);
  const [personalFilesLoading, setPersonalFilesLoading] = useState(false);

  const dmWorkspaceId = useMemo(
    () => selectedWorkspaceId || workspaces[0]?.workspace_id || "",
    [selectedWorkspaceId, workspaces],
  );

  const resetSearch = () => {
    searchPickerRef.current?.clear();
  };

  const visiblePersonalDms = useMemo(
    () =>
      dms.filter(
        (dm) => !selectedWorkspaceId || dm.workspace_id === selectedWorkspaceId,
      ),
    [dms, selectedWorkspaceId],
  );

  const directDms = useMemo(
    () =>
      visiblePersonalDms.filter(
        (dm) => dm.counterparty.member_type !== "bot",
      ),
    [visiblePersonalDms],
  );

  const projectGroups = useMemo(() => {
    const sorted = visiblePersonalDms
      .filter((dm) => dm.counterparty.member_type === "bot")
      .sort((a, b) => {
        const aProject = a.project_title || "Project 1";
        const bProject = b.project_title || "Project 1";
        const projectOrder = aProject.localeCompare(bProject, "zh-Hans-CN");
        if (projectOrder !== 0) return projectOrder;
        const at = a.created_at ? Date.parse(a.created_at) : 0;
        const bt = b.created_at ? Date.parse(b.created_at) : 0;
        return at - bt;
      });
    const groups = new Map<
      string,
      {
        projectId: string;
        projectTitle: string;
        chats: { dm: DM; botLabel: string; chatLabel: string }[];
      }
    >();
    const counts = new Map<string, number>();
    for (const dm of sorted) {
      const cp = dm.counterparty;
      const botLabel = cp.display_name || cp.username || "Bot";
      const projectId = dm.project_id || "personal-project-default";
      const projectTitle = dm.project_title || "Project 1";
      const next = (counts.get(projectId) || 0) + 1;
      counts.set(projectId, next);
      const chatLabel = dm.chat_title?.trim() || dm.title?.trim() || `Chat ${next}`;
      const group =
        groups.get(projectId) ||
        { projectId, projectTitle, chats: [] };
      group.chats.push({ dm, botLabel, chatLabel });
      groups.set(projectId, group);
    }
    return [...groups.values()];
  }, [visiblePersonalDms]);

  const nextProjectTitle = () => `Project ${projectGroups.length + 1}`;

  const nextProjectChatTitle = (projectId: string) => {
    const count =
      projectGroups.find((group) => group.projectId === projectId)?.chats.length ?? 0;
    return `Chat ${count + 1}`;
  };

  const personalFileChannelKey = useMemo(
    () =>
      visiblePersonalDms
        .map((dm) => dm.channel_id)
        .sort()
        .join("|"),
    [visiblePersonalDms],
  );

  useEffect(() => {
    if (!isPersonalWorkspace || visiblePersonalDms.length === 0) {
      setPersonalFiles([]);
      setPersonalFilesLoading(false);
      return;
    }
    let active = true;
    setPersonalFilesLoading(true);
    Promise.all(
      visiblePersonalDms.map(async (dm) => {
        const cp = dm.counterparty;
        const channelLabel =
          dm.title ||
          cp.display_name ||
          cp.username ||
          (cp.member_type === "bot" ? "Bot Chat" : "私信");
        try {
          const response = await apiFetch(`/files/by-channel/${dm.channel_id}`, {
            token: authToken,
          });
          if (!response.ok) return [];
          const payload = await response.json();
          const files = Array.isArray(payload?.data) ? payload.data : [];
          return files.map((file: FileInfo & { created_at?: string | null; summary_3lines?: string | null }) => ({
            ...file,
            channel_id: dm.channel_id,
            channel_label: channelLabel,
          }));
        } catch {
          return [];
        }
      }),
    )
      .then((groups) => {
        if (!active) return;
        setPersonalFiles(
          groups
            .flat()
            .sort((a, b) => {
              const at = a.created_at ? Date.parse(a.created_at) : 0;
              const bt = b.created_at ? Date.parse(b.created_at) : 0;
              return bt - at;
            }),
        );
      })
      .finally(() => {
        if (active) setPersonalFilesLoading(false);
      });
    return () => {
      active = false;
    };
  }, [authToken, isPersonalWorkspace, personalFileChannelKey, visiblePersonalDms]);

  const selectWorkspace = (workspaceId: string) => {
    setSelectedWorkspaceId(workspaceId);
    setSearchWorkspaceId(workspaceId);
    resetSearch();
  };

  const workspaceInitials = (workspace: Workspace) => {
    if (workspace.kind === "personal") return "个";
    const trimmed = workspace.name.trim();
    return [...trimmed].slice(0, 4).join("").toUpperCase() || "?";
  };

  const openChannelHit = (channelId: string) => {
    const channel = channels.find((c) => c.channel_id === channelId);
    if (channel?.workspace_id) {
      setSelectedWorkspaceId(channel.workspace_id);
    }
    setSelectedId(channelId);
    resetSearch();
    if (isMobile) setSidebarOpen(false);
  };

  const openDmWith = async (
    memberId: string,
    memberType: "user" | "bot",
    options: {
      createNew?: boolean;
      title?: string;
      projectId?: string;
      projectTitle?: string;
      chatTitle?: string;
    } = {},
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
          create_new: options.createNew ?? false,
          title: options.title,
          project_id: options.projectId,
          project_title: options.projectTitle,
          chat_title: options.chatTitle,
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
      toast.error(options.createNew ? "发起 Chat 失败" : "发起私信失败");
      // Still refresh so any partial state reconciles.
      if (setDMs) refreshDMs(setDMs, authToken ?? undefined);
    }
  };

  const openPersonalAddDialog = (
    kind: "dm" | "project" | "projectChat",
    project?: {
    projectId: string;
    projectTitle: string;
    },
  ) => {
    const projectId =
      project?.projectId ||
      (typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `project-${Date.now()}`);
    const projectTitle = project?.projectTitle || nextProjectTitle();
    setProjectDraftTitle(projectTitle);
    setPersonalAddDialog({
      kind,
      projectId,
      projectTitle,
    });
  };

  const openMessageHit = (channelId: string, msgId: string) => {
    const channel = channels.find((c) => c.channel_id === channelId);
    const dm = dms.find((d) => d.channel_id === channelId);
    if (channel?.workspace_id) {
      setSelectedWorkspaceId(channel.workspace_id);
    } else if (dm?.workspace_id) {
      setSelectedWorkspaceId(dm.workspace_id);
    }
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

  const handlePersonalAddSelect = (selection: SearchSelection) => {
    if (!personalAddDialog) return;
    if (personalAddDialog.kind === "dm") {
      if (selection.type !== "user") {
        toast.error("请选择成员开始私信");
        return;
      }
      setPersonalAddDialog(null);
      openDmWith(selection.item.user_id, "user");
      return;
    }
    if (personalAddDialog.kind === "project" || personalAddDialog.kind === "projectChat") {
      if (selection.type !== "bot") {
        toast.error("请选择 Bot 添加到 Project");
        return;
      }
      const projectTitle =
        personalAddDialog.kind === "project"
          ? projectDraftTitle.trim() || personalAddDialog.projectTitle
          : personalAddDialog.projectTitle;
      const chatTitle = nextProjectChatTitle(personalAddDialog.projectId);
      setPersonalAddDialog(null);
      openDmWith(selection.item.bot_id, "bot", {
        createNew: true,
        projectId: personalAddDialog.projectId,
        projectTitle,
        chatTitle,
        title: chatTitle,
      });
      return;
    }
  };

  const handleSearchSelect = (selection: SearchSelection) => {
    if (selection.type === "workspace") {
      setSelectedWorkspaceId(selection.item.workspace_id);
      setSearchWorkspaceId(selection.item.workspace_id);
      resetSearch();
      if (isMobile) setSidebarOpen(false);
      return;
    }
    if (selection.type === "channel") {
      openChannelHit(selection.item.channel_id);
      return;
    }
    if (selection.type === "user") {
      openDmWith(selection.item.user_id, "user");
      return;
    }
    if (selection.type === "bot") {
      openDmWith(selection.item.bot_id, "bot");
      return;
    }
    if (selection.type === "file") {
      onOpenFilePreview?.({
        file_id: selection.item.file_id,
        original_filename: selection.item.original_filename || undefined,
        content_type: selection.item.content_type || undefined,
        size_bytes: selection.item.size_bytes || undefined,
        status: selection.item.status,
      });
      resetSearch();
      if (isMobile) setSidebarOpen(false);
      return;
    }
    if (selection.type === "message") {
      openMessageHit(selection.item.channel_id, selection.item.msg_id);
      return;
    }
    if (selection.type === "task") {
      const msgId = selection.item.response_msg_id || selection.item.trigger_msg_id;
      openMessageHit(selection.item.channel_id, msgId);
      return;
    }
    if (selection.type === "todo") {
      openChannelHit(selection.item.channel_id);
    }
  };

  return (
    <>
    <aside
      className={`an-rail flex flex-col flex-shrink-0 ${isMobile ? "fixed inset-y-0 left-0 z-[60] shadow-2xl transition-transform duration-300 ease-in-out" : "relative"}`}
      style={{
        width: isMobile ? "min(88vw, 320px)" : leftWidth,
        transform:
          isMobile && !sidebarOpen ? "translateX(-100%)" : "translateX(0)",
        minHeight: 0,
      }}
    >
      {isMobile && (
        <div className="an-mobile-ws-strip" aria-label="工作空间">
          {workspaces.map((workspace) => {
            const active = selectedWorkspaceId === workspace.workspace_id;
            return (
              <button
                key={workspace.workspace_id}
                type="button"
                className="an-mobile-ws-tile"
                aria-pressed={active}
                title={workspace.name}
                onClick={() => selectWorkspace(workspace.workspace_id)}
                style={{
                  background: workspace.avatar_url
                    ? "var(--surface-soft)"
                    : wsColor(workspace.workspace_id),
                }}
              >
                <AvatarVisual
                  avatarUrl={workspace.avatar_url}
                  background="transparent"
                  fallback={workspaceInitials(workspace)}
                  label={workspace.name}
                  radius={10}
                  size={38}
                />
              </button>
            );
          })}
          <button
            type="button"
            className="an-mobile-ws-tile an-mobile-ws-add"
            onClick={() => {
              setSidebarOpen(false);
              onOpenCreateWorkspace();
            }}
            title="创建工作空间"
            aria-label="创建工作空间"
          >
            +
          </button>
        </div>
      )}

      {/* Rail head: workspace picker has moved to the vertical WorkspaceRail
          on the left. This header now just names the active workspace with a
          minimal overflow ⋯ for invite / delete on team workspaces. */}
      <div className="an-rail-head">
        <div
          className="flex items-center gap-2 flex-1 min-w-0 relative"
          ref={wsMenuRef}
        >
          <AvatarVisual
            avatarUrl={currentWsAvatarUrl}
            background={currentWsAccent}
            className="an-ws-letter"
            fallback={currentWsLetter}
            label={currentWsLabel}
            radius={5}
            size={22}
            style={{ background: currentWsAvatarUrl ? "var(--surface-soft)" : currentWsAccent }}
          />
          <span
            className="an-type-label truncate flex-1"
            style={{ color: "var(--fg-1)" }}
          >
            {currentWsLabel}
          </span>
          {selectedWorkspaceId && (
            <Tooltip content="设置工作空间图标">
              <button
                type="button"
                onClick={() => setWorkspaceSettingsOpen(true)}
                title="设置工作空间图标"
                aria-label="设置工作空间图标"
                className="an-btn an-btn-ghost an-btn-icon"
              >
                <AppIcon name="palette" className="w-4 h-4" />
              </button>
            </Tooltip>
          )}
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
                  setWorkspaceSettingsOpen(true);
                }}
              >
                <span className="an-mi-ico inline-flex w-4 h-4">
                  <AppIcon name="settings" className="w-full h-full" />
                </span>
                <span>编辑工作空间</span>
              </button>
              <button
                type="button"
                className="an-menu-item"
                onClick={() => {
                  setWsMenuOpen(false);
                  onOpenInviteWsMember();
                }}
              >
                <span className="an-mi-ico inline-flex w-4 h-4">
                  <AppIcon name="userPlus" className="w-full h-full" />
                </span>
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
                <span
                  className="an-mi-ico inline-flex w-4 h-4"
                  style={{ color: "var(--red)" }}
                >
                  <AppIcon name="close" className="w-full h-full" />
                </span>
                <span>删除工作空间</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ⌘K global search */}
      <SearchPicker
        ref={searchPickerRef}
        context="global_nav"
        token={authToken}
        workspaceId={searchWorkspaceId || undefined}
        placeholder={
          "搜索消息 / 文件 / 频道 / 成员 / Bot"
        }
        keyboardHint="⌘K"
        enableShortcut
        typeOptions={searchTypeOptions}
        scopeLabel={searchScopeLabel}
        scopeTitle={searchScopeTitle}
        scopeValue={searchWorkspaceId}
        scopeOptions={searchScopeOptions}
        onScopeChange={setSearchWorkspaceId}
        onSelect={handleSearchSelect}
      />

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
                  onFocus={() => onPreloadChannel?.(c.channel_id)}
                  onPointerEnter={() => onPreloadChannel?.(c.channel_id)}
                  className={`an-rail-row w-full ${isActive ? "active" : ""} pr-7`}
                >
                  <span className="an-sigil">
                    <AppIcon name="channel" />
                  </span>
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
                      .then(async (r) => {
                        const payload = await r.json().catch(() => null);
                        if (!r.ok || payload?.status === "error") {
                          throw new Error(payload?.detail || payload?.message || "删除失败");
                        }
                        setChannels((prev) => prev.filter((x) => x.channel_id !== c.channel_id));
                        if (selectedId === c.channel_id) setSelectedId(null);
                        toast.success("频道已删除");
                      })
                      .catch((err) => toast.error(err?.message || "删除频道失败"));
                  }}
                  className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity w-6 h-6 flex items-center justify-center rounded hover:bg-[var(--surface-hover)]"
                  style={{ color: "var(--fg-3)" }}
                >
                  <AppIcon name="trash" className="w-3 h-3" />
                </button>
              </li>
            );
          })}
      </ul>
        </>
      )}

      {/* Personal workspace: user DMs, files gathered from personal chats, and
          bot conversations grouped under Projects. */}
      {isPersonalWorkspace && (
        <>
      <div className="an-rail-section-h">
        <span>私信</span>
        <button
          type="button"
          className="an-add"
          title="搜索用户开始私信"
          onClick={() => {
            openPersonalAddDialog("dm");
          }}
        >
          +
        </button>
      </div>
      {directDms.length === 0 && (
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
      {directDms.length > 0 && (
        <>
          <ul className="px-2 py-1 pb-2">
            {directDms.map((d) => {
                const isActive = selectedId === d.channel_id;
                const cp = d.counterparty;
                const label =
                  cp.display_name ||
                  cp.username ||
                  (cp.member_type === "system" ? "系统" : "用户");
                const isSystem = cp.member_type === "system";
                const memberKind: MemberKind = isSystem ? "system" : "user";
                return (
                  <li
                    key={d.channel_id}
                    className="group relative"
                    onClick={() => isMobile && setSidebarOpen(false)}
                  >
                    <button
                      type="button"
                      onClick={() => setSelectedId(d.channel_id)}
                      onFocus={() => onPreloadChannel?.(d.channel_id)}
                      onPointerEnter={() => onPreloadChannel?.(d.channel_id)}
                      className={`an-rail-row w-full ${isActive ? "active" : ""} pr-7`}
                      title={
                        cp.username
                          ? `${label} · @${cp.username}`
                          : label
                      }
                    >
                      <span className="an-sigil">
                        <MemberAvatar
                          avatarUrl={cp.avatar_url}
                          kind={memberKind}
                          label={label}
                          size={16}
                        />
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
                    {!isSystem && (
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
                      <AppIcon name="minus" className="w-3 h-3" />
                    </button>
                    )}
                  </li>
                );
              })}
          </ul>
        </>
      )}

      <div className="an-rail-section-h">
        <span>文件</span>
        <span className="an-rail-count">
          {personalFilesLoading ? "…" : personalFiles.length}
        </span>
      </div>
      <ul className="px-2 py-1 pb-2">
        {personalFiles.length === 0 && (
          <li className="an-rail-empty">
            {personalFilesLoading ? "文件加载中…" : "暂无文件"}
          </li>
        )}
        {personalFiles.map((file) => (
          <li key={`${file.channel_id}:${file.file_id}`} className="group relative">
            <button
              type="button"
              className="an-rail-row w-full"
              title={`${file.original_filename || file.file_id} · ${file.channel_label}`}
              onClick={() => {
                setSelectedId(null);
                if (onOpenPersonalFileMain) {
                  onOpenPersonalFileMain(file);
                } else {
                  onOpenFilePreview?.(file);
                }
                if (isMobile) setSidebarOpen(false);
              }}
            >
              <span className="an-sigil">
                <AppIcon name="file" />
              </span>
              <span className="an-name">
                {file.original_filename || file.file_id}
              </span>
            </button>
          </li>
        ))}
      </ul>

      <div className="an-rail-section-h">
        <span>Project</span>
        <button
          type="button"
          className="an-add"
          title="创建 Project 并选择 Bot"
          onClick={() => openPersonalAddDialog("project")}
        >
          +
        </button>
      </div>
      <ul className="px-2 py-1 pb-2">
        {projectGroups.length === 0 && (
          <li className="an-rail-empty">还没有 Project · 点 ＋ 选择 Bot 创建一个</li>
        )}
        {projectGroups.map((project) => (
          <li key={project.projectId} className="an-project-group">
            <div className="an-project-head">
              <div className="an-rail-row an-project-row" title={project.projectTitle}>
                <span className="an-sigil">
                  <AppIcon name="folder" />
                </span>
                <span className="an-name">{project.projectTitle}</span>
              </div>
              <button
                type="button"
                className="an-project-add"
                title={`给 ${project.projectTitle} 添加 Bot Chat`}
                aria-label={`给 ${project.projectTitle} 添加 Bot Chat`}
                onClick={() => openPersonalAddDialog("projectChat", project)}
              >
                <AppIcon name="plus" />
              </button>
            </div>
            <ul className="an-project-chats">
              {project.chats.map(({ dm, botLabel, chatLabel }) => {
                const isActive = selectedId === dm.channel_id;
                const cp = dm.counterparty;
                const label = `${botLabel} · ${chatLabel}`;
                return (
                  <li
                    key={dm.channel_id}
                    className="group relative"
                    onClick={() => isMobile && setSidebarOpen(false)}
                  >
                    <button
                      type="button"
                      onClick={() => setSelectedId(dm.channel_id)}
                      onFocus={() => onPreloadChannel?.(dm.channel_id)}
                      onPointerEnter={() => onPreloadChannel?.(dm.channel_id)}
                      className={`an-rail-row an-project-chat-row w-full ${
                        isActive ? "active" : ""
                      } pr-7`}
                      title={cp.username ? `${label} · @${cp.username}` : label}
                    >
                      <span className="an-sigil">
                        <MemberAvatar
                          avatarUrl={cp.avatar_url}
                          kind="bot"
                          label={botLabel}
                          size={16}
                        />
                      </span>
                      <span className="an-name">{label}</span>
                      {!isActive && (dm.unread_count ?? 0) > 0 && (
                        <span className="an-rail-tags">
                          <span className="an-unread">
                            {(dm.unread_count ?? 0) > 99
                              ? "99+"
                              : dm.unread_count}
                          </span>
                        </span>
                      )}
                    </button>
                    <button
                      type="button"
                      title="移除此 Chat"
                      aria-label="移除此 Chat"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!currentUser) return;
                        if (
                          !confirm(
                            `从列表中移除「${label}」？Bot 再次消息时会重新出现。`,
                          )
                        )
                          return;
                        apiFetch(
                          `/channels/${dm.channel_id}/members/${currentUser.user_id}`,
                          { method: "DELETE", token: authToken },
                        )
                          .then((r) => {
                            if (!r.ok) throw new Error("leave failed");
                            setDMs?.((prev) =>
                              prev.filter((x) => x.channel_id !== dm.channel_id),
                            );
                            if (selectedId === dm.channel_id) {
                              setSelectedId(null);
                            }
                          })
                          .catch(() => toast.error("移除 Chat 失败"));
                      }}
                      className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity w-6 h-6 flex items-center justify-center rounded hover:bg-[var(--surface-hover)]"
                      style={{ color: "var(--fg-3)" }}
                    >
                      <AppIcon name="minus" className="w-3 h-3" />
                    </button>
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ul>
        </>
      )}

      </div>

      {/* Account footer: avatar with presence, display name, and settings. */}
      <div className="an-rail-foot">
        {currentUser ? (
          <>
            <Tooltip content="当前在线" placement="top">
              <span
                className="an-account-avatar-wrap"
                tabIndex={0}
                aria-label="当前在线"
                title="当前在线"
              >
                <AvatarVisual
                  avatarUrl={currentUser.avatar_url}
                  background={userColor}
                  className="an-av"
                  fallback={userInitial}
                  label={currentUser.display_name || currentUser.username}
                  radius={6}
                  size={28}
                  style={{ background: currentUser.avatar_url ? "var(--surface-soft)" : userColor }}
                />
                <span className="an-presence-dot" aria-hidden="true" />
              </span>
            </Tooltip>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="an-n truncate">{currentUser.display_name}</div>
            </div>
            <button
              type="button"
              className="an-cog"
              onClick={onOpenSettings}
              title="Settings"
              aria-label="Settings"
            >
              <AppIcon name="settings" className="w-4 h-4" />
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={onLoginClick}
            className="w-full text-left px-2 py-1.5 rounded hover:bg-[var(--surface-soft)] transition-colors text-[13px]"
            style={{ color: "var(--fg-2)" }}
          >
            Sign in
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
    <WorkspaceSettingsModal
      open={workspaceSettingsOpen}
      workspace={currentWs ?? null}
      authToken={authToken}
      onClose={() => setWorkspaceSettingsOpen(false)}
      onSaved={(updated) =>
        setWorkspaces((prev) =>
          prev.map((w) => (w.workspace_id === updated.workspace_id ? updated : w)),
        )
      }
    />
    <Modal
      open={Boolean(personalAddDialog)}
      onClose={() => setPersonalAddDialog(null)}
      title={
        personalAddDialog?.kind === "dm"
          ? "开始私信"
          : personalAddDialog?.kind === "project"
            ? "创建 Project"
            : "添加 Bot Chat"
      }
      description={
        personalAddDialog?.kind === "dm"
          ? "搜索成员并创建私信。"
          : personalAddDialog?.kind === "project"
            ? "命名 Project，然后选择第一个 Bot Chat。"
            : `给 ${personalAddDialog?.projectTitle || "Project"} 添加一个 Bot Chat。`
      }
    >
      {personalAddDialog?.kind === "project" && (
        <label className="mb-3 block">
          <span className="mb-1 block text-xs font-medium" style={{ color: "var(--fg-2)" }}>
            Project 名称
          </span>
          <input
            value={projectDraftTitle}
            onChange={(event) => setProjectDraftTitle(event.target.value)}
            className="w-full rounded-lg border px-3 py-2 text-sm outline-none"
            style={{
              borderColor: "var(--border)",
              background: "var(--bg-0)",
              color: "var(--fg-1)",
            }}
            maxLength={80}
          />
        </label>
      )}
      <SearchPicker
        key={`${personalAddDialog?.kind || "none"}:${personalAddDialog?.projectId || ""}`}
        context="global_nav"
        token={authToken}
        workspaceId={searchWorkspaceId || undefined}
        types={personalAddDialog?.kind === "dm" ? ["users"] : ["bots"]}
        placeholder={personalAddDialog?.kind === "dm" ? "搜索成员" : "搜索 Bot"}
        modal
        autoFocus
        emptyText={personalAddDialog?.kind === "dm" ? "没有可添加的成员" : "没有可添加的 Bot"}
        actionLabel={personalAddDialog?.kind === "dm" ? "私信" : "添加"}
        onSelect={handlePersonalAddSelect}
      />
    </Modal>
    </>
  );
}
