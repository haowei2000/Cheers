import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import toast from "react-hot-toast";
import NotificationPanel from "./NotificationPanel";
import { useTheme } from "./useTheme";
import { useAuth } from "./hooks/useAuth";
import { useResize } from "./hooks/useResize";
import { AppIcon } from "./components/icons/AppIcon";
import { LoginModal } from "./components/LoginModal";
import { CreateWorkspaceModal } from "./components/CreateWorkspaceModal";
import { InviteWorkspaceMemberModal } from "./components/InviteWorkspaceMemberModal";
import { CreateChannelModal } from "./components/CreateChannelModal";
import { OpenClawQcModal } from "./components/OpenClawQcModal";
import { ChannelSettingsModal } from "./components/ChannelSettingsModal";
import { Sidebar } from "./components/Sidebar";
import { HelpModal } from "./components/HelpModal";
import { ImageLightbox } from "./components/ImageLightbox";
import { ChatAttachments } from "./components/ChatMessageRenderer";
import type { MemoryTab } from "./components/ChannelHeader";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { AddBotModal } from "./components/app/AddBotModal";
import { ChannelMainFrame } from "./components/app/ChannelMainFrame";
import { ChatShell } from "./components/app/ChatShell";
import { ChatSidePanels } from "./components/app/ChatSidePanels";
import { ChatWorkspaceView } from "./features/chat/ChatWorkspaceView";
import { useComposerController } from "./features/chat/hooks/useComposerController";
import { usePendingFiles } from "./features/chat/hooks/usePendingFiles";
import { MessageDetailModal } from "./components/app/MessageDetailModal";
import { AgentBridgeTaskCard } from "./features/chat/messages/AgentBridgeTaskCard";
import { apiFetch, buildWsUrl } from "./api";
import {
  parseHelperPayload,
  isClarifyReplyUserMessage,
} from "./lib/helper";
import {
  buildTopicTree,
  isMsgReply,
  mergeMessagesChronologically,
} from "./lib/message";
import { refreshChannels, refreshDMs, refreshWorkspaces } from "./lib/refresh";
import { API, API_DOCS_URL } from "./lib/app-config";
import { applyDensity, getStoredDensity } from "./lib/density";
import {
  AGENT_BRIDGE_TASK_KIND,
  getActiveAgentBridgeTaskData,
  getAgentBridgeTaskData,
  type AgentBridgeTaskMessage,
} from "./lib/agent-bridge";
import {
  botTraceStatusText,
  makeClientStreamTrace,
  trimBotTraceEvents,
} from "./lib/bot-trace";
import {
  buildChatPath,
  buildChatSearch,
  readChatUrlState,
  type ChatRouteParams,
} from "./lib/chat-routing";
import {
  MAX_LOADED_MESSAGES,
  trimToRecentMessages,
  VIRTUAL_MESSAGE_ESTIMATED_HEIGHT,
  type PendingStreamDelta,
} from "./lib/message-window";
import {
  emptyMessageStore,
  messagesToStore,
  patchMessage,
  patchMessages,
  storeToMessages,
  trimMessageStoreToRecent,
  upsertMessage,
  type MessageStore,
} from "./lib/message-store";
import type {
  Channel,
  DM,
  Workspace,
  Message,
  FileInfo,
  BotTraceEvent,
  ContextData,
  ClarifySchema,
  ClarifyAnswers,
  ChannelBot,
  ChannelUser,
  BotItem,
  AgentBridgeTaskContentData,
  MemoryLoadDetail,
} from "./types";
import { OTHER_CHOICE_ID } from "./types";

const SettingsModal = lazy(() =>
  import("./components/SettingsModal").then((module) => ({
    default: module.SettingsModal,
  })),
);

export default function App() {
  const { isDark, setTheme } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();
  const { workspaceId: routeWorkspaceId = "", channelId: routeChannelId = null } =
    useParams<ChatRouteParams>();
  const chatUrlState = useMemo(
    () => readChatUrlState(location.search, location.hash),
    [location.search, location.hash],
  );

  // Apply stored appearance prefs (density only — theme is light/dark, no
  // custom accent since the brand color is fixed in design-tokens.css).
  useEffect(() => {
    applyDensity(getStoredDensity());
  }, []);

  const { currentUser, authToken, currentUserId, authFetch, setAuth, setCurrentUser, logout: clearAuth } =
    useAuth();

  const [loginModalOpen, setLoginModalOpen] = useState(false);

  // 前��错误上报（best-effort, 不抛异常）
  const reportClientError = useCallback(
    (method: string, url: string, status: number, detail: string) => {
      fetch(`${API}/debug/client-error`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          method,
          url,
          status,
          detail: detail.slice(0, 2000),
        }),
      }).catch(() => {});
    },
    [],
  );

  // 全局未捕获 Promise 错误上报
  useEffect(() => {
    const handler = (e: PromiseRejectionEvent) => {
      reportClientError("UNCAUGHT", window.location.href, 0, String(e.reason));
    };
    window.addEventListener("unhandledrejection", handler);
    return () => window.removeEventListener("unhandledrejection", handler);
  }, [reportClientError]);

  // 初始化时检查登录状态
  useEffect(() => {
    if (!currentUser) {
      setLoginModalOpen(true);
    }
  }, []);

  const [channels, setChannels] = useState<Channel[]>([]);
  const [dms, setDMs] = useState<DM[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  // Topic viewer: pageTopicId — root msg_id for the full-page view,
  // mirrored to URL query. There is no side-dock panel; opening a topic
  // always replaces the channel stream with the dedicated page.
  const {
    input,
    inputRevision,
    inputDraftRef,
    inputRef,
    secretInputRef,
    setComposerInput,
    handleComposerValueChange,
    msgKind,
    setMsgKind,
    cycleMsgKind,
    composerTitle,
    setComposerTitle,
    composerTitleRef,
    replyingTo,
    setReplyingTo,
    secretMode,
    resetComposerAfterSend,
  } = useComposerController();
  const [pageTopicId, setPageTopicId] = useState<string | null>(
    () => chatUrlState.topicId,
  );
  const [pageTopicMessages, setPageTopicMessages] = useState<Message[]>([]);
  const [pageTopicLoading, setPageTopicLoading] = useState(false);
  const [pageTopicError, setPageTopicError] = useState<string | null>(null);
  const [taskPageOpen, setTaskPageOpen] = useState(() => chatUrlState.taskOpen);
  const [pageTaskMsgId, setPageTaskMsgId] = useState<string | null>(
    () => chatUrlState.taskMsgId,
  );
  const [refreshingDmSession, setRefreshingDmSession] = useState(false);
  const [dmSessionRefreshNonce, setDmSessionRefreshNonce] = useState(0);
  const [selectedWorkspaceId, setSelectedWorkspaceId] =
    useState<string>(routeWorkspaceId);
  const [selectedId, setSelectedId] = useState<string | null>(routeChannelId);
  const selectedIdRef = useRef<string | null>(null);
  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    if (routeWorkspaceId !== selectedWorkspaceId) {
      setSelectedWorkspaceId(routeWorkspaceId);
    }
    if (routeChannelId !== selectedId) {
      setSelectedId(routeChannelId);
    }
  }, [routeWorkspaceId, routeChannelId]);

  const activeDm = selectedId ? dms.find((d) => d.channel_id === selectedId) ?? null : null;
  const isSystemDm = activeDm?.counterparty.member_type === "system";
  const isDmSelected = Boolean(activeDm);
  const activeBotDm = activeDm?.counterparty.member_type === "bot" ? activeDm : null;
  const activeDmSessionScopeId =
    activeBotDm && currentUserId
      ? `user:${currentUserId}:bot:${activeBotDm.counterparty.member_id}`
      : null;
  const selectionResetReadyRef = useRef(false);
  const botMentionIdsForChannel = (channelId: string): string[] => {
    const dm = dms.find((item) => item.channel_id === channelId);
    return dm?.counterparty.member_type === "bot"
      ? [dm.counterparty.member_id]
      : [];
  };
  useEffect(() => {
    if (selectionResetReadyRef.current) {
      setTaskPageOpen(false);
      setPageTaskMsgId(null);
    } else {
      selectionResetReadyRef.current = true;
    }
    if (isDmSelected) {
      setPageTopicId(null);
      setReplyingTo(null);
      setMsgKind("normal");
      setComposerTitle("");
    }
  }, [isDmSelected, selectedId]);
  const [messageStore, setMessageStore] = useState<MessageStore>(() =>
    emptyMessageStore(),
  );
  const messages = useMemo(() => storeToMessages(messageStore), [messageStore]);
  const setMessages = useCallback(
    (next: Message[] | ((prev: Message[]) => Message[])) => {
      setMessageStore((prevStore) => {
        const prevMessages = storeToMessages(prevStore);
        const nextMessages =
          typeof next === "function" ? next(prevMessages) : next;
        return messagesToStore(nextMessages);
      });
    },
    [],
  );
  const streamDeltaBufferRef = useRef<Record<string, PendingStreamDelta>>({});
  const streamDeltaRafRef = useRef<number | null>(null);
  const [memoryDetailMessage, setMemoryDetailMessage] = useState<Message | null>(null);
  const [loading, setLoading] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // memoryTab drives the 4-tab cluster in the channel header + the drawer.
  //   null          — drawer closed
  //   "PROJECT"     — anchors + progress + decisions (design's Project view)
  //   "FILES_INDEX" — channel files
  //   "MEMBERS"     — members list
  //   "TODO"        — todos
  const [memoryTab, setMemoryTab] = useState<MemoryTab | null>(
    () => chatUrlState.memoryTab,
  );
  const memoryPanelOpen = memoryTab !== null;
  const selectedIdWorkspaceId = useMemo(() => {
    if (!selectedId) return null;
    return (
      channels.find((c) => c.channel_id === selectedId)?.workspace_id ??
      dms.find((d) => d.channel_id === selectedId)?.workspace_id ??
      null
    );
  }, [channels, dms, selectedId]);

  useEffect(() => {
    if (
      selectedId &&
      selectedWorkspaceId &&
      selectedIdWorkspaceId &&
      selectedIdWorkspaceId !== selectedWorkspaceId
    ) {
      setSelectedId(null);
    }
  }, [selectedId, selectedIdWorkspaceId, selectedWorkspaceId]);

  useEffect(() => {
    setPageTopicId((prev) =>
      prev === chatUrlState.topicId ? prev : chatUrlState.topicId,
    );
    setTaskPageOpen((prev) =>
      prev === chatUrlState.taskOpen ? prev : chatUrlState.taskOpen,
    );
    setPageTaskMsgId((prev) =>
      prev === chatUrlState.taskMsgId ? prev : chatUrlState.taskMsgId,
    );
    setMemoryTab((prev) =>
      prev === chatUrlState.memoryTab ? prev : chatUrlState.memoryTab,
    );
  }, [
    chatUrlState.topicId,
    chatUrlState.taskOpen,
    chatUrlState.taskMsgId,
    chatUrlState.memoryTab,
  ]);

  useEffect(() => {
    const urlSelectedId =
      selectedIdWorkspaceId && selectedIdWorkspaceId !== selectedWorkspaceId
        ? null
        : selectedId;
    const pathname = buildChatPath(selectedWorkspaceId, urlSelectedId);
    const search = urlSelectedId
      ? buildChatSearch({
          topicId: pageTopicId,
          taskOpen: taskPageOpen,
          taskMsgId: pageTaskMsgId,
          memoryTab,
        })
      : "";
    const target = `${pathname}${search ? `?${search}` : ""}`;
    const current = `${location.pathname}${location.search}`;
    if (current !== target || location.hash) {
      navigate(target, { replace: true });
    }
  }, [
    memoryTab,
    navigate,
    pageTaskMsgId,
    pageTopicId,
    selectedId,
    selectedIdWorkspaceId,
    selectedWorkspaceId,
    taskPageOpen,
  ]);

  const [contextData, setContextData] = useState<ContextData>({});
  const {
    pendingFileIds,
    pendingFiles,
    removePendingFile,
    clearPendingFiles,
    uploadFileObject,
    uploadFile,
  } = usePendingFiles({
    selectedId,
    currentUserId,
    authFetch,
    onRequireLogin: () => setLoginModalOpen(true),
  });
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const dragCounterRef = useRef(0);

  // Keychain insert popup
  const [keychainPopupOpen, setKeychainPopupOpen] = useState(false);
  const [keychainPopupItems, setKeychainPopupItems] = useState<
    { key_id: string; name: string }[]
  >([]);
  const [keychainPopupLoading, setKeychainPopupLoading] = useState(false);

  const openKeychainPopup = async () => {
    setKeychainPopupOpen((o) => !o);
    if (keychainPopupItems.length > 0) return; // already loaded
    setKeychainPopupLoading(true);
    try {
      const res = await authFetch(`${API}/keychain/`);
      if (res.ok) setKeychainPopupItems(await res.json());
    } catch {
    } finally {
      setKeychainPopupLoading(false);
    }
  };
  const [pendingClarifyReplyMsgId, setPendingClarifyReplyMsgId] = useState<
    string | null
  >(null);
  const [autoAssist, setAutoAssist] = useState(false);
  const [expandedTopics, setExpandedTopics] = useState<Set<string>>(
    new Set(),
  );
  const toggleTopic = (rootId: string) =>
    setExpandedTopics((prev) => {
      const next = new Set(prev);
      next.has(rootId) ? next.delete(rootId) : next.add(rootId);
      return next;
    });
  const [collapsedMessages, setCollapsedMessages] = useState<Set<string>>(
    new Set(),
  );
  const toggleMessage = (msgId: string) =>
    setCollapsedMessages((prev) => {
      const next = new Set(prev);
      next.has(msgId) ? next.delete(msgId) : next.add(msgId);
      return next;
    });

  const [channelBots, setChannelBots] = useState<ChannelBot[]>([]);
  const [channelUsers, setChannelUsers] = useState<ChannelUser[]>([]);
  const [revealedSecrets, setRevealedSecrets] = useState<
    Record<string, string>
  >({});
  const [secretTokens, setSecretTokens] = useState<Record<string, string>>({}); // msg_id -> token（仅发送方当次 session 持有）
  // Lightbox 状态
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [lightboxFileId, setLightboxFileId] = useState<string | null>(null);
  // 文件预览侧边栏
  const [filePreviewPanel, setFilePreviewPanel] = useState<{
    url: string;
    filename: string;
    contentType?: string | null;
    sizeBytes?: number | null;
  } | null>(null);
  // 可伸缩面板宽度
  const [leftWidth, onLeftResize] = useResize(256, 160, 480, "right");
  const [memoryWidth, onMemoryResize] = useResize(288, 200, 600, "left");
  const [filePreviewWidth, onFilePreviewResize] = useResize(
    420,
    280,
    720,
    "left",
  );

  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    const handleResize = () => {
      const mobile = window.innerWidth < 768;
      setIsMobile(mobile);
      if (!mobile) setSidebarOpen(false);
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const [addBotOpen, setAddBotOpen] = useState(false);
  const [createWsOpen, setCreateWsOpen] = useState(false);
  const [createChannelOpen, setCreateChannelOpen] = useState(false);
  const [newWorkspaceName, setNewWorkspaceName] = useState("");
  const [newWorkspaceAvatarUrl, setNewWorkspaceAvatarUrl] = useState("");
  const [inviteWsMemberOpen, setInviteWsMemberOpen] = useState(false);
  const [inviteWsIdentifier, setInviteWsIdentifier] = useState("");
  const [newChannelName, setNewChannelName] = useState("");
  const [allBots, setAllBots] = useState<BotItem[]>([]);
  const [selectedBotIds, setSelectedBotIds] = useState<Set<string>>(new Set());
  const [addingBots, setAddingBots] = useState(false);
  const [channelSettingsOpen, setChannelSettingsOpen] = useState(false);
  const [notifPanelOpen, setNotifPanelOpen] = useState(false);
  const pendingScrollMsgIdRef = useRef<string | null>(null);
  const [_expandedOlderIds, _setExpandedOlderIds] = useState<Set<string>>(
    new Set(),
  );
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const isLoadingOlderRef = useRef(false);
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const lastAutoScrollChannelRef = useRef<string | null>(null);
  const [processingBots, setProcessingBots] = useState<Record<string, string>>(
    {},
  );

  const [qcOpen, setQcOpen] = useState(false);


  const handleNotifNavigate = (channelId: string, msgId?: string) => {
    const workspaceId =
      channels.find((c) => c.channel_id === channelId)?.workspace_id ??
      dms.find((d) => d.channel_id === channelId)?.workspace_id;
    if (workspaceId) setSelectedWorkspaceId(workspaceId);
    setSelectedId(channelId);
    if (msgId) pendingScrollMsgIdRef.current = msgId;
    setNotifPanelOpen(false);
  };

  const handleLogout = () => {
    clearAuth();
    setSelectedId(null);
    setSelectedWorkspaceId("");
    setChannels([]);
    setDMs([]);
    setWorkspaces([]);
    setMessages([]);
    setHasMore(true);
    setLoginModalOpen(true);
  };

  // 创建工作空间
  const handleCreateWorkspace = () => {
    if (!newWorkspaceName.trim()) {
      toast.error("请填写工作空间名称");
      return;
    }
    authFetch(`${API}/workspaces`, {
      method: "POST",
      body: JSON.stringify({
        name: newWorkspaceName.trim(),
        avatar_url: newWorkspaceAvatarUrl.trim() || null,
      }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.status === "success") {
          toast.success("工作空间创建成功");
          setNewWorkspaceName("");
          setNewWorkspaceAvatarUrl("");
          setCreateWsOpen(false);
          refreshWorkspaces(setWorkspaces, authToken ?? undefined);
          setSelectedWorkspaceId(d.data.workspace_id);
        } else {
          toast.error(d.detail || "创建失败");
        }
      })
      .catch(() => toast.error("创建失败"));
  };

  // 邀请成员加入工作空间
  const inviteWorkspaceMember = (identifier: string) => {
    const cleaned = identifier.trim();
    if (!cleaned) {
      toast.error("请输入用户名");
      return;
    }
    if (!selectedWorkspaceId) {
      toast.error("请先选择工作空间");
      return;
    }
    authFetch(`${API}/workspaces/${selectedWorkspaceId}/invite`, {
      method: "POST",
      body: JSON.stringify({ identifier: cleaned }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.status === "success") {
          toast.success(d.message || "邀请成功");
          setInviteWsIdentifier("");
          setInviteWsMemberOpen(false);
        } else {
          toast.error(d.detail || "邀请失败");
        }
      })
      .catch(() => toast.error("邀请失败"));
  };

  const handleInviteWsMember = () => {
    inviteWorkspaceMember(inviteWsIdentifier);
  };

  // 创建频道（项目）
  const handleCreateChannel = () => {
    if (!newChannelName.trim()) {
      toast.error("请填写频道名称");
      return;
    }
    if (!selectedWorkspaceId) {
      toast.error("请先选择工作空间");
      return;
    }
    authFetch(`${API}/channels`, {
      method: "POST",
      body: JSON.stringify({
        workspace_id: selectedWorkspaceId,
        name: newChannelName.trim(),
        type: "public",
        purpose: "",
      }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.status === "success") {
          toast.success("频道创建成功");
          setNewChannelName("");
          setCreateChannelOpen(false);
          refreshChannels(setChannels, authToken ?? undefined);
          setSelectedId(d.data.channel_id);
        } else {
          toast.error(d.detail || "创建失败");
        }
      })
      .catch(() => toast.error("创建失败"));
  };

  useEffect(() => {
    refreshChannels(setChannels, authToken ?? undefined);
    refreshDMs(setDMs, authToken ?? undefined);
    refreshWorkspaces(setWorkspaces, authToken ?? undefined);
  }, [authToken]);

  // Default to the user's Personal workspace on first load (or when the
  // currently-selected workspace is no longer in the list, e.g. after a
  // deletion). Explicit team-workspace picks from the rail are preserved.
  useEffect(() => {
    if (workspaces.length === 0) return;
    const current = workspaces.find(
      (w) => w.workspace_id === selectedWorkspaceId,
    );
    if (current) return;
    const personal = workspaces.find((w) => w.kind === "personal");
    setSelectedWorkspaceId(
      personal?.workspace_id ?? workspaces[0].workspace_id,
    );
  }, [workspaces, selectedWorkspaceId]);

  const activeWorkspace = workspaces.find(
    (w) => w.workspace_id === selectedWorkspaceId,
  );
  const isPersonalWorkspace = activeWorkspace?.kind === "personal";
  const openDirectMessage = useCallback(
    async (memberId: string, memberType: "user" | "bot") => {
      const personal = workspaces.find((w) => w.kind === "personal");
      const workspaceId = personal?.workspace_id ?? selectedWorkspaceId;
      if (!workspaceId) {
        toast.error("请先进入个人空间");
        return;
      }
      try {
        const res = await apiFetch("dms", {
          method: "POST",
          token: authToken,
          body: {
            workspace_id: workspaceId,
            member_id: memberId,
            member_type: memberType,
          },
        });
        const data = await res.json();
        if (!res.ok || data?.status === "error") {
          toast.error(data?.detail || data?.message || "发起私信失败");
          return;
        }
        const dm = data?.data as DM | undefined;
        if (!dm) return;
        setDMs((prev) =>
          prev.some((x) => x.channel_id === dm.channel_id)
            ? prev.map((x) => (x.channel_id === dm.channel_id ? dm : x))
            : [...prev, dm],
        );
        if (personal?.workspace_id) setSelectedWorkspaceId(personal.workspace_id);
        setSelectedId(dm.channel_id);
        setSettingsOpen(false);
      } catch {
        toast.error("发起私信失败");
      }
    },
    [authToken, selectedWorkspaceId, workspaces],
  );

  useEffect(() => {
    setPageTopicMessages([]);
    setPageTopicError(null);
    if (!selectedId || !pageTopicId || isDmSelected) {
      setPageTopicLoading(false);
      return;
    }

    const controller = new AbortController();
    setPageTopicLoading(true);
    authFetch(`${API}/channels/${selectedId}/messages/topics/${pageTopicId}`, {
      signal: controller.signal,
    })
      .then(async (r) => {
        const d = await r.json().catch(() => null);
        if (!r.ok || d?.status === "error") {
          throw new Error(d?.message || d?.detail || `HTTP ${r.status}`);
        }
        if (!controller.signal.aborted) {
          setPageTopicMessages(d?.data || []);
        }
      })
      .catch((e) => {
        if ((e as { name?: string }).name === "AbortError") return;
        setPageTopicError("话题消息加载失败");
      })
      .finally(() => {
        if (!controller.signal.aborted) setPageTopicLoading(false);
      });

    return () => controller.abort();
  }, [authFetch, isDmSelected, pageTopicId, selectedId]);

  useEffect(() => {
    if (!selectedId) {
      setMessages([]);
      setHasMore(true);
      setChannelBots([]);
      setChannelUsers([]);
      setProcessingBots({});
      setAutoAssist(false);
      setReplyingTo(null);
      setLoading(false);
      return;
    }
    const targetChannelId = selectedId;
    const controller = new AbortController();
    const ch = channels.find((c) => c.channel_id === targetChannelId);
    setAutoAssist(ch?.auto_assist ?? false);
    setLoading(true);

    authFetch(`${API}/channels/${targetChannelId}/members?with_username=1`, {
      signal: controller.signal,
    })
      .then((r) => r.json())
      .then((d) => {
        if (controller.signal.aborted || selectedIdRef.current !== targetChannelId) return;
        if (d.data) {
          const bots: ChannelBot[] = d.data
            .filter(
              (m: { member_type: string; username?: string }) =>
                m.member_type === "bot" && m.username,
            )
            .map(
              (m: {
                member_id: string;
                username: string;
                avatar_url?: string;
                display_name?: string;
                scope?: BotItem["scope"];
                owner?: BotItem["owner"];
              }) => ({
                member_id: m.member_id,
                username: m.username,
                avatar_url: m.avatar_url,
                display_name: m.display_name,
                scope: m.scope,
                owner: m.owner,
              }),
            );
          setChannelBots(bots);
          const users: ChannelUser[] = d.data
            .filter(
              (m: { member_type: string; username?: string }) =>
                m.member_type === "user" && m.username,
            )
            .map(
              (m: {
                member_id: string;
                username: string;
                avatar_url?: string;
                display_name?: string;
                scope?: BotItem["scope"];
                owner?: BotItem["owner"];
              }) => ({
                member_id: m.member_id,
                username: m.username,
                avatar_url: m.avatar_url,
                display_name: m.display_name,
                scope: m.scope,
                owner: m.owner,
              }),
          );
          setChannelUsers(users);
        } else {
          setChannelBots([]);
          setChannelUsers([]);
        }
      })
      .catch((error) => {
        if ((error as { name?: string }).name === "AbortError") return;
        if (selectedIdRef.current !== targetChannelId) return;
        setChannelBots([]);
        setChannelUsers([]);
      });

    authFetch(`${API}/channels/${targetChannelId}/messages`, {
      signal: controller.signal,
    })
      .then((r) => r.json())
      .then((d) => {
        if (controller.signal.aborted || selectedIdRef.current !== targetChannelId) return;
        const data = d.data || [];
        const visibleData = trimToRecentMessages(data);
        setMessages(visibleData);
        setHasMore(
          Boolean(d.meta?.has_more ?? data.length >= 30) &&
          visibleData.length < MAX_LOADED_MESSAGES,
        );
      })
      .catch((error) => {
        if ((error as { name?: string }).name === "AbortError") return;
        if (selectedIdRef.current !== targetChannelId) return;
        console.error(error);
      })
      .finally(() => {
        if (!controller.signal.aborted && selectedIdRef.current === targetChannelId) {
          setLoading(false);
        }
      });

    return () => controller.abort();
  }, [authFetch, authToken, channels, selectedId]);

  // ── 上划加载更多历史消息 ──────────────────────────────────────────────────
  const loadMoreMessages = useCallback(async () => {
    if (!selectedId || !hasMore || loadingMore) return;
    if (messages.length >= MAX_LOADED_MESSAGES) {
      setHasMore(false);
      return;
    }
    const targetChannelId = selectedId;
    const oldest = messages[0];
    if (!oldest) return;
    setLoadingMore(true);
    isLoadingOlderRef.current = true;
    const container = messagesContainerRef.current;
    const prevScrollHeight = container?.scrollHeight ?? 0;
    try {
      const r = await authFetch(
        `${API}/channels/${targetChannelId}/messages?before_id=${oldest.msg_id}&limit=50`,
      );
      const d = await r.json();
      const older = d.data || [];
      if (older.length === 0) {
        setHasMore(false);
        return;
      }
      if (selectedIdRef.current !== targetChannelId) return;
      const hitWindowCap = messages.length + older.length >= MAX_LOADED_MESSAGES;
      setHasMore(
        !hitWindowCap && Boolean(d.meta?.has_more ?? older.length >= 50),
      );
      setMessageStore((prev) =>
        trimMessageStoreToRecent(
          messagesToStore([...older, ...storeToMessages(prev)]),
          MAX_LOADED_MESSAGES,
        ),
      );
      // 恢复滚动位置
      requestAnimationFrame(() => {
        if (container) {
          container.scrollTop = container.scrollHeight - prevScrollHeight;
          stickToBottomRef.current =
            container.scrollHeight - container.scrollTop - container.clientHeight < 160;
        }
        isLoadingOlderRef.current = false;
      });
    } catch (e) {
      console.error(e);
      isLoadingOlderRef.current = false;
    } finally {
      setLoadingMore(false);
    }
  }, [selectedId, hasMore, loadingMore, messages, authFetch]);

  const handleMessagesScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      const target = e.currentTarget;
      stickToBottomRef.current =
        target.scrollHeight - target.scrollTop - target.clientHeight < 160;
      if (target.scrollTop < 100 && hasMore && !loadingMore) {
        loadMoreMessages();
      }
    },
    [hasMore, loadingMore, loadMoreMessages],
  );

  const flushStreamDeltaBuffer = useCallback(() => {
    const pending = streamDeltaBufferRef.current;
    streamDeltaBufferRef.current = {};
    if (streamDeltaRafRef.current !== null) {
      cancelAnimationFrame(streamDeltaRafRef.current);
      streamDeltaRafRef.current = null;
    }

    const entries = Object.entries(pending).filter(
      ([, item]) => item.delta.length > 0,
    );
    if (entries.length === 0) return;

    setMessageStore((prev) =>
      patchMessages(
        prev,
        entries.map(([msgId, item]) => ({
          msgId,
          update: (m) => {
            const taskData =
              m.content_data?.kind === AGENT_BRIDGE_TASK_KIND
                ? (m.content_data as AgentBridgeTaskContentData)
                : m._agent_bridge_task;
            const switchingFromTaskCard =
              m.content_data?.kind === AGENT_BRIDGE_TASK_KIND;
            const nextContent = switchingFromTaskCard
              ? item.delta
              : `${m.content || ""}${item.delta}`;
            return {
              ...m,
              content: nextContent,
              content_data: switchingFromTaskCard ? null : m.content_data,
              _agent_bridge_task: taskData
                ? {
                    ...taskData,
                    status: "streaming",
                    message: "正在接收 provider 输出。",
                  }
                : m._agent_bridge_task,
              _bot_trace: trimBotTraceEvents([
                ...(m._bot_trace || []),
                makeClientStreamTrace(
                  m,
                  "message_stream",
                  "收到流式片段",
                  {
                    event_type: "message_stream",
                    delta_chars: item.delta.length,
                    delta_preview: item.delta.slice(0, 160),
                    accumulated_chars: nextContent.length,
                    coalesced_chunks: item.chunks,
                  },
                  item.chunks > 1
                    ? `+${item.delta.length} chars / ${item.chunks} chunks`
                    : `+${item.delta.length} chars`,
                ),
              ]),
              _streaming: true,
            };
          },
        })),
      ),
    );
  }, []);

  const queueStreamDelta = useCallback(
    (msgId: unknown, value: unknown) => {
      const id = typeof msgId === "string" ? msgId : "";
      const delta =
        typeof value === "string" ? value : value == null ? "" : String(value);
      if (!id || !delta) return;

      const current = streamDeltaBufferRef.current[id];
      streamDeltaBufferRef.current[id] = {
        delta: `${current?.delta || ""}${delta}`,
        chunks: (current?.chunks || 0) + 1,
      };
      if (streamDeltaRafRef.current === null) {
        streamDeltaRafRef.current = requestAnimationFrame(() => {
          streamDeltaRafRef.current = null;
          flushStreamDeltaBuffer();
        });
      }
    },
    [flushStreamDeltaBuffer],
  );

  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    const updateMetrics = () => {
      stickToBottomRef.current =
        container.scrollHeight - container.scrollTop - container.clientHeight < 160;
    };

    updateMetrics();
    const observer = new ResizeObserver(updateMetrics);
    observer.observe(container);
    return () => {
      observer.disconnect();
    };
  }, [selectedId]);

  // Scroll to a pending message after channel switch + messages load
  useEffect(() => {
    const msgId = pendingScrollMsgIdRef.current;
    if (!msgId || loading || messages.length === 0) return;
    pendingScrollMsgIdRef.current = null;
    setTimeout(() => {
      const el = document.getElementById(`msg-${msgId}`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
      const idx = messages.findIndex((m) => m.msg_id === msgId);
      const container = messagesContainerRef.current;
      if (idx >= 0 && container) {
        container.scrollTop = Math.max(0, idx * VIRTUAL_MESSAGE_ESTIMATED_HEIGHT - container.clientHeight / 2);
      }
    }, 100);
  }, [messages, loading]);

  useEffect(() => {
    if (!selectedId) return;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let retryCount = 0;
    let disposed = false;
    const MAX_RETRIES = 10;
    const BASE_DELAY = 1000;
    const MAX_DELAY = 30000;

    function connect() {
      if (disposed) return;
      ws = new WebSocket(buildWsUrl(`/ws/channels/${selectedId}`));

      ws.onopen = () => {
        retryCount = 0;
      };

      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === "bot_processing" && msg.data) {
            const { bot_id, username } = msg.data;
            if (bot_id) {
              setProcessingBots((prev) => ({
                ...prev,
                [bot_id]: username || bot_id,
              }));
            }
          } else if (msg.type === "message" && msg.data) {
            // Bot placeholder arrived → clear the per-bot thinking indicator.
            if (msg.data.sender_type === "bot" && msg.data.sender_id) {
              setProcessingBots((prev) => {
                if (!(msg.data.sender_id in prev)) return prev;
                const next = { ...prev };
                delete next[msg.data.sender_id];
                return next;
              });
            }
            setMessageStore((prev) => {
              const incoming = msg.data as Message;
              const id = incoming.msg_id;
              if (id && prev.byId[id]) {
                // Already present — merge post-hoc updates (e.g. permission
                // card resolution flipping content_data.resolved). Keep any
                // client-local transient fields like _streaming.
                return patchMessage(prev, id, (m) => ({
                  ...m,
                  content: incoming.content ?? m.content,
                  content_data: incoming.content_data ?? m.content_data,
                  msg_type: incoming.msg_type ?? m.msg_type,
                }));
              }
              const entry =
                incoming.sender_type === "bot"
                  ? {
                      ...incoming,
                      _streaming: true,
                      _bot_trace: [
                        makeClientStreamTrace(
                          incoming,
                          "placeholder",
                          "创建 Bot 回复占位",
                          { event_type: "message" },
                        ),
                      ],
                    }
                  : incoming;
              return upsertMessage(prev, entry, MAX_LOADED_MESSAGES);
            });
            if (
              msg.data.sender_type === "bot" &&
              typeof msg.data.content === "string" &&
              msg.data.content.includes("已更新记忆层")
            ) {
              authFetch(`${API}/channels/${selectedId}/context`)
                .then((r) => r.json())
                .then((d) => d.data && setContextData(d.data))
                .catch(() => {});
            }
          } else if (msg.type === "message_stream" && msg.data) {
            const { msg_id, delta } = msg.data;
            queueStreamDelta(msg_id, delta);
          } else if (msg.type === "bot_trace" && msg.data) {
            const trace = msg.data as BotTraceEvent;
            if (!trace.msg_id) return;
            const status = botTraceStatusText(trace);
            setMessageStore((prev) =>
              patchMessage(prev, trace.msg_id!, (m) => ({
                ...m,
                _bot_status: status,
                _bot_trace: trimBotTraceEvents([
                  ...(m._bot_trace || []),
                  { ...trace, ts: trace.ts ?? Date.now() },
                ]),
              })),
            );
          } else if (msg.type === "message_done" && msg.data) {
            const { msg_id, content, files, file_ids, is_partial, error } = msg.data;
            flushStreamDeltaBuffer();
            const hasContentData = Object.prototype.hasOwnProperty.call(
              msg.data,
              "content_data",
            );
            const nextContentData = hasContentData
              ? msg.data.content_data
              : undefined;
            setMessageStore((prev) =>
              patchMessage(prev, msg_id, (m) => {
                const priorTask =
                  m.content_data?.kind === AGENT_BRIDGE_TASK_KIND
                    ? (m.content_data as AgentBridgeTaskContentData)
                    : m._agent_bridge_task;
                const nextTask =
                  nextContentData?.kind === AGENT_BRIDGE_TASK_KIND
                    ? (nextContentData as AgentBridgeTaskContentData)
                    : priorTask
                      ? {
                          ...priorTask,
                          status: error
                            ? "error"
                            : is_partial
                              ? "partial"
                              : "done",
                          message: error
                            ? String(error)
                            : is_partial
                              ? "任务已中断，已保留当前输出。"
                              : "任务已完成。",
                        }
                      : m._agent_bridge_task;
                return {
                  ...m,
                  content,
                  content_data:
                    nextContentData !== undefined
                      ? nextContentData
                      : m.content_data?.kind === AGENT_BRIDGE_TASK_KIND
                        ? null
                        : m.content_data,
                  _agent_bridge_task: nextTask,
                  _streaming: false,
                  _bot_trace: trimBotTraceEvents([
                    ...(m._bot_trace || []),
                    makeClientStreamTrace(
                      m,
                      error
                        ? "message_done_error"
                        : is_partial
                          ? "message_done_partial"
                          : "message_done",
                      error
                        ? "流式回复出错"
                        : is_partial
                          ? "流式回复中断"
                          : "流式回复完成",
                      {
                        event_type: "message_done",
                        content_chars: String(content || "").length,
                        is_partial: Boolean(is_partial),
                        error: error || null,
                        file_count: Array.isArray(files)
                          ? files.length
                          : Array.isArray(file_ids)
                            ? file_ids.length
                            : 0,
                      },
                      error
                        ? String(error)
                        : `${String(content || "").length} chars`,
                    ),
                  ]),
                  _bot_status: undefined,
                  ...(files ? { files } : {}),
                  ...(file_ids ? { file_ids } : {}),
                  ...(typeof is_partial === "boolean"
                    ? { is_partial }
                    : {}),
                };
              }),
            );
            if (
              typeof content === "string" &&
              content.includes("已更新记忆层")
            ) {
              authFetch(`${API}/channels/${selectedId}/context`)
                .then((r) => r.json())
                .then((d) => d.data && setContextData(d.data))
                .catch(() => {});
            }
          }
        } catch {}
      };

      ws.onerror = () => {
        reportClientError(
          "WS",
          `/ws/channels/${selectedId}`,
          0,
          "websocket error",
        );
      };

      ws.onclose = () => {
        if (disposed) return;
        if (retryCount < MAX_RETRIES) {
          const delay = Math.min(
            BASE_DELAY * Math.pow(2, retryCount),
            MAX_DELAY,
          );
          retryCount++;
          reconnectTimer = setTimeout(connect, delay);
        }
      };
    }

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (streamDeltaRafRef.current !== null) {
        cancelAnimationFrame(streamDeltaRafRef.current);
        streamDeltaRafRef.current = null;
      }
      streamDeltaBufferRef.current = {};
      if (ws) ws.close();
    };
  }, [selectedId, reportClientError, flushStreamDeltaBuffer, queueStreamDelta]);

  // User-scoped WebSocket: receives lightweight notifications for channels
  // the user isn't currently viewing. Used to live-increment rail unread
  // counts without opening a per-channel socket for every membership.
  useEffect(() => {
    if (!currentUserId) return;
    let ws: WebSocket | null = null;
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let retryCount = 0;
    const MAX_RETRIES = 10;
    const BASE_DELAY = 1000;
    const MAX_DELAY = 30000;

    const connect = () => {
      if (disposed) return;
      ws = new WebSocket(buildWsUrl(`/ws/users/${currentUserId}`));
      ws.onopen = () => {
        retryCount = 0;
      };
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === "channel_new_message" && msg.data) {
            const chId = msg.data.channel_id as string | undefined;
            if (!chId) return;
            // Ignore the channel the user is actively viewing — they'll get the
            // message on the channel WS and we'll mark-read on scroll/select.
            if (chId === selectedId) return;
            setChannels((prev) =>
              prev.map((c) =>
                c.channel_id === chId
                  ? { ...c, unread_count: (c.unread_count ?? 0) + 1 }
                  : c,
              ),
            );
            setDMs((prev) =>
              prev.map((d) =>
                d.channel_id === chId
                  ? { ...d, unread_count: (d.unread_count ?? 0) + 1 }
                  : d,
              ),
            );
          } else if (
            msg.type === "friend_request_created" ||
            msg.type === "friendship_changed"
          ) {
            refreshDMs(setDMs, authToken ?? undefined);
            refreshChannels(setChannels, authToken ?? undefined);
            if (msg.type === "friend_request_created") {
              toast.success("收到新的好友申请");
            } else if (msg.type === "friendship_changed") {
              toast.success("好友状态已更新");
            }
          }
        } catch {
          /* ignore malformed payloads */
        }
      };
      ws.onclose = () => {
        if (disposed) return;
        if (retryCount >= MAX_RETRIES) return;
        const delay = Math.min(BASE_DELAY * 2 ** retryCount, MAX_DELAY);
        retryCount += 1;
        reconnectTimer = setTimeout(connect, delay);
      };
      ws.onerror = () => {
        // onclose will run after onerror, which handles the retry.
      };
    };
    connect();

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) ws.close();
    };
  }, [authToken, currentUserId, selectedId]);

  useEffect(() => {
    if (memoryPanelOpen && selectedId) {
      authFetch(`${API}/channels/${selectedId}/context`)
        .then((r) => r.json())
        .then((d) => d.data && setContextData(d.data))
        .catch(console.error);
    }
  }, [authFetch, memoryPanelOpen, selectedId]);

  useEffect(() => {
    if (addBotOpen) {
      const headers: Record<string, string> = authToken
        ? { Authorization: `Bearer ${authToken}` }
        : {};
      fetch(`${API}/bots`, { headers })
        .then((r) => r.json())
        .then((d) => setAllBots(d.data || []))
        .catch(() => setAllBots([]));
      setSelectedBotIds(new Set());
    }
  }, [addBotOpen, authToken]);

  const addBotToChannel = (botId: string): Promise<void> => {
    if (!selectedId) return Promise.resolve();
    return authFetch(`${API}/channels/${selectedId}/members`, {
      method: "POST",
      body: JSON.stringify({ member_id: botId, member_type: "bot" }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.status === "success") {
          authFetch(`${API}/channels/${selectedId}/members?with_username=1`)
            .then((res) => res.json())
            .then((res) => {
              if (res.data) {
                const bots: ChannelBot[] = res.data
                  .filter(
                    (m: { member_type: string; username?: string }) =>
                      m.member_type === "bot" && m.username,
                  )
                  .map(
                    (m: {
                      member_id: string;
                      username: string;
                      avatar_url?: string;
                      display_name?: string;
                      scope?: BotItem["scope"];
                      owner?: BotItem["owner"];
                    }) => ({
                      member_id: m.member_id,
                      username: m.username,
                      avatar_url: m.avatar_url,
                      display_name: m.display_name,
                      scope: m.scope,
                      owner: m.owner,
                    }),
                  );
                setChannelBots(bots);
                const users: ChannelUser[] = res.data
                  .filter(
                    (m: { member_type: string; username?: string }) =>
                      m.member_type === "user" && m.username,
                  )
                  .map(
                    (m: {
                      member_id: string;
                      username: string;
                      avatar_url?: string;
                      display_name?: string;
                    }) => ({
                      member_id: m.member_id,
                      username: m.username,
                      avatar_url: m.avatar_url,
                      display_name: m.display_name,
                    }),
                  );
                setChannelUsers(users);
              }
            });
        }
      })
      .catch(console.error);
  };

  const removeBotFromChannel = (memberId: string) => {
    if (!selectedId) return;
    authFetch(
      `${API}/channels/${selectedId}/members/${encodeURIComponent(memberId)}`,
      { method: "DELETE" },
    )
      .then((r) => r.json())
      .then((d) => {
        if (d.status === "success") {
          setChannelBots((prev) =>
            prev.filter((b) => b.member_id !== memberId),
          );
        }
      })
      .catch(console.error);
  };

  useEffect(() => {
    if (!pendingClarifyReplyMsgId) return;
    // 在澄清表单消息之后找到用户的答复，再之后有 Bot 回复则视为已完成
    const clarifyIdx = messages.findIndex(
      (m) => m.msg_id === pendingClarifyReplyMsgId,
    );
    if (clarifyIdx === -1) return;
    const afterClarify = messages.slice(clarifyIdx + 1);
    const userReplyIdx = afterClarify.findIndex(
      (m) => m.sender_type === "user",
    );
    if (userReplyIdx === -1) return;
    const afterUserReply = afterClarify.slice(userReplyIdx + 1);
    if (afterUserReply.some((m) => m.sender_type === "bot")) {
      setPendingClarifyReplyMsgId(null);
    }
  }, [pendingClarifyReplyMsgId, messages]);

  useEffect(() => {
    setPendingClarifyReplyMsgId(null);
  }, [selectedId]);

  const sendUserMessage = (
    content: string,
    inReplyToMsgId?: string,
  ): Promise<void> => {
    if (!selectedId || !content.trim()) return Promise.resolve();
    if (!currentUserId) {
      setLoginModalOpen(true);
      toast.error("请先登录后再发送消息");
      return Promise.resolve();
    }
    if (isSystemDm) {
      toast.error("好友通知会话不能直接发送消息");
      return Promise.resolve();
    }
    const targetChannelId = selectedId;
    const body: Record<string, unknown> = {
      content: content.trim(),
      sender_id: currentUserId,
      sender_type: "user",
      file_ids: [] as string[],
      mention_bot_ids: botMentionIdsForChannel(targetChannelId),
      msg_type: isDmSelected ? "normal" : inReplyToMsgId ? "reply" : "normal",
    };
    if (inReplyToMsgId && !isDmSelected) body.in_reply_to_msg_id = inReplyToMsgId;
    return authFetch(`${API}/channels/${targetChannelId}/messages`, {
      method: "POST",
      body: JSON.stringify(body),
    })
      .then((r) => r.json())
      .then((d) => {
        // 用户消息由 WebSocket 广播接收，这里仅作兜底去重插入
        if (d.data && selectedIdRef.current === targetChannelId) {
          setMessageStore((prev) =>
            prev.byId[d.data.msg_id]
              ? prev
              : upsertMessage(prev, d.data, MAX_LOADED_MESSAGES),
          );
        }
      });
  };

  const send = (draftValue?: string) => {
    const rawContent =
      draftValue ?? inputDraftRef.current ?? inputRef.current?.value ?? input;
    if (!selectedId || (!rawContent.trim() && pendingFileIds.length === 0)) return;
    if (!currentUserId) {
      setLoginModalOpen(true);
      toast.error("请先登录后再发送消息");
      return;
    }
    if (isSystemDm) {
      toast.error("好友通知会话不能直接发送消息");
      return;
    }
    const targetChannelId = selectedId;
    const content = rawContent.trim();
    // Reply context is conveyed by `in_reply_to_msg_id` (rendered as a chip).
    // We intentionally do NOT prepend a markdown blockquote of the parent
    // message: that would duplicate what the chip already shows AND pollute
    // bot adapters' user-message text.
    const isSecretSend = secretMode;
    // Resolve msg_type: a pending reply-to always wins; otherwise use the
    // user's current msgKind pick from the composer switcher.
    const effectiveKind: typeof msgKind | "reply" = isDmSelected
      ? "normal"
      : replyingTo
        ? "reply"
        : msgKind;
    const body: Record<string, unknown> = {
      content,
      sender_id: currentUserId,
      sender_type: "user",
      file_ids: pendingFileIds,
      mention_bot_ids: botMentionIdsForChannel(targetChannelId),
      is_secret: isSecretSend,
      msg_type: effectiveKind,
    };
    if (replyingTo && !isDmSelected) body.in_reply_to_msg_id = replyingTo.msg_id;
    const titleTrim = composerTitle.trim() || null;
    if (effectiveKind === "announcement") {
      body.content_data = {
        pinned_by: currentUserId,
        ...(titleTrim ? { title: titleTrim } : {}),
      };
    } else if (effectiveKind === "topic") {
      body.content_data = titleTrim ? { title: titleTrim } : {};
    }
    resetComposerAfterSend();
    clearPendingFiles();
    authFetch(`${API}/channels/${targetChannelId}/messages`, {
      method: "POST",
      body: JSON.stringify(body),
    })
      .then((r) => r.json())
      .then((d) => {
        // 用户消息由 WebSocket 广播接收，这里仅作兜底去重插入
        // 仅在用户仍停留在发送消息的频道时才插入，避免跨频道串消息
        if (d.data && selectedIdRef.current === targetChannelId) {
          setMessageStore((prev) =>
            prev.byId[d.data.msg_id]
              ? prev
              : upsertMessage(prev, d.data, MAX_LOADED_MESSAGES),
          );
          // 保存 secret_token（仅发送方当次 session 持有，不通过 WS 广播）
          if (d.data.secret_token) {
            setSecretTokens((prev) => ({
              ...prev,
              [d.data.msg_id]: d.data.secret_token,
            }));
          }
        }
      })
      .catch(console.error);
  };

  const refreshDmSession = useCallback(async () => {
    const botId = activeBotDm?.counterparty.member_id;
    if (!selectedId || !botId) return;
    setRefreshingDmSession(true);
    try {
      const res = await apiFetch("/agent-bridge/sessions/dm/refresh", {
        method: "POST",
        token: authToken,
        body: {
          channel_id: selectedId,
          bot_id: botId,
        },
      });
      const data = await res.json();
      if (!res.ok || data?.status === "error") {
        toast.error(data?.detail || data?.message || "刷新 DM Session 失败");
        return;
      }
      setDmSessionRefreshNonce((v) => v + 1);
      toast.success("DM Session 已刷新");
    } catch {
      toast.error("刷新 DM Session 失败");
    } finally {
      setRefreshingDmSession(false);
    }
  }, [activeBotDm?.counterparty.member_id, authToken, selectedId]);

  // Reveal an encrypted message by hitting /messages/:id/secret with the
  // per-send token (only the sender holds one, captured in secretTokens).
  // On success, stashes plaintext into revealedSecrets so the stream
  // renders it in place of the 🔒 veil.
  const revealSecretMessage = (msgId: string) => {
    const token = secretTokens[msgId];
    if (!selectedId || !token) return;
    fetch(
      `${API}/channels/${selectedId}/messages/${msgId}/secret?token=${encodeURIComponent(token)}`,
      { headers: { Authorization: `Bearer ${authToken}` } },
    )
      .then((r) => r.json())
      .then((d) => {
        if (d.data?.content) {
          setRevealedSecrets((prev) => ({
            ...prev,
            [msgId]: d.data.content,
          }));
        } else {
          toast.error(d.detail || "无法查看加密内容");
        }
      })
      .catch(() => toast.error("请求失败"));
  };

  // Copy a message's rendered text (stripping think-folds / helper payload
  // JSON) to the system clipboard. Best-effort — silently toasts failure.
  const copyMessageText = async (m: Message) => {
    const raw = parseHelperPayload(m.content || "").text || m.content || "";
    try {
      await navigator.clipboard.writeText(raw);
      toast.success("已复制");
    } catch {
      toast.error("复制失败");
    }
  };

  const getMemoryLoadDetail = (m: Message): MemoryLoadDetail | null => {
    const value = m.content_data?.memory_load;
    if (!value || typeof value !== "object") return null;
    const detail = value as MemoryLoadDetail;
    return detail.kind === "bot_memory_load" ? detail : null;
  };

  const renderMemoryLoadButton = (m: Message) => {
    if (!hasBotReplyDetails(m)) return null;
    return (
      <button
        type="button"
        onClick={() => setMemoryDetailMessage(m)}
        title="查看这条 AI 回复的记忆与流式事件"
        className="an-chat-action"
      >
        <AppIcon name="help" className="h-3.5 w-3.5" />
      </button>
    );
  };

  const hasBotReplyDetails = (m: Message): boolean =>
    m.sender_type === "bot" &&
    Boolean(getMemoryLoadDetail(m) || m._bot_trace?.length);

  const cancelStreamingMessage = async (m: Message) => {
    if (!selectedId) return;
    // Optimistic: stop the streaming pulse immediately so the user sees feedback;
    // the message_done event will arrive shortly with is_partial=true and the
    // final buffered content. If the request fails we restore _streaming.
    setMessageStore((prev) =>
      patchMessage(prev, m.msg_id, (x) => ({ ...x, _streaming: false })),
    );
    try {
      const r = await apiFetch(
        `/channels/${selectedId}/messages/${m.msg_id}/cancel`,
        { method: "POST", token: authToken },
      );
      if (!r.ok) {
        setMessageStore((prev) =>
          patchMessage(prev, m.msg_id, (x) => ({ ...x, _streaming: true })),
        );
        toast.error("取消失败");
      }
    } catch {
      setMessageStore((prev) =>
        patchMessage(prev, m.msg_id, (x) => ({ ...x, _streaming: true })),
      );
      toast.error("取消失败");
    }
  };

  /** Inline ⏹ stop button shown next to the streaming pulse on bot bubbles.
   *  Returns null for non-streaming or non-bot messages so callers can drop
   *  it next to every pulse location without an extra wrapping condition. */
  const renderStopStreamButton = (m: Message) => {
    if (!m._streaming || m.sender_type !== "bot") return null;
    return (
      <button
        type="button"
        title="停止生成"
        onClick={() => cancelStreamingMessage(m)}
        className="inline-flex items-center justify-center align-middle ml-1.5 w-5 h-5 rounded border"
        style={{
          borderColor: "var(--border)",
          background: "var(--surface-soft)",
          color: "var(--fg-2)",
          cursor: "pointer",
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            background: "currentColor",
            borderRadius: 1,
          }}
        />
      </button>
    );
  };

  /** Inline "已取消" badge shown after a streaming bot reply was cancelled. */
  const renderPartialBadge = (m: Message) => {
    if (m._streaming || !m.is_partial || m.sender_type !== "bot") return null;
    return (
      <span
        className="inline-block align-middle ml-1.5 px-1.5 py-0.5 rounded text-[10px]"
        style={{
          background: "var(--surface-soft)",
          border: "1px solid var(--border)",
          color: "var(--fg-3)",
        }}
      >
        已取消
      </span>
    );
  };

  const renderBotTraceStatus = (m: Message) => {
    if (!m._streaming || m.sender_type !== "bot" || !m._bot_status) return null;
    return (
      <div
        className="mt-1 flex items-center gap-1.5 text-[11px] leading-snug"
        style={{ color: "var(--fg-3)" }}
      >
        <span
          className="inline-block w-1.5 h-1.5 rounded-full animate-pulse"
          style={{ background: "var(--fg-3)" }}
        />
        <span className="truncate max-w-[min(520px,70vw)]">
          {m._bot_status}
        </span>
      </div>
    );
  };

  const activeAgentBridgeTaskData = (m: Message): AgentBridgeTaskContentData | null => {
    return getActiveAgentBridgeTaskData(m, isDmSelected);
  };

  const agentBridgeTaskData = (m: Message): AgentBridgeTaskContentData | null => {
    return getAgentBridgeTaskData(m, isDmSelected);
  };

  const agentBridgeTaskMessages = useMemo(
    () => {
      if (isDmSelected) return [];
      return (
      messages
        .map((m) => {
          const task = agentBridgeTaskData(m);
          return task ? ({ ...m, content_data: task } as AgentBridgeTaskMessage) : null;
        })
        .filter((m): m is AgentBridgeTaskMessage => m !== null)
      );
    },
    [isDmSelected, messages],
  );

  const jumpToMessage = useCallback((id: string) => {
    const highlight = (el: HTMLElement) => {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      const orig = el.style.transition;
      el.style.transition = "background 200ms";
      const prev = el.style.background;
      el.style.background = "var(--accent-muted)";
      setTimeout(() => {
        el.style.background = prev;
        el.style.transition = orig;
      }, 1200);
    };
    const el = document.getElementById(`msg-${id}`);
    if (el) {
      highlight(el);
      return;
    }
    const idx = messages.findIndex((m) => m.msg_id === id);
    const container = messagesContainerRef.current;
    if (idx < 0 || !container) return;
    container.scrollTop = Math.max(
      0,
      idx * VIRTUAL_MESSAGE_ESTIMATED_HEIGHT - container.clientHeight / 2,
    );
    requestAnimationFrame(() => {
      const next = document.getElementById(`msg-${id}`);
      if (next) highlight(next);
    });
  }, [messages]);

  const renderAgentBridgeTaskCard = (m: Message) => {
    const task = activeAgentBridgeTaskData(m);
    if (!task) return null;
    return (
      <AgentBridgeTaskCard
        message={m}
        task={task}
        onOpen={(messageId) => {
          setPageTopicId(null);
          setPageTaskMsgId(messageId);
          setTaskPageOpen(true);
        }}
      />
    );
  };

  const sendTopicReply = async (
    channelId: string,
    rootMsgId: string,
    text: string,
  ) => {
    const attachedFileIds = [...pendingFileIds];
    if (!text.trim() && attachedFileIds.length === 0) return;
    if (!currentUserId) {
      setLoginModalOpen(true);
      toast.error("请先登录后再发送回复");
      return;
    }
    const body: Record<string, unknown> = {
      content: text.trim(),
      sender_id: currentUserId,
      sender_type: "user",
      file_ids: attachedFileIds,
      mention_bot_ids: botMentionIdsForChannel(channelId),
      is_secret: false,
      msg_type: "reply",
      in_reply_to_msg_id: rootMsgId,
    };
    const r = await authFetch(`${API}/channels/${channelId}/messages`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    const d = await r.json().catch(() => null);
    if (d?.data && selectedIdRef.current === channelId) {
      setMessageStore((prev) =>
        prev.byId[d.data.msg_id]
          ? prev
          : upsertMessage(prev, d.data, MAX_LOADED_MESSAGES),
      );
    }
    clearPendingFiles();
  };

  const handleClarifyContinue = (
    msgId: string,
    schema: ClarifySchema,
    answers: ClarifyAnswers,
  ) => {
    const lines = ["@Coordinator 澄清回答："];
    const optText = answers.option_text || {};
    for (const q of schema.questions) {
      const picked = new Set(answers.selected[q.id] || []);
      const labels = q.options
        .filter((o) => picked.has(o.id))
        .map((o) => {
          const txt = (optText[`${q.id}:${o.id}`] || "").trim();
          return txt ? `${o.label}：${txt}` : o.label;
        });
      if (picked.has(OTHER_CHOICE_ID)) {
        const other = (answers.other_text?.[q.id] || "").trim();
        if (other) labels.push(`其他：${other}`);
      }
      lines.push(
        `- ${q.prompt}：${labels.length > 0 ? labels.join("、") : "未选择"}`,
      );
    }
    setPendingClarifyReplyMsgId(msgId);
    sendUserMessage(lines.join("\n"), msgId).catch(() => {
      setPendingClarifyReplyMsgId(null);
      toast.error("提交失败，请重试");
    });
  };

  const handleClarifySkip = (msgId: string) => {
    setPendingClarifyReplyMsgId(msgId);
    sendUserMessage(
      "@Coordinator 用户选择跳过澄清，请在当前信息下继续回答。",
      msgId,
    ).catch(() => {
      setPendingClarifyReplyMsgId(null);
      toast.error("提交失败，请重试");
    });
  };

  const filePreviewUrl = (fileId: string) => `${API}/files/${fileId}/preview`;
  const fileDownloadUrl = (fileId: string) => `${API}/files/${fileId}/download`;

  const openFilePreview = (file: FileInfo) => {
    setFilePreviewPanel({
      url: filePreviewUrl(file.file_id),
      filename: file.original_filename || file.file_id,
      contentType: file.content_type,
      sizeBytes: file.size_bytes,
    });
  };

  const openFilePreviewUrl = (
    url: string,
    filename: string,
    contentType?: string | null,
    sizeBytes?: number | null,
  ) => {
    setFilePreviewPanel({ url, filename, contentType, sizeBytes });
  };

  const handleMarkdownImageClick = (src: string) => {
    const match = src.match(/\/files\/([^/?]+)\/preview/);
    if (match) {
      const fileId = decodeURIComponent(match[1]);
      openFilePreviewUrl(src, `file-${fileId.slice(0, 8)}`, "image/*");
      return;
    }
    setLightboxSrc(src);
    setLightboxFileId(null);
  };

  const handleMarkdownFileClick = (url: string, name: string) => {
    openFilePreviewUrl(url, name);
  };

  const renderFileAttachments = (msg: Message, alignRight = false) => {
    return (
      <ChatAttachments
        align={alignRight ? "right" : "left"}
        files={msg.files}
        getPreviewUrl={(file) => filePreviewUrl(file.file_id)}
        getDownloadUrl={(file) => fileDownloadUrl(file.file_id)}
        onPreview={openFilePreview}
      />
    );
  };

  const selectedChannel: Channel | null = (() => {
    const hit = channels.find((c) => c.channel_id === selectedId);
    if (hit) return hit;
    // DMs aren't in the channels[] list — synthesize a minimal Channel so
    // downstream references to selectedChannel.name / .workspace_id work.
    const dm = selectedId
      ? dms.find((d) => d.channel_id === selectedId)
      : undefined;
    if (!dm) return null;
    const label =
      dm.counterparty.display_name ||
      dm.counterparty.username ||
      "DM";
    return {
      channel_id: dm.channel_id,
      workspace_id: dm.workspace_id,
      name: label,
      type: "dm",
      auto_assist: false,
      unread_count: dm.unread_count ?? 0,
    };
  })();

  // 进入频道或收到新消息时，聊天区域滚动到最新消息（加载旧消息时跳过）
  useEffect(() => {
    if (!messagesContainerRef.current || isLoadingOlderRef.current) return;
    const container = messagesContainerRef.current;
    const channelChanged = lastAutoScrollChannelRef.current !== selectedId;
    lastAutoScrollChannelRef.current = selectedId ?? null;
    if (!channelChanged && !stickToBottomRef.current) return;
    requestAnimationFrame(() => {
      container.scrollTop = container.scrollHeight;
      stickToBottomRef.current = true;
    });
  }, [selectedId, messages.length]);

  // 打开频道时把未读标记为已读：先在本地把徽标清零（立即反馈），再向后端
  // 同步阅读游标。失败不回滚徽标——下次加载频道列表时会重新计算。
  useEffect(() => {
    if (!selectedId || !authToken) return;
    setChannels((prev) =>
      prev.some(
        (c) => c.channel_id === selectedId && (c.unread_count ?? 0) > 0,
      )
        ? prev.map((c) =>
            c.channel_id === selectedId ? { ...c, unread_count: 0 } : c,
          )
        : prev,
    );
    setDMs((prev) =>
      prev.some(
        (d) => d.channel_id === selectedId && (d.unread_count ?? 0) > 0,
      )
        ? prev.map((d) =>
            d.channel_id === selectedId ? { ...d, unread_count: 0 } : d,
          )
        : prev,
    );
    apiFetch(`/channels/${selectedId}/read`, {
      method: "POST",
      token: authToken,
    }).catch(() => {
      /* ignore — rail badge stays cleared locally; next list refresh re-syncs */
    });
  }, [selectedId, authToken]);

  // Auto-expand topics that contain streaming (incoming) messages
  useEffect(() => {
    const msgIdSet = new Set(messages.map((x) => x.msg_id));
    const rootIdCache = new Map<string, string>();
    function getRootId(msgId: string): string {
      if (rootIdCache.has(msgId)) return rootIdCache.get(msgId)!;
      const m = messages.find((x) => x.msg_id === msgId);
      if (!m || !isMsgReply(m, msgIdSet) || !m.in_reply_to_msg_id) {
        rootIdCache.set(msgId, msgId);
        return msgId;
      }
      const rid = getRootId(m.in_reply_to_msg_id);
      rootIdCache.set(msgId, rid);
      return rid;
    }
    const toExpand = messages
      .filter((m) => isMsgReply(m, msgIdSet) && m._streaming)
      .map((m) => getRootId(m.msg_id));
    if (toExpand.length > 0)
      setExpandedTopics((prev) => new Set([...prev, ...toExpand]));
  }, [messages]);

  // Build topic tree: follow parent chain to find root, group all descendants under it.
  const { topicRoots, topicRepliesOf } = useMemo(
    () => buildTopicTree(messages, isDmSelected),
    [isDmSelected, messages],
  );
  const botById = useMemo(
    () => new Map(channelBots.map((bot) => [bot.member_id, bot])),
    [channelBots],
  );
  const botByUsername = useMemo(
    () => new Map(channelBots.map((bot) => [bot.username, bot])),
    [channelBots],
  );
  const coordinatorBot = useMemo(
    () =>
      channelBots.find(
        (bot) =>
          bot.username === "Coordinator" ||
          bot.username === "Helper" ||
          bot.username === "channel bot" ||
          bot.username === "coordinator",
      ),
    [channelBots],
  );
  const userById = useMemo(
    () => new Map(channelUsers.map((user) => [user.member_id, user])),
    [channelUsers],
  );
  const msgById = useMemo(
    () => new Map(messages.map((message) => [message.msg_id, message])),
    [messages],
  );
  const clarifyAnsweredParentIds = useMemo(() => {
    const ids = new Set<string>();
    for (const message of messages) {
      if (
        message.in_reply_to_msg_id &&
        isClarifyReplyUserMessage(message.content)
      ) {
        ids.add(message.in_reply_to_msg_id);
      }
    }
    return ids;
  }, [messages]);
  const rowVirtualizer = useVirtualizer({
    count: topicRoots.length,
    getScrollElement: () => messagesContainerRef.current,
    estimateSize: () => VIRTUAL_MESSAGE_ESTIMATED_HEIGHT,
    overscan: 12,
    getItemKey: (index) => topicRoots[index]?.msg_id ?? index,
  });
  const virtualItems = rowVirtualizer.getVirtualItems();
  const pageTopicSourceMessages = useMemo(
    () => mergeMessagesChronologically(messages, pageTopicMessages),
    [messages, pageTopicMessages],
  );
  const { topicRepliesOf: pageTopicRepliesOf } = useMemo(
    () => buildTopicTree(pageTopicSourceMessages, false),
    [pageTopicSourceMessages],
  );
  const selectedDetailMessage = memoryDetailMessage
    ? msgById.get(memoryDetailMessage.msg_id) || memoryDetailMessage
    : null;
  const selectedMemoryLoadDetail = selectedDetailMessage
    ? getMemoryLoadDetail(selectedDetailMessage)
    : null;
  const selectedBotTraceEvents = selectedDetailMessage?._bot_trace || [];

  return (
    <>
      <LoginModal
        open={loginModalOpen}
        currentUser={currentUser}
        onClose={() => setLoginModalOpen(false)}
        onSuccess={(user, token) => {
          setAuth(user, token);
          setLoginModalOpen(false);
        }}
      />

      <MessageDetailModal
        message={selectedDetailMessage}
        memoryLoadDetail={selectedMemoryLoadDetail}
        botTraceEvents={selectedBotTraceEvents}
        onClose={() => setMemoryDetailMessage(null)}
      />

      <ChatShell
        isMobile={isMobile}
        sidebarOpen={sidebarOpen}
        onCloseSidebar={() => setSidebarOpen(false)}
        workspaces={workspaces}
        selectedWorkspaceId={selectedWorkspaceId}
        onSelectWorkspace={setSelectedWorkspaceId}
        onCreateWorkspace={() => setCreateWsOpen(true)}
        sidebar={
          <Sidebar
            isMobile={isMobile}
            sidebarOpen={sidebarOpen}
            leftWidth={leftWidth}
            onLeftResize={onLeftResize}
            currentUser={currentUser}
            authToken={authToken}
            onLoginClick={() => setLoginModalOpen(true)}
            workspaces={workspaces}
            setWorkspaces={setWorkspaces}
            selectedWorkspaceId={selectedWorkspaceId}
            setSelectedWorkspaceId={setSelectedWorkspaceId}
            isPersonalWorkspace={isPersonalWorkspace}
            channels={channels}
            setChannels={setChannels}
            dms={dms}
            setDMs={setDMs}
            selectedId={selectedId}
            setSelectedId={setSelectedId}
            setSidebarOpen={setSidebarOpen}
            onOpenCreateWorkspace={() => setCreateWsOpen(true)}
            onOpenInviteWsMember={() => setInviteWsMemberOpen(true)}
            onOpenCreateChannel={() => setCreateChannelOpen(true)}
            onOpenSettings={() => setSettingsOpen(true)}
            onOpenFilePreview={openFilePreview}
          />
        }
      >

        <HelpModal
          open={helpOpen}
          onClose={() => setHelpOpen(false)}
          apiDocsUrl={API_DOCS_URL}
        />

        {settingsOpen && (
          <Suspense fallback={null}>
            <SettingsModal
              open={settingsOpen}
              onClose={() => setSettingsOpen(false)}
              isDark={isDark}
              setTheme={setTheme}
              authToken={authToken}
              currentUser={currentUser}
              onProfileUpdated={(data) => {
                if (!currentUser) return;
                setCurrentUser({
                  ...currentUser,
                  display_name: data.display_name,
                  bio: data.bio ?? currentUser.bio,
                  avatar_url: data.avatar_url ?? null,
                });
              }}
              onOpenDM={openDirectMessage}
              onLogout={handleLogout}
            />
          </Suspense>
        )}

        <OpenClawQcModal
          open={qcOpen}
          onClose={() => setQcOpen(false)}
          channelId={selectedId}
          channelName={selectedChannel?.name}
        />

        <CreateWorkspaceModal
          open={createWsOpen}
          value={newWorkspaceName}
          onChange={setNewWorkspaceName}
          avatarUrl={newWorkspaceAvatarUrl}
          onAvatarUrlChange={setNewWorkspaceAvatarUrl}
          onSubmit={handleCreateWorkspace}
          onClose={() => setCreateWsOpen(false)}
        />

        <InviteWorkspaceMemberModal
          open={inviteWsMemberOpen}
          value={inviteWsIdentifier}
          authToken={authToken}
          workspaceId={selectedWorkspaceId}
          onChange={setInviteWsIdentifier}
          onSubmit={handleInviteWsMember}
          onPickUser={inviteWorkspaceMember}
          onClose={() => setInviteWsMemberOpen(false)}
        />

        <CreateChannelModal
          open={createChannelOpen}
          workspaces={workspaces}
          selectedWorkspaceId={selectedWorkspaceId}
          onSelectWorkspace={setSelectedWorkspaceId}
          channelName={newChannelName}
          onChannelNameChange={setNewChannelName}
          onSubmit={handleCreateChannel}
          onClose={() => setCreateChannelOpen(false)}
        />

        <AddBotModal
          open={addBotOpen}
          selectedChannelId={selectedId}
          channelBots={channelBots}
          allBots={allBots}
          selectedBotIds={selectedBotIds}
          addingBots={addingBots}
          onClose={() => setAddBotOpen(false)}
          onRemoveBot={removeBotFromChannel}
          onToggleBot={(botId) =>
            setSelectedBotIds((prev) => {
              const next = new Set(prev);
              if (next.has(botId)) next.delete(botId);
              else next.add(botId);
              return next;
            })
          }
          onAddSelected={async () => {
            setAddingBots(true);
            try {
              await Promise.all([...selectedBotIds].map((id) => addBotToChannel(id)));
              setSelectedBotIds(new Set());
            } finally {
              setAddingBots(false);
            }
          }}
        />

        {/* 通知面板 */}
        <NotificationPanel
          isOpen={notifPanelOpen}
          onClose={() => setNotifPanelOpen(false)}
          userToken={authToken ?? undefined}
          onNavigate={handleNotifNavigate}
        />

        {/* 频道设置 */}
        {selectedId && (
          <ChannelSettingsModal
            open={channelSettingsOpen}
            channel={selectedChannel}
            currentUserId={currentUserId}
            userToken={authToken}
            onClose={() => setChannelSettingsOpen(false)}
            onSaved={(updated) => {
              setChannels((prev) =>
                prev.map((c) =>
                  c.channel_id === updated.channel_id ? { ...c, ...updated } : c,
                ),
              );
              setAutoAssist(Boolean(updated.auto_assist));
            }}
          />
        )}

        <div className="flex-1 flex min-w-0">
          <ChannelMainFrame
            selectedId={selectedId}
            isDark={isDark}
            isDraggingOver={isDraggingOver}
            onDragEnter={(e) => {
              if (!selectedId || !e.dataTransfer.types.includes("Files"))
                return;
              e.preventDefault();
              dragCounterRef.current += 1;
              if (dragCounterRef.current === 1) setIsDraggingOver(true);
            }}
            onDragOver={(e) => {
              if (!selectedId) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "copy";
            }}
            onDragLeave={() => {
              dragCounterRef.current -= 1;
              if (dragCounterRef.current <= 0) {
                dragCounterRef.current = 0;
                setIsDraggingOver(false);
              }
            }}
            onDrop={async (e) => {
              e.preventDefault();
              dragCounterRef.current = 0;
              setIsDraggingOver(false);
              if (!selectedId) return;
              const files = Array.from(e.dataTransfer.files);
              for (const file of files) {
                await uploadFileObject(file);
              }
            }}
          >
            <ChatWorkspaceView
              selectedId={selectedId}
              selectedChannel={selectedChannel}
              activeDm={activeDm}
              activeBotDm={activeBotDm}
              activeDmSessionScopeId={activeDmSessionScopeId}
              dmSessionRefreshNonce={dmSessionRefreshNonce}
              isMobile={isMobile}
              isDmSelected={isDmSelected}
              autoAssist={autoAssist}
              memoryTab={memoryTab}
              topicRoots={topicRoots}
              topicRepliesOf={topicRepliesOf}
              taskPageOpen={taskPageOpen}
              agentBridgeTaskMessages={agentBridgeTaskMessages}
              refreshingDmSession={refreshingDmSession}
              taskOverlayProps={{
                open: taskPageOpen,
                isDmSelected,
                selectedId,
                tasks: agentBridgeTaskMessages,
                selectedMsgId: pageTaskMsgId,
                channel: selectedChannel,
                channelBots,
                onSelectTask: (msgId) => setPageTaskMsgId(msgId),
                onBack: () => {
                  setTaskPageOpen(false);
                  setPageTaskMsgId(null);
                },
                onJumpToMessage: (msgId) => {
                  setTaskPageOpen(false);
                  setPageTaskMsgId(null);
                  setTimeout(() => jumpToMessage(msgId), 0);
                },
              }}
              topicOverlayProps={{
                open: !taskPageOpen && !isDmSelected && Boolean(pageTopicId && selectedId),
                selectedId,
                pageTopicId,
                sourceMessages: pageTopicSourceMessages,
                repliesOf: pageTopicRepliesOf,
                channel: selectedChannel,
                channelBots,
                channelUsers,
                currentUserId,
                pageTopicError,
                pageTopicLoading,
                onBack: () => setPageTopicId(null),
                onSendReply: sendTopicReply,
                onCopyMessage: copyMessageText,
                onShowMessageDetails: setMemoryDetailMessage,
                hasMessageDetails: hasBotReplyDetails,
                onImageClick: handleMarkdownImageClick,
                onFileClick: handleMarkdownFileClick,
                renderAttachments: renderFileAttachments,
                pendingFiles,
                onRemovePendingFile: removePendingFile,
                onUploadFile: uploadFile,
                keychainEnabled: Boolean(currentUser),
                keychainOpen: keychainPopupOpen,
                keychainLoading: keychainPopupLoading,
                keychainItems: keychainPopupItems,
                onToggleKeychain: openKeychainPopup,
                onCloseKeychain: () => setKeychainPopupOpen(false),
              }}
              messageListProps={{
                messagesContainerRef,
                inputRef,
                secretInputRef,
                onMessagesScroll: handleMessagesScroll,
                loading,
                loadingMore,
                hasMore,
                messages,
                selectedChannel,
                selectedId,
                isDmSelected,
                currentUser,
                currentUserId,
                authToken,
                topicRoots,
                topicRepliesOf,
                virtualItems,
                rowVirtualizer,
                botById,
                botByUsername,
                coordinatorBot,
                userById,
                msgById,
                revealedSecrets,
                secretTokens,
                clarifyAnsweredParentIds,
                pendingClarifyReplyMsgId,
                expandedTopics,
                collapsedMessages,
                processingBots,
                secretMode,
                setMessageStore,
                setDMs,
                setComposerInput,
                setReplyingTo,
                setPageTopicId,
                revealSecretMessage,
                copyMessageText,
                renderMemoryLoadButton,
                renderStopStreamButton,
                renderPartialBadge,
                renderBotTraceStatus,
                renderAgentBridgeTaskCard,
                renderFileAttachments,
                activeAgentBridgeTaskData,
                handleMarkdownImageClick,
                handleMarkdownFileClick,
                handleClarifyContinue,
                handleClarifySkip,
                toggleTopic,
                toggleMessage,
              }}
              composerProps={{
                value: input,
                valueRevision: inputRevision,
                inputRef,
                onValueChange: handleComposerValueChange,
                onSend: send,
                canSend: pendingFileIds.length > 0,
                canSendPredicate: (value) =>
                  Boolean(value.trim() || pendingFileIds.length > 0),
                disabled: isSystemDm,
                placeholder: isSystemDm
                  ? "好友通知会话用于处理申请，不能直接发送消息…"
                  : secretMode
                    ? "输入加密内容（仅 Bot 可读取原文）…"
                    : isDmSelected
                      ? `发消息给 ${activeDm?.counterparty.display_name || activeDm?.counterparty.username || "DM"}…`
                      : msgKind === "announcement"
                        ? `发布公告到 #${selectedChannel?.name || "频道"}…`
                        : msgKind === "topic"
                          ? "开启主题 · 标题将取首行…"
                          : `发消息到 #${selectedChannel?.name || "频道"}，@ 呼叫 Bot…`,
                kind: msgKind,
                onKindChange: setMsgKind,
                onCycleKind: cycleMsgKind,
                showKindSwitcher: !replyingTo && !isDmSelected,
                enableKindCycling: !replyingTo && !isDmSelected,
                titleValue: composerTitle,
                titleRef: composerTitleRef,
                onTitleChange: setComposerTitle,
                channelBots,
                channelUsers,
                replyingTo,
                onCancelReply: () => setReplyingTo(null),
                pendingFiles,
                onRemovePendingFile: removePendingFile,
                onUploadFile: uploadFile,
                keychainEnabled: Boolean(currentUser),
                keychainOpen: keychainPopupOpen,
                keychainLoading: keychainPopupLoading,
                keychainItems: keychainPopupItems,
                onToggleKeychain: openKeychainPopup,
                onCloseKeychain: () => setKeychainPopupOpen(false),
              }}
              setMemoryTab={setMemoryTab}
              setPageTopicId={setPageTopicId}
              setPageTaskMsgId={setPageTaskMsgId}
              setTaskPageOpen={setTaskPageOpen}
              onOpenSidebar={() => setSidebarOpen(true)}
              onOpenChannelSettings={() => setChannelSettingsOpen(true)}
              onJumpToMessage={jumpToMessage}
              onRefreshDmSession={refreshDmSession}
            />
          </ChannelMainFrame>

          <ChatSidePanels
            memoryPanelOpen={memoryPanelOpen}
            selectedId={selectedId}
            isMobile={isMobile}
            memoryWidth={memoryWidth}
            onMemoryResize={onMemoryResize}
            channelName={selectedChannel?.name ?? ""}
            contextData={contextData}
            memoryTab={memoryTab}
            onMemoryTabChange={setMemoryTab}
            currentUserId={currentUserId}
            onFilePreview={openFilePreview}
            onCloseMemory={() => setMemoryTab(null)}
            filePreviewPanel={filePreviewPanel}
            filePreviewWidth={filePreviewWidth}
            onFilePreviewResize={onFilePreviewResize}
            onCloseFilePreview={() => setFilePreviewPanel(null)}
          />
        </div>
      </ChatShell>

      <ImageLightbox
        src={lightboxSrc}
        fileId={lightboxFileId}
        onClose={() => {
          setLightboxSrc(null);
          setLightboxFileId(null);
        }}
      />
    </>
  );
}
