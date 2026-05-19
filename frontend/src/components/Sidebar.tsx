import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import toast from "react-hot-toast";
import type { BotItem, Channel, DM, Workspace, CurrentUser, FileInfo } from "../types";
import { apiFetch } from "../api";
import { makeBuiltinAvatarValue } from "../lib/avatar";
import { refreshChannels, refreshDMs, refreshWorkspaces } from "../lib/refresh";
import { AvatarVisual } from "./AvatarVisual";
import { AppIcon, FileTypeIcon } from "./icons";
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
  beginnerMode: boolean;
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
  onUploadPersonalFiles?: (files: File[]) => void | Promise<void>;
  fileLibraryRefreshKey?: number;
  onPreloadChannel?: (channelId: string) => void;
  onOpenMessage?: (channelId: string, msgId: string) => void;
}

const WS_LETTER_COLORS = ["#7c6cf5", "#3ecf8e", "#f5a623", "#56a7ff", "#f05454", "#9586ff"];
type PersonalAddDialogState = {
  kind: "dm" | "project" | "projectChat";
  projectId: string;
  projectTitle: string;
} | null;
type PersonalSectionKey = "dms" | "files" | "projects";
type PersonalFileItem = FileInfo & {
  channel_id?: string | null;
  channel_label?: string | null;
  created_at?: string | null;
  summary_3lines?: string | null;
  scope_type?: string | null;
  scope_id?: string | null;
};
type ProjectTaskItem =
  | { kind: "dm"; key: string; dm: DM; botLabel: string; label: string; createdAt: number }
  | { kind: "channel"; key: string; channel: Channel; label: string; createdAt: number };

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
  beginnerMode,
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
  onUploadPersonalFiles,
  fileLibraryRefreshKey = 0,
  onPreloadChannel,
  onOpenMessage,
}: SidebarProps) {
  const currentWs = workspaces.find((w) => w.workspace_id === selectedWorkspaceId);
  const currentWsLabel = currentWs
    ? currentWs.kind === "personal"
      ? "Personal"
      : currentWs.name
    : "All spaces";
  const currentWsLetter = currentWs
    ? currentWs.kind === "personal"
      ? "P"
      : [...currentWs.name.trim()].slice(0, 2).join("").toUpperCase() || "?"
    : "∗";
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
    ? searchWorkspace?.kind === "personal"
      ? "Personal"
      : searchWorkspace?.name || "Current workspace"
    : "All spaces";
  const searchScopeLabel = searchWorkspaceId ? searchScopeName : "All spaces";
  const searchScopeTitle = searchWorkspaceId
    ? `Channel and message scope: ${searchScopeName}; members and bots are searched globally`
    : "Search channels, messages, members, and bots globally";
  const searchScopeOptions = useMemo<SearchScopeOption[]>(
    () => [
      {
        value: "",
        label: "All spaces",
        title: "Search channels, messages, members, and bots globally",
        marker: "∗",
      },
      ...workspaces.map((w) => {
        const trimmed = w.name.trim();
        const marker = w.kind === "personal"
          ? "P"
          : [...trimmed].slice(0, 2).join("").toUpperCase() || "?";
        return {
          value: w.workspace_id,
          label: w.kind === "personal" ? "Personal" : w.name,
          title: w.kind === "personal" ? "Personal · DMs" : "Workspace · Channels",
          marker,
        };
      }),
    ],
    [workspaces],
  );
  const searchTypeOptions = useMemo<SearchTypeFilterOption[]>(
    () => [
      { type: "workspaces", label: "Spaces" },
      { type: "channels", label: "Channels" },
      { type: "users", label: "Members" },
      { type: "bots", label: "Bot" },
      { type: "files", label: "Files" },
      { type: "messages", label: "Messages" },
      { type: "todos", label: "Todos" },
      { type: "tasks", label: "Tasks" },
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
  const [projectTaskKind, setProjectTaskKind] = useState<"bot" | "channel">("bot");
  const [channelTaskDraftTitle, setChannelTaskDraftTitle] = useState("");
  const [creatingProjectChannelTask, setCreatingProjectChannelTask] = useState(false);
  const [personalFiles, setPersonalFiles] = useState<PersonalFileItem[]>([]);
  const [personalFilesLoading, setPersonalFilesLoading] = useState(false);
  const [collapsedPersonalSections, setCollapsedPersonalSections] = useState<
    Record<PersonalSectionKey, boolean>
  >({
    dms: false,
    files: false,
    projects: false,
  });
  const [channelsCollapsed, setChannelsCollapsed] = useState(false);
  const personalUploadInputRef = useRef<HTMLInputElement>(null);

  const dmWorkspaceId = useMemo(
    () => selectedWorkspaceId || workspaces[0]?.workspace_id || "",
    [selectedWorkspaceId, workspaces],
  );

  const resetSearch = () => {
    searchPickerRef.current?.clear();
  };

  const personalSectionExpanded = (key: PersonalSectionKey) =>
    !collapsedPersonalSections[key];

  const togglePersonalSection = (key: PersonalSectionKey) => {
    setCollapsedPersonalSections((prev) => ({
      ...prev,
      [key]: !prev[key],
    }));
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

  const visibleChannels = useMemo(
    () =>
      channels.filter(
        (channel) =>
          (!selectedWorkspaceId || channel.workspace_id === selectedWorkspaceId) &&
          channel.project_task_type !== "channel",
      ),
    [channels, selectedWorkspaceId],
  );

  const projectGroups = useMemo(() => {
    const groups = new Map<
      string,
      {
        projectId: string;
        projectTitle: string;
        tasks: ProjectTaskItem[];
      }
    >();
    const counts = new Map<string, number>();
    const ensureGroup = (projectId: string, projectTitle: string) => {
      const group = groups.get(projectId) || { projectId, projectTitle, tasks: [] };
      groups.set(projectId, group);
      return group;
    };
    for (const dm of visiblePersonalDms.filter((item) => item.counterparty.member_type === "bot")) {
      const cp = dm.counterparty;
      const botLabel = cp.display_name || cp.username || "Bot";
      const projectId = dm.project_id || "personal-project-default";
      const projectTitle = dm.project_title || "Project 1";
      const next = (counts.get(projectId) || 0) + 1;
      counts.set(projectId, next);
      const chatLabel = dm.chat_title?.trim() || dm.title?.trim() || `Chat ${next}`;
      ensureGroup(projectId, projectTitle).tasks.push({
        kind: "dm",
        key: dm.channel_id,
        dm,
        botLabel,
        label: `${botLabel} · ${chatLabel}`,
        createdAt: dm.created_at ? Date.parse(dm.created_at) : 0,
      });
    }
    for (const channel of channels) {
      if (
        channel.workspace_id !== selectedWorkspaceId ||
        channel.project_task_type !== "channel" ||
        !channel.project_id
      ) {
        continue;
      }
      const projectTitle = channel.project_title || "Project 1";
      ensureGroup(channel.project_id, projectTitle).tasks.push({
        kind: "channel",
        key: channel.channel_id,
        channel,
        label: channel.task_title || channel.name || "Channel",
        createdAt: 0,
      });
    }
    return [...groups.values()]
      .sort((a, b) => a.projectTitle.localeCompare(b.projectTitle, "zh-Hans-CN"))
      .map((group) => ({
        ...group,
        tasks: group.tasks.sort((a, b) => a.createdAt - b.createdAt || a.label.localeCompare(b.label, "zh-Hans-CN")),
      }));
  }, [channels, selectedWorkspaceId, visiblePersonalDms]);

  const nextProjectTitle = () => `Project ${projectGroups.length + 1}`;

  const nextProjectChatTitle = (projectId: string) => {
    const count =
      projectGroups.find((group) => group.projectId === projectId)?.tasks.length ?? 0;
    return `Chat ${count + 1}`;
  };

  const nextProjectTaskTitle = (projectId: string) => {
    const count =
      projectGroups.find((group) => group.projectId === projectId)?.tasks.length ?? 0;
    return `Task ${count + 1}`;
  };

  const handlePersonalUploadClick = () => {
    if (!selectedId) {
      toast.error("Select a DM or task before uploading files");
      return;
    }
    personalUploadInputRef.current?.click();
  };

  const handlePersonalUploadInput = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (files.length === 0) return;
    if (!onUploadPersonalFiles) {
      toast.error("File upload is not available");
      return;
    }
    void Promise.resolve(onUploadPersonalFiles(files)).catch(() => {
      toast.error("Failed to upload files");
    });
  };

  useEffect(() => {
    if (!isPersonalWorkspace) {
      setPersonalFiles([]);
      setPersonalFilesLoading(false);
      return;
    }
    let active = true;
    setPersonalFilesLoading(true);
    apiFetch("/files/library", { token: authToken })
      .then((response) => (response.ok ? response.json() : { data: [] }))
      .then((payload) => {
        if (!active) return;
        const files: PersonalFileItem[] = Array.isArray(payload?.data) ? payload.data : [];
        setPersonalFiles(
          files
            .map((file: PersonalFileItem) => ({
              ...file,
              channel_label: file.channel_label || "Files",
            }))
            .sort((a, b) => {
              const at = a.created_at ? Date.parse(a.created_at) : 0;
              const bt = b.created_at ? Date.parse(b.created_at) : 0;
              return bt - at;
            }),
        );
      })
      .catch(() => {
        if (active) setPersonalFiles([]);
      })
      .finally(() => {
        if (active) setPersonalFilesLoading(false);
      });
    return () => {
      active = false;
    };
  }, [authToken, fileLibraryRefreshKey, isPersonalWorkspace]);

  const deletePersonalFile = async (
    file: PersonalFileItem,
    event: ReactMouseEvent<HTMLButtonElement>,
  ) => {
    event.stopPropagation();
    const label = file.original_filename || file.file_id;
    if (
      !confirm(
        `Remove "${label}" from Files? Messages that use it will keep their attachment.`,
      )
    )
      return;
    try {
      const response = await apiFetch(
        `/files/${encodeURIComponent(file.file_id)}`,
        { method: "DELETE", token: authToken },
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.status === "error") {
        throw new Error(payload?.message || payload?.detail || "Remove failed");
      }
      setPersonalFiles((files) =>
        files.filter((item) => item.file_id !== file.file_id),
      );
      toast.success("File removed");
    } catch (error: unknown) {
      toast.error((error as Error).message || "Remove failed");
    }
  };

  const selectWorkspace = (workspaceId: string) => {
    setSelectedWorkspaceId(workspaceId);
    setSearchWorkspaceId(workspaceId);
    resetSearch();
  };

  const workspaceInitials = (workspace: Workspace) => {
    if (workspace.kind === "personal") return "P";
    const trimmed = workspace.name.trim();
    return [...trimmed].slice(0, 2).join("").toUpperCase() || "?";
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
      toast.error("Select a workspace first");
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
      toast.error(options.createNew ? "Failed to start chat" : "Failed to start DM");
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
    if (beginnerMode && kind === "projectChat") {
      void createProjectChannelTaskFrom({
        projectId,
        projectTitle,
        taskTitle: nextProjectTaskTitle(projectId),
      });
      return;
    }
    setProjectDraftTitle(projectTitle);
    setProjectTaskKind(beginnerMode ? "channel" : "bot");
    setChannelTaskDraftTitle(nextProjectTaskTitle(projectId));
    setPersonalAddDialog({
      kind,
      projectId,
      projectTitle,
    });
  };

  const openMessageHit = (channelId: string, msgId: string) => {
    if (onOpenMessage) {
      onOpenMessage(channelId, msgId);
    } else {
      const channel = channels.find((c) => c.channel_id === channelId);
      const dm = dms.find((d) => d.channel_id === channelId);
      if (channel?.workspace_id) {
        setSelectedWorkspaceId(channel.workspace_id);
      } else if (dm?.workspace_id) {
        setSelectedWorkspaceId(dm.workspace_id);
      }
      setSelectedId(channelId);
    }
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
      if (selection.type !== "user" && selection.type !== "bot") {
        toast.error("Select a member or bot to start a DM");
        return;
      }
      setPersonalAddDialog(null);
      openDmWith(
        selection.type === "user" ? selection.item.user_id : selection.item.bot_id,
        selection.type,
      );
      return;
    }
    if (personalAddDialog.kind === "project" || personalAddDialog.kind === "projectChat") {
      if (selection.type !== "bot") {
        toast.error("Select a bot to add to the project");
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

  const loadVisibleBotIds = async (): Promise<string[]> => {
    const response = await apiFetch("/bots", { token: authToken });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.status === "error") {
      throw new Error(payload?.detail || payload?.message || "Failed to load bots");
    }
    const bots: BotItem[] = Array.isArray(payload?.data) ? payload.data : [];
    return bots.map((bot) => bot.bot_id).filter(Boolean);
  };

  const createProjectChannelTaskFrom = async ({
    projectId,
    projectTitle,
    taskTitle,
  }: {
    projectId: string;
    projectTitle: string;
    taskTitle: string;
  }) => {
    if (!dmWorkspaceId) {
      toast.error("Select Personal first");
      return;
    }
    if (creatingProjectChannelTask) return;
    setCreatingProjectChannelTask(true);
    try {
      const initialBotIds = beginnerMode ? await loadVisibleBotIds() : [];
      const response = await apiFetch("/channels", {
        method: "POST",
        token: authToken,
        body: {
          workspace_id: dmWorkspaceId,
          name: taskTitle,
          type: "private",
          allow_member_invites: false,
          allow_bot_adds: true,
          project_id: projectId,
          project_title: projectTitle,
          task_title: taskTitle,
          initial_bot_ids: initialBotIds,
        },
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.data) {
        throw new Error(payload?.detail || payload?.message || "Create channel task failed");
      }
      const channel = payload.data as Channel;
      setChannels((prev) =>
        prev.some((item) => item.channel_id === channel.channel_id)
          ? prev.map((item) => (item.channel_id === channel.channel_id ? channel : item))
          : [...prev, channel],
      );
      setSelectedId(channel.channel_id);
      setPersonalAddDialog(null);
      resetSearch();
      if (isMobile) setSidebarOpen(false);
      toast.success("Task channel created");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to create channel task");
    } finally {
      setCreatingProjectChannelTask(false);
    }
  };

  const createProjectChannelTask = async () => {
    if (!personalAddDialog || personalAddDialog.kind === "dm") return;
    const projectTitle =
      personalAddDialog.kind === "project"
        ? projectDraftTitle.trim() || personalAddDialog.projectTitle
        : personalAddDialog.projectTitle;
    const taskTitle =
      channelTaskDraftTitle.trim() || nextProjectTaskTitle(personalAddDialog.projectId);
    await createProjectChannelTaskFrom({
      projectId: personalAddDialog.projectId,
      projectTitle,
      taskTitle,
    });
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
        width: isMobile ? "min(85vw, 360px)" : leftWidth,
        transform:
          isMobile && !sidebarOpen ? "translateX(-100%)" : "translateX(0)",
        minHeight: 0,
      }}
    >
      {isMobile && (
        <div className="an-mobile-ws-strip" aria-label="Workspaces">
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
            title="Create workspace"
            aria-label="Create workspace"
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
          {isMobile && (
            <button
              type="button"
              onClick={() => setSidebarOpen(false)}
              title="Close navigation"
              aria-label="Close navigation"
              className="w-7 h-7 flex items-center justify-center rounded-md transition-colors hover:bg-[var(--surface-soft)]"
              style={{ color: "var(--fg-3)" }}
            >
              <AppIcon name="close" className="w-4 h-4" />
            </button>
          )}
          {selectedWorkspaceId && (
            <Tooltip content="Set workspace icon">
              <button
                type="button"
                onClick={() => setWorkspaceSettingsOpen(true)}
                title="Set workspace icon"
                aria-label="Set workspace icon"
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
              title="Workspace actions"
              aria-label="Workspace actions"
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
                <span>Edit workspace</span>
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
                <span>Invite members</span>
              </button>
              <div className="an-menu-sep" />
              <button
                type="button"
                className="an-menu-item"
                style={{ color: "var(--red)" }}
                onClick={() => {
                  setWsMenuOpen(false);
                  if (
                    !confirm("Delete this workspace? Deleting it will also delete its channels.")
                  )
                    return;
                  apiFetch(`/workspaces/${selectedWorkspaceId}`, {
                    method: "DELETE",
                    token: authToken,
                  })
                    .then((r) => r.json())
                    .then((d) => {
                      if (d.status === "success") {
                        toast.success("Workspace deleted");
                        setSelectedWorkspaceId("");
                        refreshWorkspaces(setWorkspaces, authToken);
                        refreshChannels(setChannels, authToken);
                      } else {
                        toast.error(d.detail || "Delete failed");
                      }
                    })
                    .catch(() => toast.error("Request failed"));
                }}
              >
                <span
                  className="an-mi-ico inline-flex w-4 h-4"
                  style={{ color: "var(--red)" }}
                >
                  <AppIcon name="close" className="w-full h-full" />
                </span>
                <span>Delete workspace</span>
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
          "Search messages / files / channels / members / bots"
        }
        keyboardHint="⌘K"
        enableShortcut
        wide
        typeOptions={searchTypeOptions}
        scopeLabel={searchScopeLabel}
        scopeTitle={searchScopeTitle}
        scopeValue={searchWorkspaceId}
        scopeOptions={searchScopeOptions}
        onScopeChange={setSearchWorkspaceId}
        onSelect={handleSearchSelect}
      />

      {/* Channels + Direct sections share a single scroller */}
      <div className="an-rail-scroll">
      {!isPersonalWorkspace && (
        <>
      <div className="an-rail-section-h">
        <span>Channels</span>
        <span className="an-rail-count">{visibleChannels.length}</span>
        <button
          type="button"
          className="an-rail-section-toggle"
          title={channelsCollapsed ? "Expand" : "Collapse"}
          aria-label={channelsCollapsed ? "Expand Channels" : "Collapse Channels"}
          aria-expanded={!channelsCollapsed}
          onClick={() => setChannelsCollapsed((collapsed) => !collapsed)}
        >
          <AppIcon name={channelsCollapsed ? "chevronRight" : "chevronDown"} />
        </button>
      </div>
      {!channelsCollapsed && (
      <ul className="px-2 py-1">
        <li>
          <button
            type="button"
            onClick={() => {
              if (!selectedWorkspaceId) {
                toast.error("Select a workspace first");
                return;
              }
              onOpenCreateChannel();
            }}
            className="an-rail-row an-rail-action-row w-full"
            title="Create channel"
          >
            <span className="an-sigil">
              <AppIcon name="plus" />
            </span>
            <span className="an-name">New Item</span>
          </button>
        </li>
        {visibleChannels.map((c) => {
            const isActive = selectedId === c.channel_id;
            const ws = !selectedWorkspaceId && c.workspace_id
              ? workspaces.find((w) => w.workspace_id === c.workspace_id)
              : null;
            const abbrev = ws ? [...ws.name.trim()].slice(0, 2).join("").toUpperCase() : "";
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
                  title="Delete channel"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!confirm(`Delete channel "${c.name}"? This cannot be undone.`)) return;
                    apiFetch(`/channels/${c.channel_id}`, { method: "DELETE", token: authToken })
                      .then(async (r) => {
                        const payload = await r.json().catch(() => null);
                        if (!r.ok || payload?.status === "error") {
                          throw new Error(payload?.detail || payload?.message || "Delete failed");
                        }
                        setChannels((prev) => prev.filter((x) => x.channel_id !== c.channel_id));
                        if (selectedId === c.channel_id) setSelectedId(null);
                        toast.success("Channel deleted");
                      })
                      .catch((err) => toast.error(err?.message || "Failed to delete channel"));
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
      )}
        </>
      )}

      {/* Personal workspace: user DMs, files gathered from personal chats, and
          bot conversations grouped under Projects. */}
      {isPersonalWorkspace && (
        <>
      <div className="an-rail-section-h">
        <span>DMs</span>
        <button
          type="button"
          className="an-rail-section-toggle an-rail-section-toggle-solo"
          title={personalSectionExpanded("dms") ? "Collapse" : "Expand"}
          aria-label={personalSectionExpanded("dms") ? "Collapse DMs" : "Expand DMs"}
          aria-expanded={personalSectionExpanded("dms")}
          onClick={() => togglePersonalSection("dms")}
        >
          <AppIcon name={personalSectionExpanded("dms") ? "chevronDown" : "chevronRight"} />
        </button>
      </div>
      {personalSectionExpanded("dms") && (
          <ul className="px-2 py-1 pb-2">
            <li>
              <button
                type="button"
                className="an-rail-row an-rail-action-row w-full"
                title="New DM"
                onClick={() => openPersonalAddDialog("dm")}
              >
                <span className="an-sigil">
                  <AppIcon name="plus" />
                </span>
                <span className="an-name">New DM</span>
              </button>
            </li>
            {directDms.length === 0 && (
              <li className="an-rail-empty">No DMs yet</li>
            )}
            {directDms.map((d) => {
                const isActive = selectedId === d.channel_id;
                const cp = d.counterparty;
                const label =
                  cp.display_name ||
                  cp.username ||
                  (cp.member_type === "system" ? "System" : "User");
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
                      title="Leave this DM"
                      aria-label="Leave this DM"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!currentUser) return;
                        if (
                          !confirm(
                            `Remove "${label}" from the DM list? It will reappear when the other person messages again.`,
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
                          .catch(() => toast.error("Failed to sign out of DM"));
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
      )}

      <div className="an-rail-section-h">
        <span>Files</span>
        <span className="an-rail-count">
          {personalFilesLoading ? "..." : personalFiles.length}
        </span>
        <button
          type="button"
          className="an-rail-section-toggle"
          title={personalSectionExpanded("files") ? "Collapse" : "Expand"}
          aria-label={personalSectionExpanded("files") ? "Collapse Files" : "Expand Files"}
          aria-expanded={personalSectionExpanded("files")}
          onClick={() => togglePersonalSection("files")}
        >
          <AppIcon name={personalSectionExpanded("files") ? "chevronDown" : "chevronRight"} />
        </button>
      </div>
      {personalSectionExpanded("files") && (
      <ul className="px-2 py-1 pb-2">
        <li>
          <button
            type="button"
            className="an-rail-row an-rail-action-row w-full"
            title="Upload File"
            onClick={handlePersonalUploadClick}
          >
            <span className="an-sigil">
              <AppIcon name="upload" />
            </span>
            <span className="an-name">Upload File</span>
          </button>
        </li>
        {personalFiles.length === 0 && (
          <li className="an-rail-empty">
            {personalFilesLoading ? "Loading files..." : "No files"}
          </li>
        )}
        {personalFiles.map((file) => (
          <li key={`${file.channel_id || "library"}:${file.file_id}`} className="group relative">
            <button
              type="button"
              className="an-rail-row w-full pr-7"
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
                <FileTypeIcon
                  contentType={file.content_type}
                  filename={file.original_filename || file.file_id}
                  size={14}
                  title={file.original_filename || file.file_id}
                />
              </span>
              <span className="an-name">
                {file.original_filename || file.file_id}
              </span>
            </button>
            <Tooltip
              content="Remove from files"
              placement="right"
              className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity"
            >
              <button
                type="button"
                onClick={(event) => void deletePersonalFile(file, event)}
                className="w-6 h-6 flex items-center justify-center rounded hover:bg-[var(--surface-hover)]"
                style={{ color: "var(--fg-3)" }}
                title="Remove from files"
                aria-label="Remove from files"
              >
                <AppIcon name="trash" className="w-3 h-3" />
              </button>
            </Tooltip>
          </li>
        ))}
      </ul>
      )}

      <div className="an-rail-section-h">
        <span>Project</span>
        <button
          type="button"
          className="an-rail-section-toggle an-rail-section-toggle-solo"
          title={personalSectionExpanded("projects") ? "Collapse" : "Expand"}
          aria-label={personalSectionExpanded("projects") ? "Collapse Project" : "Expand Project"}
          aria-expanded={personalSectionExpanded("projects")}
          onClick={() => togglePersonalSection("projects")}
        >
          <AppIcon name={personalSectionExpanded("projects") ? "chevronDown" : "chevronRight"} />
        </button>
      </div>
      {personalSectionExpanded("projects") && (
      <ul className="px-2 py-1 pb-2">
        <li>
          <button
            type="button"
            className="an-rail-row an-rail-action-row w-full"
            title="New Project"
            onClick={() => openPersonalAddDialog("project")}
          >
            <span className="an-sigil">
              <AppIcon name="plus" />
            </span>
            <span className="an-name">New Project</span>
          </button>
        </li>
        {projectGroups.length === 0 && (
          <li className="an-rail-empty">No projects yet</li>
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
            </div>
            <ul className="an-project-chats">
              <li>
                <button
                  type="button"
                  className="an-rail-row an-rail-action-row an-project-chat-row w-full"
                  title="New Task"
                  disabled={beginnerMode && creatingProjectChannelTask}
                  onClick={() => openPersonalAddDialog("projectChat", project)}
                >
                  <span className="an-sigil">
                    <AppIcon name="plus" />
                  </span>
                  <span className="an-name">New Task</span>
                </button>
              </li>
              {project.tasks.map((task) => {
                const channelId = task.kind === "dm" ? task.dm.channel_id : task.channel.channel_id;
                const isActive = selectedId === channelId;
                const cp = task.kind === "dm" ? task.dm.counterparty : null;
                const label = task.label;
                return (
                  <li
                    key={task.key}
                    className="group relative"
                    onClick={() => isMobile && setSidebarOpen(false)}
                  >
                    <button
                      type="button"
                      onClick={() => setSelectedId(channelId)}
                      onFocus={() => onPreloadChannel?.(channelId)}
                      onPointerEnter={() => onPreloadChannel?.(channelId)}
                      className={`an-rail-row an-project-chat-row w-full ${
                        isActive ? "active" : ""
                      } pr-7`}
                      title={cp?.username ? `${label} · @${cp.username}` : label}
                    >
                      <span className="an-sigil">
                        {task.kind === "dm" ? (
                          <MemberAvatar
                            avatarUrl={cp?.avatar_url}
                            kind="bot"
                            label={task.botLabel}
                            size={16}
                          />
                        ) : (
                          <AppIcon name="channel" />
                        )}
                      </span>
                      <span className="an-name">{label}</span>
                      {!isActive &&
                        ((task.kind === "dm" ? task.dm.unread_count : task.channel.unread_count) ?? 0) > 0 && (
                        <span className="an-rail-tags">
                          <span className="an-unread">
                            {((task.kind === "dm" ? task.dm.unread_count : task.channel.unread_count) ?? 0) > 99
                              ? "99+"
                              : (task.kind === "dm" ? task.dm.unread_count : task.channel.unread_count)}
                          </span>
                        </span>
                      )}
                    </button>
                    <button
                      type="button"
                      title="Remove this chat"
                      aria-label="Remove this chat"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!currentUser) return;
                        if (
                          !confirm(
                            task.kind === "dm"
                              ? `Remove "${label}"? It will reappear when the bot messages again.`
                              : `Delete channel task "${label}"?`,
                          )
                        )
                          return;
                        const request =
                          task.kind === "dm"
                            ? apiFetch(
                                `/channels/${task.dm.channel_id}/members/${currentUser.user_id}`,
                                { method: "DELETE", token: authToken },
                              )
                            : apiFetch(`/channels/${task.channel.channel_id}`, {
                                method: "DELETE",
                                token: authToken,
                              });
                        request
                          .then((r) => {
                            if (!r.ok) throw new Error("leave failed");
                            if (task.kind === "dm") {
                              setDMs?.((prev) =>
                                prev.filter((x) => x.channel_id !== task.dm.channel_id),
                              );
                            } else {
                              setChannels((prev) =>
                                prev.filter((x) => x.channel_id !== task.channel.channel_id),
                              );
                            }
                            if (selectedId === channelId) {
                              setSelectedId(null);
                            }
                          })
                          .catch(() => toast.error("Failed to remove chat"));
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
      )}
        </>
      )}

      </div>

      <input
        ref={personalUploadInputRef}
        type="file"
        multiple
        className="sr-only"
        tabIndex={-1}
        onChange={handlePersonalUploadInput}
      />

      {/* Account footer: avatar with presence, display name, and settings. */}
      <div className="an-rail-foot">
        {currentUser ? (
          <>
            <Tooltip content="Online now" placement="top">
              <span
                className="an-account-avatar-wrap"
                tabIndex={0}
                aria-label="Online now"
                title="Online now"
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
          ? "Start DM"
          : personalAddDialog?.kind === "project"
            ? "Create Project"
            : beginnerMode
              ? "New Task"
              : "Add Bot Chat"
      }
      description={
        personalAddDialog?.kind === "dm"
          ? "Search members and create DMs."
          : personalAddDialog?.kind === "project"
            ? beginnerMode
              ? "Name the project. A private task channel will include every bot you can use."
              : "Name the project, then choose the first task."
            : beginnerMode
              ? `Create a private task channel in ${personalAddDialog?.projectTitle || "Project"}.`
              : `Add a task to ${personalAddDialog?.projectTitle || "Project"}.`
      }
    >
      {personalAddDialog?.kind === "project" && (
        <label className="mb-3 block">
          <span className="mb-1 block text-xs font-medium" style={{ color: "var(--fg-2)" }}>
            Project Name
          </span>
          <input
            value={projectDraftTitle}
            onChange={(event) => setProjectDraftTitle(event.target.value)}
            className="an-input"
            maxLength={80}
          />
        </label>
      )}
      {personalAddDialog?.kind !== "dm" && !beginnerMode && (
        <div className="an-tabs mb-3" role="tablist" aria-label="Task type">
          <button
            type="button"
            role="tab"
            aria-selected={projectTaskKind === "bot"}
            className={`an-tab ${projectTaskKind === "bot" ? "on" : ""}`}
            onClick={() => setProjectTaskKind("bot")}
          >
            Bot DM
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={projectTaskKind === "channel"}
            className={`an-tab ${projectTaskKind === "channel" ? "on" : ""}`}
            onClick={() => setProjectTaskKind("channel")}
          >
            Channel
          </button>
        </div>
      )}
      {personalAddDialog?.kind !== "dm" && (beginnerMode || projectTaskKind === "channel") ? (
        <div className="space-y-3">
          {!beginnerMode && (
            <label className="block">
              <span className="mb-1 block text-xs font-medium" style={{ color: "var(--fg-2)" }}>
                Task Name
              </span>
              <input
                value={channelTaskDraftTitle}
                onChange={(event) => setChannelTaskDraftTitle(event.target.value)}
                className="an-input"
                maxLength={80}
                autoFocus
              />
            </label>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="an-btn an-btn-ghost"
              onClick={() => setPersonalAddDialog(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="an-btn an-btn-primary"
              disabled={creatingProjectChannelTask}
              onClick={createProjectChannelTask}
            >
              {creatingProjectChannelTask ? "Creating..." : "Create"}
            </button>
          </div>
        </div>
      ) : (
        <SearchPicker
          key={`${personalAddDialog?.kind || "none"}:${personalAddDialog?.projectId || ""}:${projectTaskKind}`}
          context="dm_start"
          token={authToken}
          workspaceId={searchWorkspaceId || undefined}
          types={personalAddDialog?.kind === "dm" ? ["users", "bots"] : ["bots"]}
          placeholder={personalAddDialog?.kind === "dm" ? "Search or choose users and bots" : "Search or choose bots"}
          modal
          autoFocus
          showInitialResults
          emptyText={personalAddDialog?.kind === "dm" ? "No users or bots available to add" : "No bots available to add"}
          actionLabel={personalAddDialog?.kind === "dm" ? "DM" : "Add"}
          onSelect={handlePersonalAddSelect}
        />
      )}
    </Modal>
    </>
  );
}
