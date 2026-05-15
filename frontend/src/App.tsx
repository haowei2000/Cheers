import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import toast from "react-hot-toast";
import NotificationPanel from "./NotificationPanel";
import { useTheme } from "./useTheme";
import { useAuth } from "./hooks/useAuth";
import { useResize } from "./hooks/useResize";
import { BotAvatar } from "./components/BotAvatar";
import { ClarifyInlineBlock } from "./components/ClarifyInlineBlock";
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
import {
  ChatAttachments,
  ChatMessageRenderer,
} from "./components/ChatMessageRenderer";
import { ChannelHeader, type MemoryTab } from "./components/ChannelHeader";
import {
  MessageComposer,
  MESSAGE_COMPOSER_KIND_ORDER,
} from "./components/MessageComposer";
import type { MessageComposerKind } from "./components/MessageComposer";
import { SessionScopePanel } from "./components/SessionScopePanel";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { AddBotModal } from "./components/app/AddBotModal";
import { ChannelMainFrame } from "./components/app/ChannelMainFrame";
import { ChatShell } from "./components/app/ChatShell";
import { ChatSidePanels } from "./components/app/ChatSidePanels";
import { LazyPanelFallback } from "./components/app/LazyPanelFallback";
import { MessageDetailModal } from "./components/app/MessageDetailModal";
import { AgentBridgeTaskCard } from "./features/chat/messages/AgentBridgeTaskCard";
import {
  getSecretSecondsLeft,
  SecretMessageVeil,
} from "./features/chat/messages/SecretMessageVeil";
import { apiFetch, buildWsUrl } from "./api";
import {
  parseHelperPayload,
  isClarifyReplyUserMessage,
} from "./lib/helper";
import {
  buildTopicTree,
  isMsgReply,
  mergeMessagesChronologically,
  parseQuotePrefix,
  stripLeadingQuotePrefixes,
  formatTs,
  formatDayLabel,
  TOPIC_DISPLAY_THRESHOLD,
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
const TaskPage = lazy(() =>
  import("./components/TaskPage").then((module) => ({ default: module.TaskPage })),
);
const TopicPage = lazy(() =>
  import("./components/TopicPage").then((module) => ({ default: module.TopicPage })),
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
  // Composer send-kind: 4 unified types — 普通 / 加密 / 公告 / 主题.
  // Switchable via Tab / Shift-Tab and the ‹ › buttons flanking the composer.
  // Always resets to "normal" after each send. "reply" is orthogonal —
  // replyingTo overrides this. The "secret" kind syncs with the legacy
  // `secretMode` boolean so downstream code (send payload, render path) keeps
  // working unchanged.
  type MsgKind = MessageComposerKind;
  const [msgKind, setMsgKind] = useState<MsgKind>("normal");
  // Optional title carried by announcement + topic kinds. Normal messages
  // ignore it; we clear it whenever kind cycles or a send completes.
  const [composerTitle, setComposerTitle] = useState<string>("");
  const composerTitleRef = useRef<HTMLInputElement | null>(null);
  const cycleMsgKind = (direction: 1 | -1) => {
    setMsgKind((prev) => {
      const idx = MESSAGE_COMPOSER_KIND_ORDER.indexOf(prev);
      const next =
        (idx + direction + MESSAGE_COMPOSER_KIND_ORDER.length) %
        MESSAGE_COMPOSER_KIND_ORDER.length;
      setComposerTitle("");
      return MESSAGE_COMPOSER_KIND_ORDER[next];
    });
  };
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
  const [input, setInput] = useState("");
  const [inputRevision, setInputRevision] = useState(0);
  const inputDraftRef = useRef("");
  const setComposerInput = useCallback((value: string) => {
    inputDraftRef.current = value;
    setInput(value);
    setInputRevision((revision) => revision + 1);
  }, []);
  const handleComposerValueChange = useCallback((value: string) => {
    inputDraftRef.current = value;
  }, []);
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
  const [pendingFileIds, setPendingFileIds] = useState<string[]>([]);
  const [pendingFileNames, setPendingFileNames] = useState<string[]>([]);
  const [pendingFilePreviews, setPendingFilePreviews] = useState<
    (string | null)[]
  >([]);
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
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
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
  // 加密消息状态。Bound to msgKind === "secret" via the effect below — the
  // 🔒 toolbar button and the kind switcher both flip this through msgKind,
  // and downstream send/render code keeps reading `secretMode` unchanged.
  const [secretMode, setSecretMode] = useState(false);
  useEffect(() => {
    if (msgKind === "secret" && !secretMode) setSecretMode(true);
    if (msgKind !== "secret" && secretMode) setSecretMode(false);
  }, [msgKind, secretMode]);

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
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const secretInputRef = useRef<HTMLInputElement | null>(null);
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
    const effectiveKind: MsgKind | "reply" = isDmSelected
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
    setComposerInput("");
    setSecretMode(false);
    setMsgKind("normal");
    setComposerTitle("");
    setPendingFileIds([]);
    setPendingFileNames([]);
    setPendingFilePreviews((prev) => {
      prev.forEach((u) => {
        if (u) URL.revokeObjectURL(u);
      });
      return [];
    });
    setReplyingTo(null);
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
    setPendingFileIds([]);
    setPendingFileNames([]);
    setPendingFilePreviews((prev) => {
      prev.forEach((url) => {
        if (url) URL.revokeObjectURL(url);
      });
      return [];
    });
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

  const PRESIGN_EXTS = new Set([
    ".txt",
    ".md",
    ".docx",
    ".pdf",
    ".xlsx",
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
    ".gif",
  ]);
  const CONTENT_TYPE_MAP: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".pdf": "application/pdf",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".docx":
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx":
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };

  const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

  const uploadFileObject = async (file: File) => {
    if (!selectedId) return;
    if (!currentUserId) {
      setLoginModalOpen(true);
      toast.error("请先登录后再上传文件");
      return;
    }
    const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
    const allowed = [
      ".txt",
      ".md",
      ".docx",
      ".pdf",
      ".xlsx",
      ".png",
      ".jpg",
      ".jpeg",
      ".webp",
      ".gif",
    ];
    if (!allowed.includes(ext)) {
      toast.error(`不支持的格式：${ext}`);
      return;
    }
    const localPreview = IMAGE_EXTS.has(ext) ? URL.createObjectURL(file) : null;
    if (PRESIGN_EXTS.has(ext)) {
      const contentType =
        file.type || CONTENT_TYPE_MAP[ext] || "application/octet-stream";
      try {
        const presignRes = await authFetch(`${API}/files/presign`, {
          method: "POST",
          body: JSON.stringify({
            channel_id: selectedId,
            uploader_id: currentUserId,
            filename: file.name,
            content_type: contentType,
            size_bytes: file.size,
          }),
        });
        const presignData = await presignRes.json();
        if (!presignRes.ok || !presignData.data?.upload_url) {
          toast.error(presignData.detail || "获取上传凭证失败");
          if (localPreview) URL.revokeObjectURL(localPreview);
          return;
        }
        const {
          file_id,
          upload_url,
          headers: uploadHeaders,
        } = presignData.data;
        const putRes = await fetch(upload_url, {
          method: "PUT",
          headers: uploadHeaders,
          body: file,
        });
        if (!putRes.ok) {
          toast.error("文件上传失败，请重试");
          if (localPreview) URL.revokeObjectURL(localPreview);
          return;
        }
        // confirm upload so backend marks status as "uploaded"
        const confirmRes = await authFetch(
          `${API}/files/${file_id}/confirm`,
          { method: "POST" },
        );
        if (!confirmRes.ok) {
          console.warn("confirm upload failed", await confirmRes.text());
        }
        setPendingFileIds((prev) => [...prev, file_id]);
        setPendingFileNames((prev) => [...prev, file.name]);
        setPendingFilePreviews((prev) => [...prev, localPreview]);
      } catch (err) {
        toast.error("文件上传出错");
        if (localPreview) URL.revokeObjectURL(localPreview);
        console.error(err);
      }
    } else {
      fetch(
        `${API}/files/upload?channel_id=${encodeURIComponent(selectedId)}&uploader_id=${encodeURIComponent(currentUserId)}&filename=${encodeURIComponent(file.name)}`,
        { method: "POST", body: file },
      )
        .then((r) => r.json())
        .then((d) => {
          if (d.data?.file_id) {
            setPendingFileIds((prev) => [...prev, d.data.file_id]);
            setPendingFileNames((prev) => [...prev, file.name]);
            setPendingFilePreviews((prev) => [...prev, localPreview]);
          } else if (localPreview) {
            URL.revokeObjectURL(localPreview);
          }
        })
        .catch(console.error);
    }
  };

  const uploadFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    await uploadFileObject(file);
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
            {taskPageOpen &&
              !isDmSelected &&
              selectedId &&
              (() => (
                <div
                  style={{
                    position: "absolute",
                    inset: 0,
                    background: "var(--bg-0)",
                    zIndex: 20,
                    display: "flex",
                    flexDirection: "column",
                    minHeight: 0,
                  }}
                >
                  <Suspense fallback={<LazyPanelFallback label="正在加载任务视图..." />}>
                    <TaskPage
                      tasks={agentBridgeTaskMessages}
                      selectedMsgId={pageTaskMsgId}
                      channel={selectedChannel}
                      channelBots={channelBots}
                      onSelectTask={setPageTaskMsgId}
                      onBack={() => {
                        setTaskPageOpen(false);
                        setPageTaskMsgId(null);
                      }}
                      onJumpToMessage={(msgId) => {
                        setTaskPageOpen(false);
                        setPageTaskMsgId(null);
                        setTimeout(() => jumpToMessage(msgId), 0);
                      }}
                    />
                  </Suspense>
                </div>
              ))()}

            {!taskPageOpen &&
              !isDmSelected &&
              pageTopicId &&
              selectedId &&
              (() => {
                const rootMsg = pageTopicSourceMessages.find(
                  (m) => m.msg_id === pageTopicId,
                );
                const rootId = pageTopicId; // narrowed non-null
                return (
                  <div
                    style={{
                      position: "absolute",
                      inset: 0,
                      background: "var(--bg-0)",
                      zIndex: 20,
                      display: "flex",
                      flexDirection: "column",
                      minHeight: 0,
                    }}
                  >
                    {rootMsg ? (
                      <Suspense fallback={<LazyPanelFallback label="正在加载话题视图..." />}>
                        <TopicPage
                          rootMsg={rootMsg}
                          replies={pageTopicRepliesOf(rootId)}
                          channel={selectedChannel}
                          channelBots={channelBots}
                          channelUsers={channelUsers}
                          currentUserId={currentUserId}
                          onBack={() => setPageTopicId(null)}
                          onGoToChannel={() => setPageTopicId(null)}
                          onSendReply={(text) =>
                            sendTopicReply(selectedId, rootId, text)
                          }
                          onCopyMessage={copyMessageText}
                          onShowMessageDetails={setMemoryDetailMessage}
                          hasMessageDetails={hasBotReplyDetails}
                          onImageClick={handleMarkdownImageClick}
                          onFileClick={handleMarkdownFileClick}
                          renderAttachments={renderFileAttachments}
                          pendingFiles={pendingFileNames.map((name, index) => ({
                            name,
                            previewUrl: pendingFilePreviews[index] ?? null,
                          }))}
                          onRemovePendingFile={(index) => {
                            setPendingFileIds((prev) =>
                              prev.filter((_, itemIndex) => itemIndex !== index),
                            );
                            setPendingFileNames((prev) =>
                              prev.filter((_, itemIndex) => itemIndex !== index),
                            );
                            setPendingFilePreviews((prev) =>
                              prev.filter((_, itemIndex) => itemIndex !== index),
                            );
                          }}
                          onUploadFile={uploadFile}
                          keychainEnabled={Boolean(currentUser)}
                          keychainOpen={keychainPopupOpen}
                          keychainLoading={keychainPopupLoading}
                          keychainItems={keychainPopupItems}
                          onToggleKeychain={openKeychainPopup}
                          onCloseKeychain={() => setKeychainPopupOpen(false)}
                          sessionPanel={
                            <SessionScopePanel
                              scopeType="topic"
                              scopeId={rootId}
                              channelId={selectedId}
                              title="主题对应 Session"
                            />
                          }
                        />
                      </Suspense>
                    ) : (
                      <div className="an-topic-page">
                        <div className="an-tpp-top">
                          <button
                            type="button"
                            className="an-tpp-back"
                            onClick={() => setPageTopicId(null)}
                          >
                            ← 返回频道
                          </button>
                          <div className="an-tpp-meta">
                            <div className="an-tpp-crumbs">
                              <span>
                                {selectedChannel
                                  ? `#${selectedChannel.name}`
                                  : "频道"}
                              </span>
                              <span className="an-sep">›</span>
                              <span>主题</span>
                            </div>
                            <div className="an-tpp-title">
                              {pageTopicError ||
                                (pageTopicLoading
                                  ? "正在加载话题消息"
                                  : "未找到话题消息")}
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}

            {selectedId ? (
              <>
                <ChannelHeader
                  channel={selectedChannel}
                  activeDm={
                    activeDm
                  }
                  isMobile={isMobile}
                  onOpenSidebar={() => setSidebarOpen(true)}
                  autoAssist={autoAssist}
                  onOpenChannelSettings={() => setChannelSettingsOpen(true)}
                  memoryTab={memoryTab}
                  onSetMemoryTab={(tab) => {
                    setTaskPageOpen(false);
                    setPageTaskMsgId(null);
                    setMemoryTab(tab);
                  }}
                  topics={topicRoots
                    .map((r) => {
                      const replies = topicRepliesOf(r.msg_id);
                      // Surface if the user explicitly sent this as a 主题
                      // (msg_type="topic") OR if a plain message has
                      // accumulated enough replies to promote implicitly.
                      const isExplicit = r.msg_type === "topic";
                      if (
                        !isExplicit &&
                        replies.length < TOPIC_DISPLAY_THRESHOLD
                      ) {
                        return null;
                      }
                      const title =
                        (r.content || "").replace(/\s+/g, " ").trim().slice(0, 60) ||
                        "(无标题)";
                      const last = replies[replies.length - 1];
                      return {
                        rootId: r.msg_id,
                        title,
                        count: replies.length,
                        lastTime: last?.created_at
                          ? formatTs(last.created_at)
                          : undefined,
                      };
                    })
                    .filter((x): x is NonNullable<typeof x> => x !== null)}
                  onOpenTopic={(rootId) => {
                    setTaskPageOpen(false);
                    setPageTaskMsgId(null);
                    setPageTopicId(rootId);
                  }}
                  onJumpToMessage={jumpToMessage}
                  taskCount={isDmSelected ? 0 : agentBridgeTaskMessages.length}
                  taskActive={!isDmSelected && taskPageOpen}
                  onOpenTasks={
                    isDmSelected
                      ? undefined
                      : () => {
                          setMemoryTab(null);
                          setPageTopicId(null);
                          setPageTaskMsgId(agentBridgeTaskMessages[0]?.msg_id ?? null);
                          setTaskPageOpen(true);
                        }
                  }
                  onRefreshDmSession={activeBotDm ? refreshDmSession : undefined}
                  refreshingDmSession={refreshingDmSession}
                />
                {activeBotDm && activeDmSessionScopeId ? (
                  <SessionScopePanel
                    scopeType="dm"
                    scopeId={activeDmSessionScopeId}
                    channelId={selectedId}
                    botId={activeBotDm.counterparty.member_id}
                    title="DM 对应 Session"
                    refreshKey={dmSessionRefreshNonce}
                  />
                ) : selectedChannel?.type !== "dm" && (
                  <SessionScopePanel
                    scopeType="channel"
                    scopeId={selectedId}
                    channelId={selectedId}
                    title="频道对应 Session"
                  />
                )}

                <div
                  ref={messagesContainerRef}
                  className="flex-1 overflow-auto"
                  onScroll={handleMessagesScroll}
                >
                  {loading ? (
                    <div className="flex items-center justify-center h-full text-gray-400 text-sm">
                      加载中...
                    </div>
                  ) : (
                    <div className="py-2 px-2">
                      {loadingMore && (
                        <div className="text-center text-xs text-gray-400 py-2">
                          加载更多消息...
                        </div>
                      )}
                      {!hasMore && messages.length > 0 && (
                        <div className="text-center text-xs text-gray-300 py-2">
                          — 已加载全部消息 —
                        </div>
                      )}
                      {!loading &&
                        !loadingMore &&
                        messages.length === 0 &&
                        selectedChannel && (
                          <div className="an-empty">
                            <div className="an-empty-big">
                              # {selectedChannel.name}
                            </div>
                            <div className="an-empty-sm">
                              这里还没有消息。@ 调用一个 Bot 或直接开始对话。
                            </div>
                            <div className="an-empty-chips">
                              {[
                                "@Coordinator 总结这个频道最近的进展",
                                "这个频道的目标是什么？",
                                "@Coordinator 帮我接下来要做什么",
                              ].map((s) => (
                                <button
                                  key={s}
                                  type="button"
                                  className="an-empty-chip"
                                  onClick={() => {
                                    setComposerInput(s);
                                    setTimeout(
                                      () => inputRef.current?.focus(),
                                      0,
                                    );
                                  }}
                                >
                                  {s}
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                      {(() => {
                      const renderedRows = virtualItems.map((virtualItem) => {
                        const m = topicRoots[virtualItem.index];
                        if (!m) return null;
                        // isDM gates the "intimate" bubble + self-right
                        // treatment; channel rendering is Discord-style
                        // flat, all-left, always with sender identity.
                        const isDMRender =
                          selectedChannel?.type === "dm";
                        // ── routing card: coordinator picks + plan ──────────
                        if (m.msg_type === "routing") {
                          const cd = (m.content_data ?? {}) as Record<
                            string,
                            unknown
                          >;
                          const q = typeof cd.q === "string" ? cd.q : null;
                          const plan =
                            typeof cd.plan === "string" ? cd.plan : null;
                          const picksRaw = Array.isArray(cd.picks)
                            ? (cd.picks as Array<Record<string, unknown>>)
                            : [];
                          const picks = picksRaw.map((p) => ({
                            agent:
                              typeof p.agent === "string" ? p.agent : "agent",
                            score:
                              typeof p.score === "string" ? p.score : null,
                            why: typeof p.why === "string" ? p.why : null,
                            picked: p.picked === true,
                            secondary: p.secondary === true,
                          }));
                          const coordBot = coordinatorBot;
                          const rTime = m.created_at
                            ? formatTs(m.created_at)
                            : "";
                          return (
                            <div
                              key={m.msg_id}
                              id={`msg-${m.msg_id}`}
                              className="an-chat-msg pl-16 pr-4 pt-2"
                            >
                              <div className="flex items-baseline gap-1.5 mb-1 pl-1">
                                <span className="text-[13px] font-semibold text-gray-900">
                                  {coordBot?.display_name ||
                                    coordBot?.username ||
                                    "协作助手"}
                                </span>
                                <span
                                  className="an-tag coord"
                                  style={{
                                    fontSize: 9,
                                    fontWeight: 700,
                                    letterSpacing: "0.6px",
                                    padding: "1px 5px",
                                    borderRadius: 3,
                                    background: "var(--accent-muted)",
                                    color: "var(--accent)",
                                  }}
                                >
                                  COORDINATOR
                                </span>
                                {rTime && (
                                  <span className="text-[11px] text-gray-400">
                                    {rTime}
                                  </span>
                                )}
                              </div>
                              <div className="an-routing">
                                {q && (
                                  <div className="an-rq">
                                    路由: <b>{q}</b>
                                  </div>
                                )}
                                {picks.length > 0 && (
                                  <div className="an-picks">
                                    {picks.map((p) => {
                                      const bot = botByUsername.get(p.agent);
                                      const color =
                                        bot?.avatar_url ?? null;
                                      return (
                                        <span
                                          key={p.agent}
                                          className={
                                            "an-pick" +
                                            (p.picked ? " picked" : "")
                                          }
                                          title={p.why || undefined}
                                        >
                                          <span
                                            className="an-dot"
                                            style={{
                                              background: color
                                                ? "var(--accent)"
                                                : "var(--fg-3)",
                                            }}
                                          />
                                          @{p.agent}
                                          {p.score && (
                                            <span
                                              style={{
                                                color: "var(--fg-3)",
                                                marginLeft: 2,
                                                fontSize: 11,
                                              }}
                                            >
                                              {p.score}
                                            </span>
                                          )}
                                        </span>
                                      );
                                    })}
                                  </div>
                                )}
                                {plan && (
                                  <div className="an-plan">
                                    <b>计划:</b> {plan}
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        }

                        // ── friend request card: Personal system notice ──────
                        if (m.msg_type === "friend_request") {
                          const cd = (m.content_data ?? {}) as Record<string, unknown>;
                          const requester =
                            cd.requester && typeof cd.requester === "object"
                              ? (cd.requester as Record<string, unknown>)
                              : {};
                          const receiver =
                            cd.receiver && typeof cd.receiver === "object"
                              ? (cd.receiver as Record<string, unknown>)
                              : {};
                          const friendshipId =
                            typeof cd.friendship_id === "string"
                              ? cd.friendship_id
                              : "";
                          const status =
                            typeof cd.status === "string" ? cd.status : "pending";
                          const requesterName =
                            (requester.display_name as string | undefined) ||
                            (requester.username as string | undefined) ||
                            "用户";
                          const requesterUsername =
                            requester.username as string | undefined;
                          const canResolve =
                            status === "pending" &&
                            friendshipId &&
                            (receiver.user_id as string | undefined) === currentUserId;
                          const submitFriendRequest = async (
                            action: "accept" | "reject",
                          ) => {
                            try {
                              const r = await apiFetch(
                                `/friends/requests/${friendshipId}/${action}`,
                                { method: "POST", token: authToken },
                              );
                              const data = await r.json();
                              if (data?.status !== "success") {
                                toast.error(data?.detail || data?.message || "操作失败");
                                return;
                              }
                              const nextStatus =
                                action === "accept" ? "accepted" : "rejected";
                              setMessageStore((prev) =>
                                patchMessage(prev, m.msg_id, (x) => ({
                                  ...x,
                                  content_data: {
                                    ...(x.content_data || {}),
                                    status: nextStatus,
                                    resolved_by: currentUserId,
                                  },
                                })),
                              );
                              refreshDMs(setDMs, authToken ?? undefined);
                              toast.success(action === "accept" ? "已同意好友申请" : "已拒绝好友申请");
                            } catch {
                              toast.error("操作失败");
                            }
                          };
                          const friendTime = m.created_at ? formatTs(m.created_at) : "";
                          return (
                            <div
                              key={m.msg_id}
                              id={`msg-${m.msg_id}`}
                              className="an-chat-msg pl-16 pr-4 pt-2"
                            >
                              <div className="flex items-baseline gap-1.5 mb-1 pl-1">
                                <span className="text-[13px] font-semibold text-gray-900">
                                  好友通知
                                </span>
                                {friendTime && (
                                  <span className="text-[11px] text-gray-400">
                                    {friendTime}
                                  </span>
                                )}
                              </div>
                              <div className={"an-approval" + (status !== "pending" ? " resolved" : "")}>
                                <div className="an-body">
                                  <b>{requesterName}</b>
                                  {requesterUsername && (
                                    <span style={{ color: "var(--fg-3)", marginLeft: 6 }}>
                                      @{requesterUsername}
                                    </span>
                                  )}
                                  <span style={{ marginLeft: 6 }}>
                                    {status === "pending"
                                      ? "请求添加你为好友"
                                      : status === "accepted"
                                        ? "已成为你的好友"
                                        : status === "rejected"
                                          ? "好友申请已拒绝"
                                          : status === "cancelled"
                                            ? "已撤回好友申请"
                                            : "好友申请已处理"}
                                  </span>
                                </div>
                                {canResolve && (
                                  <>
                                    <button
                                      type="button"
                                      className="deny"
                                      onClick={() => submitFriendRequest("reject")}
                                    >
                                      拒绝
                                    </button>
                                    <button
                                      type="button"
                                      className="allow"
                                      onClick={() => submitFriendRequest("accept")}
                                    >
                                      同意
                                    </button>
                                  </>
                                )}
                              </div>
                            </div>
                          );
                        }

                        // ── permission card: Allow/Deny for tool writes ──────
                        if (m.msg_type === "permission") {
                          const cd = (m.content_data ?? {}) as Record<
                            string,
                            unknown
                          >;
                          const tool =
                            typeof cd.tool === "string" ? cd.tool : null;
                          const body =
                            typeof cd.body === "string"
                              ? cd.body
                              : m.content || "";
                          const resolved = cd.resolved === true;
                          const resolution =
                            cd.resolution === "allow" ||
                            cd.resolution === "deny"
                              ? cd.resolution
                              : null;
                          const senderBot =
                            m.sender_type === "bot"
                              ? botById.get(m.sender_id)
                              : null;
                          const senderLabel =
                            senderBot?.display_name ||
                            senderBot?.username ||
                            "Bot";
                          const pTime = m.created_at
                            ? formatTs(m.created_at)
                            : "";
                          const submitResolution = async (
                            res: "allow" | "deny",
                          ) => {
                            try {
                              const r = await apiFetch(
                                `/channels/${selectedId}/messages/${m.msg_id}/resolve`,
                                {
                                  method: "POST",
                                  body: { resolution: res },
                                  token: authToken,
                                },
                              );
                              if (!r.ok) return;
                              const data = await r.json();
                              // Optimistic local update — the WS broadcast also
                              // merges it back in, so this mainly covers the case
                              // where the user clicks while offline-ish.
                              if (data?.data?.content_data) {
                                setMessageStore((prev) =>
                                  patchMessage(prev, m.msg_id, (x) => ({
                                    ...x,
                                    content_data: data.data.content_data,
                                  })),
                                );
                              }
                            } catch {
                              /* ignore — UI stays un-resolved so user can retry */
                            }
                          };
                          return (
                            <div
                              key={m.msg_id}
                              id={`msg-${m.msg_id}`}
                              className="an-chat-msg pl-16 pr-4 pt-2"
                            >
                              <div className="flex items-baseline gap-1.5 mb-1 pl-1">
                                <span className="text-[13px] font-semibold text-gray-900">
                                  {senderLabel}
                                </span>
                                <span
                                  className="an-tag bot"
                                  style={{
                                    fontSize: 9,
                                    fontWeight: 700,
                                    letterSpacing: "0.6px",
                                    padding: "1px 5px",
                                    borderRadius: 3,
                                    background: "var(--surface-soft)",
                                    color: "var(--fg-3)",
                                    border: "1px solid var(--border)",
                                  }}
                                >
                                  BOT
                                </span>
                                {pTime && (
                                  <span className="text-[11px] text-gray-400">
                                    {pTime}
                                  </span>
                                )}
                              </div>
                              <div
                                className={
                                  "an-approval" +
                                  (resolved ? " resolved" : "")
                                }
                              >
                                <div className="an-body">
                                  <b>Approval needed.</b> {body}
                                  {tool && (
                                    <span
                                      style={{
                                        fontFamily: "var(--font-mono)",
                                        fontSize: 11,
                                        marginLeft: 6,
                                        color: "var(--fg-3)",
                                      }}
                                    >
                                      ({tool})
                                    </span>
                                  )}
                                  {resolved && resolution && (
                                    <span
                                      style={{
                                        marginLeft: 8,
                                        color: "var(--fg-3)",
                                      }}
                                    >
                                      ·{" "}
                                      {resolution === "allow"
                                        ? "已通过"
                                        : "已拒绝"}
                                    </span>
                                  )}
                                </div>
                                {!resolved && (
                                  <>
                                    <button
                                      type="button"
                                      className="deny"
                                      onClick={() => submitResolution("deny")}
                                    >
                                      拒绝
                                    </button>
                                    <button
                                      type="button"
                                      className="allow"
                                      onClick={() => submitResolution("allow")}
                                    >
                                      通过
                                    </button>
                                  </>
                                )}
                              </div>
                            </div>
                          );
                        }

                        // ── announcement card: pinned banner, no bubble ──────
                        if (m.msg_type === "announcement") {
                          const cd = (m.content_data ?? {}) as Record<
                            string,
                            unknown
                          >;
                          const title =
                            typeof cd.title === "string" ? cd.title : null;
                          const pinnedById =
                            typeof cd.pinned_by === "string"
                              ? cd.pinned_by
                              : null;
                          const pinnedUser = pinnedById
                            ? pinnedById === currentUserId
                              ? { display_name: "我", username: "me" }
                              : userById.get(pinnedById)
                            : null;
                          const pinnedLabel =
                            pinnedUser?.display_name ||
                            pinnedUser?.username ||
                            pinnedById ||
                            "频道管理员";
                          const annTime = m.created_at
                            ? formatTs(m.created_at)
                            : "";
                          return (
                            <div
                              key={m.msg_id}
                              id={`msg-${m.msg_id}`}
                              className="an-chat-msg pl-16 pr-4 pt-2"
                            >
                              <div className="an-announce">
                                <div className="an-ann-ico" aria-hidden="true">
                                  !
                                </div>
                                <div className="an-ann-tag">公告 · Announcement</div>
                                {title && (
                                  <div className="an-ann-title">{title}</div>
                                )}
                                <div className="an-ann-body">{m.content}</div>
                                <div className="an-ann-foot">
                                  <span>由 {pinnedLabel} 置顶</span>
                                  {annTime && (
                                    <>
                                      <span>·</span>
                                      <span>{annTime}</span>
                                    </>
                                  )}
                                </div>
                              </div>
                            </div>
                          );
                        }

                        const replies = topicRepliesOf(m.msg_id);

                        // ── helpers shared by root & replies ──────────────────
                        const replyIcon = (
                          <AppIcon name="reply" className="w-3.5 h-3.5" />
                        );

                        // ── root message ───────────────────────────────────────
                        const revealedContent = revealedSecrets[m.msg_id];
                        const effectiveContent = m.is_secret
                          ? (revealedContent ?? m.content)
                          : m.content;
                        const { text, clarify } =
                          parseHelperPayload(effectiveContent);
                        const clarifyAnswered =
                          !!clarify &&
                          clarifyAnsweredParentIds.has(m.msg_id);
                        const clarifyWaiting =
                          pendingClarifyReplyMsgId === m.msg_id;
                        const clarifyStatus:
                          | "form"
                          | "waiting"
                          | "answered"
                          | null =
                          clarify && m.sender_type === "bot"
                            ? clarifyWaiting
                              ? "waiting"
                              : clarifyAnswered
                                ? "answered"
                                : "form"
                            : null;
                        const displayContent = (() => {
                          const base = isClarifyReplyUserMessage(effectiveContent)
                            ? effectiveContent
                                .replace(
                                  /^@(?:Helper|Coordinator|channel bot|引导)\s*澄清回答[：:]\s*/i,
                                  "",
                                )
                                .trim()
                            : text || effectiveContent;
                          return m.sender_type === "bot"
                            ? stripLeadingQuotePrefixes(base)
                            : base;
                        })();
                        const isOwn =
                          m.sender_type === "user" &&
                          m.sender_id === currentUserId;
                        const senderBot =
                          m.sender_type === "bot"
                            ? botById.get(m.sender_id)
                            : undefined;
                        const botLabel =
                          m.sender_name ||
                          senderBot?.display_name ||
                          senderBot?.username ||
                          "Bot";
                        const senderUser =
                          m.sender_type === "user" && !isOwn
                            ? userById.get(m.sender_id)
                            : undefined;
                        const userLabel =
                          m.sender_name ||
                          (isOwn
                            ? currentUser?.display_name || currentUser?.username
                            : senderUser?.display_name || senderUser?.username) ||
                          "用户";
                        const userAvatarUrl = isOwn
                          ? currentUser?.avatar_url
                          : senderUser?.avatar_url;
                        const userInitials = userLabel
                          .slice(0, 1)
                          .toUpperCase();
                        const msgTime = m.created_at
                          ? new Date(m.created_at).toLocaleString("zh-CN", {
                              month: "2-digit",
                              day: "2-digit",
                              hour: "2-digit",
                              minute: "2-digit",
                            })
                          : "";

                        const secretSecsLeft =
                          m.is_secret && !revealedContent && m.created_at
                            ? getSecretSecondsLeft(m.created_at)
                            : null;
                        const isSecretExpired =
                          secretSecsLeft !== null && secretSecsLeft <= 0;
                        const isSecretUnrevealed =
                          m.is_secret && !revealedContent && !isSecretExpired;
                        const secretVeil = (
                          <SecretMessageVeil
                            createdAt={m.created_at}
                            canReveal={Boolean(secretTokens[m.msg_id])}
                            onReveal={() => revealSecretMessage(m.msg_id)}
                          />
                        );
                        const rootBubble = !isDMRender ? (
                          // ── Channel flat render — Discord style ────────
                          // All-left alignment, no bubble, always with avatar.
                          <div
                            id={`msg-${m.msg_id}`}
                            className="an-chat-msg group relative px-4 transition-colors"
                            style={{
                              paddingTop: 8,
                              paddingBottom: 2,
                            }}
                          >
                            {/* subtle hover tint covering the full row width */}
                            <div
                              className="absolute inset-0 pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity"
                              style={{ background: "var(--surface-soft)" }}
                            />
                            <div className="relative flex gap-3">
                              <div className="w-9 flex-shrink-0">
                                {m.sender_type === "bot" ? (
                                  <BotAvatar
                                    label={botLabel}
                                    avatarUrl={senderBot?.avatar_url}
                                    brandName={senderBot?.display_name || senderBot?.username || botLabel}
                                    size={36}
                                    className="mt-0.5"
                                  />
                                ) : userAvatarUrl ? (
                                  <img
                                    src={userAvatarUrl}
                                    alt={userLabel}
                                    className="w-9 h-9 rounded-xl object-cover select-none mt-0.5"
                                  />
                                ) : (
                                  <div
                                    className="w-9 h-9 rounded-xl flex items-center justify-center text-white text-xs font-bold select-none mt-0.5"
                                    style={{
                                      background: isOwn
                                        ? "var(--accent)"
                                        : "var(--fg-3)",
                                    }}
                                  >
                                    {isOwn ? "我" : userInitials}
                                  </div>
                                )}
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-baseline gap-2 mb-0.5 flex-wrap">
                                  <span
                                    className="font-semibold"
                                    style={{
                                      fontSize: "var(--fs-chat-name)",
                                      lineHeight: 1.2,
                                      color: "var(--fg-1)",
                                    }}
                                  >
                                    {isOwn
                                      ? "我"
                                      : m.sender_type === "bot"
                                        ? botLabel
                                        : userLabel}
                                  </span>
                                  <span
                                    className="text-[11px]"
                                    style={{ color: "var(--fg-3)" }}
                                  >
                                    {msgTime}
                                  </span>
                                </div>
                                {m.content_data?.title ? (
                                  <div
                                    className="text-[14px] font-semibold mb-1 leading-snug"
                                    style={{ color: "var(--fg-1)" }}
                                  >
                                    {m.content_data.title as string}
                                  </div>
                                ) : null}
                                {/* Unified reply-quote: lifted out of the
                                    body so all 4 message paths render the
                                    "回复某条消息" indicator the exact same
                                    way (.an-reply-quote with elbow connector). */}
                                {(() => {
                                  const mq = parseQuotePrefix(displayContent);
                                  if (!mq || isSecretExpired || isSecretUnrevealed)
                                    return null;
                                  return (
                                    <div
                                      className="an-reply-quote"
                                      title={`回复 ${mq.label}`}
                                    >
                                      <span className="an-rq-arrow">↪</span>
                                      <span className="an-rq-name">{mq.label}</span>
                                      <span className="an-rq-snip">
                                        {mq.quote.replace(/\s+/g, " ").trim()}
                                      </span>
                                    </div>
                                  );
                                })()}
                                {renderFileAttachments(m)}
                                <div
                                  style={{
                                    fontSize: "var(--fs-chat-body)",
                                    lineHeight: "var(--lh-chat-body)",
                                    color: "var(--fg-1)",
                                    wordWrap: "break-word",
                                  }}
                                >
                                  {isSecretExpired || isSecretUnrevealed ? (
                                    secretVeil
                                  ) : activeAgentBridgeTaskData(m) ? (
                                    renderAgentBridgeTaskCard(m)
                                  ) : (
                                    <ChatMessageRenderer
                                      content={
                                        // Strip the `> [Author]: …\n\n` prefix
                                        // (rendered separately as .an-reply-quote
                                        // above) so the body shows only the
                                        // actual content.
                                        parseQuotePrefix(displayContent)?.rest ??
                                        displayContent
                                      }
                                      keyPrefix={`${m.msg_id}-`}
                                      streaming={!!m._streaming}
                                      showStreamingCursor={false}
                                      onImageClick={handleMarkdownImageClick}
                                      onFileClick={handleMarkdownFileClick}
                                    />
                                  )}
                                  {m._streaming &&
                                    !!(parseHelperPayload(displayContent).text ||
                                      displayContent) && (
                                      <span
                                        className="inline-block w-1.5 h-4 rounded-sm animate-pulse align-middle ml-0.5"
                                        style={{
                                          background: "var(--fg-3)",
                                        }}
                                      />
                                    )}
                                  {renderStopStreamButton(m)}
                                  {renderPartialBadge(m)}
                                </div>
                                {renderBotTraceStatus(m)}
                                {clarifyStatus !== null && selectedId && (
                                  <ClarifyInlineBlock
                                    msgId={m.msg_id}
                                    schema={clarify!}
                                    status={clarifyStatus}
                                    replyContent={undefined}
                                    onContinue={(answers) =>
                                      handleClarifyContinue(
                                        m.msg_id,
                                        clarify!,
                                        answers,
                                      )
                                    }
                                    onSkip={() =>
                                      handleClarifySkip(m.msg_id)
                                    }
                                  />
                                )}
                              </div>
                              <div className="opacity-0 group-hover:opacity-100 transition-opacity self-start flex items-center gap-1 flex-shrink-0">
                                <button
                                  type="button"
                                  title="复制消息内容"
                                  onClick={() => copyMessageText(m)}
                                  className="an-chat-action"
                                >
                                  <AppIcon name="copy" className="w-3.5 h-3.5" />
                                </button>
                                {renderMemoryLoadButton(m)}
                                <button
                                  type="button"
                                  title="回复"
                                  onClick={() => {
                                    setReplyingTo(m);
                                    const mention =
                                      m.sender_type === "bot" &&
                                      senderBot?.username
                                        ? `@${senderBot.username} `
                                        : "";
                                    if (mention) setComposerInput(mention);
                                    (secretMode
                                      ? secretInputRef.current
                                      : inputRef.current
                                    )?.focus();
                                  }}
                                  className="an-chat-action"
                                >
                                  {replyIcon}
                                </button>
                              </div>
                            </div>
                          </div>
                        ) : isOwn ? (
                          <div
                            id={`msg-${m.msg_id}`}
                            className="an-chat-msg group flex flex-row-reverse items-end gap-2.5 px-4 py-1 transition-all"
                          >
                            <div className="w-8 h-8 rounded-xl bg-[#1264A3] flex items-center justify-center text-white text-xs font-bold select-none flex-shrink-0">
                              我
                            </div>
                            <div className="flex items-end gap-1.5">
                              {!isDmSelected && (
                                <button
                                  type="button"
                                  title="回复"
                                  onClick={() => {
                                    setReplyingTo(m);
                                    const mention =
                                      m.sender_type === "bot" &&
                                      senderBot?.username
                                        ? `@${senderBot.username} `
                                        : "";
                                    if (mention) setComposerInput(mention);
                                    (secretMode
                                      ? secretInputRef.current
                                      : inputRef.current
                                    )?.focus();
                                  }}
                                  className="opacity-0 group-hover:opacity-100 transition-opacity w-6 h-6 flex items-center justify-center rounded-full hover:bg-gray-100 text-gray-400 hover:text-gray-600 flex-shrink-0 mb-1"
                                >
                                  {replyIcon}
                                </button>
                              )}
                              <div className="flex flex-col items-end max-w-[85%] sm:max-w-[72%]">
                                <div className="flex items-baseline gap-1.5 mb-1 justify-end">
                                  {!isDmSelected && m.msg_type === "topic" && (
                                    <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-blue-50 text-blue-500 font-medium leading-none">
                                      主题
                                    </span>
                                  )}
                                  <span className="text-[11px] text-gray-400 mr-0.5">
                                    {msgTime}
                                  </span>
                                </div>
                                {m.content_data?.title ? (
                                  <div className="text-[13px] font-semibold text-white/90 mb-1 mr-0.5 leading-snug text-right">
                                    {m.content_data.title as string}
                                  </div>
                                ) : null}
                                {renderFileAttachments(m, true)}
                                {/* If this user message starts with a "> [X]: ..."
                                    quote prefix (set when the user used the
                                    reply UI), surface it as a small-gray
                                    .an-reply-quote ABOVE the bubble. The
                                    bubble itself then renders just `q.rest`
                                    so the parent context doesn't intrude on
                                    the body. The CSS connector elbow visually
                                    bridges quote → body. */}
                                {(() => {
                                  const q = parseQuotePrefix(displayContent);
                                  if (!q || isSecretExpired || isSecretUnrevealed)
                                    return null;
                                  return (
                                    <div
                                      className="an-reply-quote"
                                      title={`回复 ${q.label}`}
                                    >
                                      <span className="an-rq-arrow">↪</span>
                                      <span className="an-rq-name">{q.label}</span>
                                      <span className="an-rq-snip">
                                        {q.quote.replace(/\s+/g, " ").trim()}
                                      </span>
                                    </div>
                                  );
                                })()}
                                {isSecretExpired || isSecretUnrevealed ? (
                                  secretVeil
                                ) : (
                                  <div
                                    className="bg-[#1264A3] text-white rounded-2xl rounded-tr-sm px-3.5 py-2 text-[14px] leading-relaxed break-words"
                                  >
                                    {(() => {
                                      // The quote prefix (if any) is already
                                      // rendered above as .an-reply-quote;
                                      // here we render only the body text.
                                      const q =
                                        parseQuotePrefix(displayContent);
                                      const body = q ? q.rest : displayContent;
                                      return (
                                        <span className="whitespace-pre-wrap">
                                          {body
                                            .replace(/!\[.*?\]\(.*?\)\s*/g, "")
                                            .trim() || body}
                                        </span>
                                      );
                                    })()}
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        ) : (
                          <div
                            id={`msg-${m.msg_id}`}
                            className="an-chat-msg group flex items-start gap-2.5 px-4 py-1 transition-all"
                          >
                            <div className="flex-shrink-0 mt-0.5">
                              {m.sender_type === "bot" ? (
                                <BotAvatar
                                  label={botLabel}
                                  avatarUrl={senderBot?.avatar_url}
                                  brandName={senderBot?.display_name || senderBot?.username || botLabel}
                                  size={32}
                                />
                              ) : userAvatarUrl ? (
                                <img
                                  src={userAvatarUrl}
                                  alt={userLabel}
                                  className="w-8 h-8 rounded-xl object-cover select-none"
                                />
                              ) : (
                                <div className="w-8 h-8 rounded-xl bg-gray-400 flex items-center justify-center text-white text-xs font-bold select-none">
                                  {userInitials}
                                </div>
                              )}
                            </div>
                            <div className="flex flex-col max-w-[85%] sm:max-w-[72%]">
                              <div className="flex items-baseline gap-1.5 mb-1">
                                <span className="font-semibold text-[13px] text-gray-900 leading-none">
                                  {m.sender_type === "bot"
                                    ? botLabel
                                    : userLabel}
                                </span>
                                {m.sender_type === "bot" && (
                                  <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-[#2EB67D]/10 text-[#2EB67D] font-medium leading-none">
                                    Bot
                                  </span>
                                )}
                                {!isDmSelected && m.msg_type === "topic" && (
                                  <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-blue-50 text-blue-500 font-medium leading-none">
                                    主题
                                  </span>
                                )}
                                <span className="text-[11px] text-gray-400 leading-none">
                                  {msgTime}
                                </span>
                              </div>
                              {m.content_data?.title ? (
                                <div className="text-[13px] font-semibold text-gray-700 mb-1 leading-snug">
                                  {m.content_data.title as string}
                                </div>
                              ) : null}
                              {(() => {
                                const cq = parseQuotePrefix(text);
                                if (!cq) return null;
                                return (
                                  <div
                                    className="an-reply-quote"
                                    title={`回复 ${cq.label}`}
                                  >
                                    <span className="an-rq-arrow">↪</span>
                                    <span className="an-rq-name">
                                      {cq.label}
                                    </span>
                                    <span className="an-rq-snip">
                                      {cq.quote.replace(/\s+/g, " ").trim()}
                                    </span>
                                  </div>
                                );
                              })()}
                              {renderFileAttachments(m)}
                              <div
                                className="rounded-2xl rounded-tl-sm px-3.5 py-2 text-[14px] leading-relaxed"
                                style={{
                                  background: isSecretUnrevealed
                                    ? "var(--orange-muted)"
                                    : "var(--surface-soft)",
                                  color: "var(--fg-1)",
                                  border: "1px solid var(--border)",
                                }}
                              >
                                {isSecretExpired || isSecretUnrevealed ? (
                                  secretVeil
                                ) : activeAgentBridgeTaskData(m) ? (
                                  renderAgentBridgeTaskCard(m)
                                ) : m._streaming && !text ? (
                                  <span className="inline-block w-2 h-4 bg-gray-400 rounded-sm animate-pulse align-middle" />
                                ) : (
                                  <ChatMessageRenderer
                                    content={parseQuotePrefix(text)?.rest ?? text}
                                    keyPrefix={`${m.msg_id}-`}
                                    streaming={!!m._streaming}
                                    showStreamingCursor={false}
                                    onImageClick={handleMarkdownImageClick}
                                    onFileClick={handleMarkdownFileClick}
                                  />
                                )}
                                {!isSecretUnrevealed &&
                                  m._streaming &&
                                  !!text && (
                                    <span className="inline-block w-1.5 h-4 bg-gray-400 rounded-sm animate-pulse align-middle ml-0.5" />
                                  )}
                                {!isSecretUnrevealed && renderStopStreamButton(m)}
                                {!isSecretUnrevealed && renderPartialBadge(m)}
                              </div>
                              {renderBotTraceStatus(m)}
                              {clarifyStatus !== null && selectedId && (
                                <ClarifyInlineBlock
                                  msgId={m.msg_id}
                                  schema={clarify!}
                                  status={clarifyStatus}
                                  replyContent={undefined}
                                  onContinue={(answers) =>
                                    handleClarifyContinue(
                                      m.msg_id,
                                      clarify!,
                                      answers,
                                    )
                                  }
                                  onSkip={() => handleClarifySkip(m.msg_id)}
                                />
                              )}
                            </div>
                            <div className="opacity-0 group-hover:opacity-100 transition-opacity self-center flex items-center gap-1 flex-shrink-0">
                              {renderMemoryLoadButton(m)}
                              {!isDmSelected && (
                                <button
                                  type="button"
                                  title="回复"
                                  onClick={() => {
                                    setReplyingTo(m);
                                    const mention =
                                      m.sender_type === "bot" && senderBot?.username
                                        ? `@${senderBot.username} `
                                        : "";
                                    if (mention) setComposerInput(mention);
                                    (secretMode
                                      ? secretInputRef.current
                                      : inputRef.current
                                    )?.focus();
                                  }}
                                  className="w-6 h-6 flex items-center justify-center rounded-full hover:bg-gray-200 text-gray-400 hover:text-gray-600 flex-shrink-0"
                                >
                                  {replyIcon}
                                </button>
                              )}
                            </div>
                          </div>
                        );

                        // ── topic card ───────────────────────────────────────
                        // An explicit 主题 (msg_type="topic") should render
                        // as a topic card regardless of reply count, so the
                        // user sees the intent reflected immediately. The
                        // 4-reply threshold only gates implicit promotion of
                        // a normal message that's accumulated replies.
                        const isExplicitTopic = !isDmSelected && m.msg_type === "topic";
                        // Force expansion when there's nothing to collapse
                        // (0-reply explicit topic) — otherwise the collapsed
                        // preview path would blow up on replies[length-1].
                        const isExpanded =
                          expandedTopics.has(m.msg_id) ||
                          (isExplicitTopic && replies.length === 0);

                        // No replies and not an explicit topic — render as a
                        // plain standalone bubble.
                        if (!isExplicitTopic && replies.length === 0) {
                          return <div key={m.msg_id}>{rootBubble}</div>;
                        }

                        // 1–3 replies on a plain message — inline render, no
                        // topic chrome. Explicit 主题 messages fall through
                        // to the topic-card branch below regardless of count.
                        if (
                          !isExplicitTopic &&
                          replies.length < TOPIC_DISPLAY_THRESHOLD
                        ) {
                          const renderReplyRow = (r: Message) => {
                          const rIsOwn =
                            r.sender_type === "user" &&
                            r.sender_id === currentUserId;
                          const rBot =
                            r.sender_type === "bot"
                              ? botById.get(r.sender_id)
                              : undefined;
                          const rSenderUser =
                            r.sender_type === "user" && !rIsOwn
                              ? userById.get(r.sender_id)
                              : undefined;
                          const rLabel = rBot
                            ? rBot.display_name || rBot.username || "Bot"
                            : rIsOwn
                              ? "我"
                              : rSenderUser?.display_name ||
                                rSenderUser?.username ||
                                "用户";
                          const rInitials = rLabel.slice(0, 2).toUpperCase();
                          const rTime = r.created_at
                            ? new Date(r.created_at).toLocaleString("zh-CN", {
                                month: "2-digit",
                                day: "2-digit",
                                hour: "2-digit",
                                minute: "2-digit",
                              })
                            : "";
                          const {
                            text: rTextRaw,
                            clarify: rClarify,
                          } = parseHelperPayload(r.content);
                          const rDisplay = (() => {
                            const base = isClarifyReplyUserMessage(r.content)
                              ? r.content
                                  .replace(
                                    /^@(?:Helper|Coordinator|channel bot|引导)\s*澄清回答[：:]\s*/i,
                                    "",
                                  )
                                  .trim()
                              : rTextRaw || r.content;
                            return r.sender_type === "bot"
                              ? stripLeadingQuotePrefixes(base)
                              : base;
                          })();
                          const rClarifyAnswered =
                            !!rClarify &&
                            clarifyAnsweredParentIds.has(r.msg_id);
                          const rClarifyWaiting =
                            pendingClarifyReplyMsgId === r.msg_id;
                          const rClarifyStatus:
                            | "form"
                            | "waiting"
                            | "answered"
                            | null =
                            rClarify && r.sender_type === "bot"
                              ? rClarifyWaiting
                                ? "waiting"
                                : rClarifyAnswered
                                  ? "answered"
                                  : "form"
                              : null;
                          // Channel flat-reply render: no bubble, all-left,
                          // iridescent outline on bot replies. DMs keep the
                          // bubble treatment below.
                          const rFlat = !isDMRender;
                          return (
                            <div
                              key={r.msg_id}
                              id={`msg-${r.msg_id}`}
                              className={
                                rFlat
                                  ? "an-chat-msg group flex gap-3 px-4 py-1 items-start transition-colors"
                                  : `an-chat-msg group flex gap-2.5 px-4 py-1 transition-all ${
                                      rIsOwn
                                        ? "flex-row-reverse items-end"
                                        : "items-start"
                                    }`
                              }
                            >
                                <div className="flex-shrink-0 mt-0.5">
                                  {r.sender_type === "bot" ? (
                                    rBot?.avatar_url ? (
                                      <img
                                        src={rBot.avatar_url}
                                        alt={rLabel}
                                        className={
                                          rFlat
                                            ? "w-9 h-9 rounded-xl object-cover"
                                            : "w-8 h-8 rounded-xl object-cover"
                                        }
                                      />
                                    ) : (
                                      <div
                                        className={
                                          rFlat
                                            ? "w-9 h-9 rounded-xl flex items-center justify-center text-white text-xs font-bold select-none"
                                            : "w-8 h-8 rounded-xl bg-[#2EB67D] flex items-center justify-center text-white text-xs font-bold select-none"
                                        }
                                        style={
                                          rFlat
                                            ? { background: "var(--fg-3)" }
                                            : undefined
                                        }
                                      >
                                        {rInitials}
                                      </div>
                                    )
                                  ) : (
                                    <div
                                      className={
                                        rFlat
                                          ? "w-9 h-9 rounded-xl flex items-center justify-center text-white text-xs font-bold select-none"
                                          : `w-8 h-8 rounded-xl flex items-center justify-center text-white text-xs font-bold select-none ${rIsOwn ? "bg-[#1264A3]" : "bg-gray-400"}`
                                      }
                                      style={
                                        rFlat
                                          ? {
                                              background: rIsOwn
                                                ? "var(--accent)"
                                                : "var(--fg-3)",
                                            }
                                          : undefined
                                      }
                                    >
                                      {rIsOwn ? "我" : rInitials}
                                    </div>
                                  )}
                                </div>
                                <div
                                  className={
                                    rFlat
                                      ? "flex-1 min-w-0 flex flex-col"
                                      : `flex flex-col max-w-[85%] sm:max-w-[72%] ${rIsOwn ? "items-end" : ""}`
                                  }
                                >
                                  <div
                                    className={
                                      rFlat
                                        ? "flex items-baseline gap-2 mb-0.5 flex-wrap"
                                        : `flex items-baseline gap-1.5 mb-1 ${rIsOwn ? "justify-end" : ""}`
                                    }
                                  >
                                    <span
                                      className="font-semibold text-[13.5px] leading-none"
                                      style={{ color: "var(--fg-1)" }}
                                    >
                                      {rIsOwn ? "我" : rLabel}
                                    </span>
                                    <span
                                      className="text-[11px] leading-none"
                                      style={{ color: "var(--fg-3)" }}
                                    >
                                      {rTime}
                                    </span>
                                  </div>
                                  {(() => {
                                    // Unified reply-quote rendering for the
                                    // rFlat (channel-list reply) path. Source
                                    // of truth = the `> [Author]: snippet`
                                    // prefix on the message text, set by the
                                    // reply UI. We strip it from the body
                                    // and surface it as .an-reply-quote so
                                    // the visual exactly matches the topic-
                                    // view and own-bubble paths.
                                    const rq = parseQuotePrefix(rDisplay);
                                    if (!rq) return null;
                                    return (
                                      <div
                                        className="an-reply-quote"
                                        title={`回复 ${rq.label}`}
                                      >
                                        <span className="an-rq-arrow">↪</span>
                                        <span className="an-rq-name">
                                          {rq.label}
                                        </span>
                                        <span className="an-rq-snip">
                                          {rq.quote.replace(/\s+/g, " ").trim()}
                                        </span>
                                      </div>
                                    );
                                  })()}
                                  {renderFileAttachments(r)}
                                  <div
                                    className={
                                      rFlat
                                        ? ""
                                        : `rounded-2xl px-3.5 py-2 text-[14px] leading-relaxed ${
                                            rIsOwn
                                              ? "text-white rounded-tr-sm"
                                              : "rounded-tl-sm"
                                          }`
                                    }
                                    style={
                                      rFlat
                                        ? {
                                            fontSize: "var(--fs-chat-body)",
                                            lineHeight:
                                              "var(--lh-chat-body)",
                                            color: "var(--fg-1)",
                                            wordWrap: "break-word",
                                          }
                                        : rIsOwn
                                          ? { background: "var(--accent)" }
                                          : {
                                              background:
                                                "var(--surface-soft)",
                                              color: "var(--fg-1)",
                                              border:
                                                "1px solid var(--border)",
                                            }
                                    }
                                  >
                                    {activeAgentBridgeTaskData(r) ? (
                                      renderAgentBridgeTaskCard(r)
                                    ) : r._streaming && !rTextRaw ? (
                                      <span className="inline-block w-2 h-4 bg-gray-400 rounded-sm animate-pulse align-middle" />
                                    ) : (
                                      <ChatMessageRenderer
                                        content={
                                          // Drop the `> [Author]: …\n\n` prefix
                                          // (now rendered above as an
                                          // .an-reply-quote) so the body shows
                                          // only the actual content.
                                          parseQuotePrefix(rDisplay)?.rest ?? rDisplay
                                        }
                                        keyPrefix={`${r.msg_id}-`}
                                        streaming={!!r._streaming}
                                        showStreamingCursor={false}
                                        onImageClick={handleMarkdownImageClick}
                                        onFileClick={handleMarkdownFileClick}
                                      />
                                    )}
                                    {r._streaming && !!rTextRaw && (
                                      <span className="inline-block w-1.5 h-4 bg-gray-400 rounded-sm animate-pulse align-middle ml-0.5" />
                                    )}
                                    {renderStopStreamButton(r)}
                                    {renderPartialBadge(r)}
                                  </div>
                                  {renderBotTraceStatus(r)}
                                  {rClarifyStatus !== null && selectedId && (
                                    <ClarifyInlineBlock
                                      msgId={r.msg_id}
                                      schema={rClarify!}
                                      status={rClarifyStatus}
                                      replyContent={undefined}
                                      onContinue={(answers) =>
                                        handleClarifyContinue(
                                          r.msg_id,
                                          rClarify!,
                                          answers,
                                        )
                                      }
                                      onSkip={() => handleClarifySkip(r.msg_id)}
                                    />
                                  )}
                                </div>
                                <div className="opacity-0 group-hover:opacity-100 transition-opacity self-start flex items-center gap-1 flex-shrink-0">
                                  <button
                                    type="button"
                                    title="复制消息内容"
                                    onClick={() => copyMessageText(r)}
                                    className="an-chat-action"
                                  >
                                    <AppIcon name="copy" className="w-3.5 h-3.5" />
                                  </button>
                                  {renderMemoryLoadButton(r)}
                                  <button
                                    type="button"
                                    title="回复"
                                    onClick={() => {
                                      setReplyingTo(r);
                                      const mention =
                                        r.sender_type === "bot" && rBot?.username
                                          ? `@${rBot.username} `
                                          : "";
                                      if (mention) setComposerInput(mention);
                                      (secretMode
                                        ? secretInputRef.current
                                        : inputRef.current
                                      )?.focus();
                                    }}
                                    className="an-chat-action"
                                  >
                                    <AppIcon name="reply" className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                              </div>
                          );
                          };
                          return (
                            <div key={m.msg_id}>
                              {rootBubble}
                              {replies.map(renderReplyRow)}
                            </div>
                          );
                        }

                        // ≥ TOPIC_DISPLAY_THRESHOLD replies — Collapsed topic
                        // card (overview) ───────────────────────────────────────
                        // Compact form: stacked participant avatars + summary.
                        // No full question/last-reply preview — click to expand.
                        if (!isExpanded) {
                          const titleSummary =
                            (m.content_data?.title as string | undefined) ||
                            displayContent
                              .replace(/\s+/g, " ")
                              .trim()
                              .slice(0, 80) ||
                            "(无标题)";
                          // Participants = root sender ∪ all unique reply
                          // senders. Keep insertion order so the root comes
                          // first and reads as the "owner" of the topic.
                          type Participant = {
                            key: string;
                            kind: "user" | "bot";
                            label: string;
                            color: string;
                            avatarUrl?: string;
                            initial: string;
                            isSelf?: boolean;
                          };
                          const addParticipant = (
                            acc: Participant[],
                            sid: string,
                            stype: string,
                          ) => {
                            const key = `${stype}:${sid}`;
                            if (acc.some((p) => p.key === key)) return;
                            if (stype === "bot") {
                              const b = botById.get(sid);
                              const label =
                                b?.display_name || b?.username || "Bot";
                              acc.push({
                                key,
                                kind: "bot",
                                label,
                                color: "var(--green)",
                                avatarUrl: b?.avatar_url,
                                initial: label.slice(0, 1).toUpperCase(),
                              });
                            } else {
                              const isSelf = sid === currentUserId;
                              const u = isSelf
                                ? null
                                : userById.get(sid);
                              const label = isSelf
                                ? "我"
                                : u?.display_name ||
                                  u?.username ||
                                  "用户";
                              acc.push({
                                key,
                                kind: "user",
                                label,
                                color: isSelf
                                  ? "var(--accent)"
                                  : "var(--fg-3)",
                                avatarUrl: isSelf
                                  ? currentUser?.avatar_url || undefined
                                  : u?.avatar_url || undefined,
                                initial: isSelf
                                  ? "我"
                                  : label.slice(0, 1).toUpperCase(),
                                isSelf,
                              });
                            }
                          };
                          const participants: Participant[] = [];
                          addParticipant(
                            participants,
                            m.sender_id,
                            m.sender_type,
                          );
                          for (const r of replies) {
                            addParticipant(
                              participants,
                              r.sender_id,
                              r.sender_type,
                            );
                          }
                          const visibleAvatars = participants.slice(0, 5);
                          const extraCount =
                            participants.length - visibleAvatars.length;

                          return (
                            <div
                              key={m.msg_id}
                              id={`msg-${m.msg_id}`}
                              className="an-chat-msg pl-16 my-1.5"
                            >
                              <button
                                type="button"
                                onClick={() => toggleTopic(m.msg_id)}
                                className="an-topic-chip"
                                title={titleSummary}
                              >
                                <span className="an-topic-chip-faces">
                                  {visibleAvatars.map((p) =>
                                    p.avatarUrl ? (
                                      <img
                                        key={p.key}
                                        src={p.avatarUrl}
                                        alt={p.label}
                                        className="an-topic-chip-face"
                                      />
                                    ) : (
                                      <span
                                        key={p.key}
                                        className="an-topic-chip-face"
                                        style={{ background: p.color }}
                                      >
                                        {p.initial}
                                      </span>
                                    ),
                                  )}
                                  {extraCount > 0 && (
                                    <span
                                      className="an-topic-chip-face"
                                      style={{
                                        background: "var(--bg-2)",
                                        color: "var(--fg-2)",
                                      }}
                                    >
                                      +{extraCount}
                                    </span>
                                  )}
                                </span>
                                <span className="an-topic-chip-body">
                                  <span className="an-topic-chip-title">
                                    {titleSummary}
                                  </span>
                                  <span className="an-topic-chip-meta">
                                    主题 · {replies.length + 1} 条消息 ·{" "}
                                    {participants.length} 人参与
                                  </span>
                                </span>
                                <span className="an-topic-chip-open">
                                  展开 ›
                                </span>
                              </button>
                            </div>
                          );
                        }

                        // ── Expanded topic card ───────────────────────────────
                        return (
                          <div
                            key={m.msg_id}
                            id={`msg-${m.msg_id}`}
                            className="an-chat-msg pl-16 my-1.5"
                          >
                          <div
                            className="rounded-xl border border-[#1264A3]/30 bg-gray-100 shadow-sm overflow-hidden"
                          >
                            {/* Topic header */}
                            <div className="flex items-center justify-between px-3 py-2 bg-[#1264A3]/5 border-b border-[#1264A3]/10">
                              <div className="flex items-center gap-1.5">
                                <AppIcon name="messageCircle" className="w-3.5 h-3.5 text-[#1264A3]" />
                                <span className="text-[12px] font-medium text-[#1264A3]">
                                  主题 · {replies.length + 1} 条消息
                                </span>
                              </div>
                              <div className="flex items-center gap-1">
                                <button
                                  type="button"
                                  onClick={() => setPageTopicId(m.msg_id)}
                                  className="flex items-center gap-1 text-[11px] text-gray-500 hover:text-[#1264A3] px-1.5 py-0.5 rounded hover:bg-white/80 transition-colors"
                                  title="以独立页打开主题"
                                >
                                  <AppIcon name="externalLink" className="w-3 h-3" />
                                  独立页打开
                                </button>
                                <button
                                  type="button"
                                  onClick={() => toggleTopic(m.msg_id)}
                                  className="flex items-center gap-1 text-[11px] text-gray-500 hover:text-gray-700 px-1.5 py-0.5 rounded hover:bg-white/80 transition-colors"
                                >
                                  <AppIcon name="chevronUp" className="w-3 h-3" />
                                  收起
                                </button>
                              </div>
                            </div>
                            {/* Root message */}
                            {rootBubble}
                            {/* Replies divider */}
                            <div className="flex items-center gap-2 px-4 py-1">
                              <div className="flex-1 h-px bg-gray-200" />
                              <span className="text-[11px] text-gray-400 whitespace-nowrap">
                                {replies.length} 条回复
                              </span>
                              <div className="flex-1 h-px bg-gray-200" />
                            </div>
                            {/* Reply messages */}
                            <div className="flex flex-col gap-0.5 pb-1.5">
                              {replies.map((r) => {
                                const rIsOwn =
                                  r.sender_type === "user" &&
                                  r.sender_id === currentUserId;
                                const rBot =
                                  r.sender_type === "bot"
                                    ? botById.get(r.sender_id)
                                    : undefined;
                                const rSenderUser =
                                  r.sender_type === "user" && !rIsOwn
                                    ? userById.get(r.sender_id)
                                    : undefined;
                                const rLabel = rBot
                                  ? rBot.display_name || rBot.username || "Bot"
                                  : rIsOwn
                                    ? "我"
                                    : rSenderUser?.display_name ||
                                      rSenderUser?.username ||
                                      "用户";
                                const rInitials = rLabel
                                  .slice(0, 2)
                                  .toUpperCase();
                                const rTime = r.created_at
                                  ? new Date(r.created_at).toLocaleTimeString(
                                      "zh-CN",
                                      { hour: "2-digit", minute: "2-digit" },
                                    )
                                  : "";
                                const {
                                  text: rTextRaw,
                                  clarify: rClarify,
                                } = parseHelperPayload(r.content);
                                const rDisplay = (() => {
                                  const base = isClarifyReplyUserMessage(r.content)
                                    ? r.content
                                        .replace(
                                          /^@(?:Helper|Coordinator|channel bot|引导)\s*澄清回答[：:]\s*/i,
                                          "",
                                        )
                                        .trim()
                                    : rTextRaw || r.content;
                                  return r.sender_type === "bot"
                                    ? stripLeadingQuotePrefixes(base)
                                    : base;
                                })();
                                const rClarifyAnswered =
                                  !!rClarify &&
                                  clarifyAnsweredParentIds.has(r.msg_id);
                                const rClarifyWaiting =
                                  pendingClarifyReplyMsgId === r.msg_id;
                                const rClarifyStatus:
                                  | "form"
                                  | "waiting"
                                  | "answered"
                                  | null =
                                  rClarify && r.sender_type === "bot"
                                    ? rClarifyWaiting
                                      ? "waiting"
                                      : rClarifyAnswered
                                        ? "answered"
                                        : "form"
                                    : null;
                                const rDirectParent =
                                  r.in_reply_to_msg_id !== m.msg_id
                                    ? msgById.get(r.in_reply_to_msg_id || "")
                                    : null;
                                const rParentBot =
                                  rDirectParent?.sender_type === "bot"
                                    ? botById.get(rDirectParent.sender_id)
                                    : null;
                                const rParentSenderUser =
                                  rDirectParent?.sender_type === "user" &&
                                  rDirectParent.sender_id !== currentUserId
                                    ? userById.get(rDirectParent.sender_id)
                                    : undefined;
                                const rParentLabel = rDirectParent
                                  ? rDirectParent.sender_type === "bot"
                                    ? rParentBot?.display_name ||
                                      rParentBot?.username ||
                                      "Bot"
                                    : rDirectParent.sender_id === currentUserId
                                      ? "我"
                                      : rParentSenderUser?.display_name ||
                                        rParentSenderUser?.username ||
                                        "用户"
                                  : null;
                                const rCollapsed = collapsedMessages.has(
                                  r.msg_id,
                                );
                                const rPreview =
                                  rDisplay.replace(/\s+/g, " ").slice(0, 10) +
                                  (rDisplay.length > 10 ? "…" : "");
                                return (
                                  <div
                                    key={r.msg_id}
                                    id={`msg-${r.msg_id}`}
                                    className="group/tr flex items-start gap-2 px-3 py-1"
                                  >
                                    {r.sender_type === "bot" ? (
                                      rBot?.avatar_url ? (
                                        <img
                                          src={rBot.avatar_url}
                                          alt={rLabel}
                                          className="w-6 h-6 rounded-lg object-cover flex-shrink-0 mt-0.5"
                                        />
                                      ) : (
                                        <div className="w-6 h-6 rounded-lg bg-[#2EB67D] flex items-center justify-center text-white text-[10px] font-bold select-none flex-shrink-0 mt-0.5">
                                          {rInitials}
                                        </div>
                                      )
                                    ) : (
                                      <div
                                        className={`w-6 h-6 rounded-lg flex items-center justify-center text-white text-[10px] font-bold select-none flex-shrink-0 mt-0.5 ${rIsOwn ? "bg-[#1264A3]" : "bg-gray-400"}`}
                                      >
                                        {rIsOwn ? "我" : rInitials}
                                      </div>
                                    )}
                                    <div className="flex-1 min-w-0">
                                      <div className="flex items-baseline gap-1.5 mb-0.5 flex-wrap">
                                        <span className="font-semibold text-[12px] text-gray-900">
                                          {rLabel}
                                        </span>
                                        {r.sender_type === "bot" && (
                                          <span className="text-[9px] px-1 py-0.5 rounded bg-[#2EB67D]/10 text-[#2EB67D] font-medium">
                                            Bot
                                          </span>
                                        )}
                                        <span className="text-[11px] text-gray-400">
                                          {rTime}
                                        </span>
                                        {rCollapsed && (
                                          <span className="text-[11px] text-gray-400 truncate max-w-[120px]">
                                            {rPreview}
                                          </span>
                                        )}
                                        <button
                                          type="button"
                                          onClick={() =>
                                            toggleMessage(r.msg_id)
                                          }
                                          className="opacity-0 group-hover/tr:opacity-100 transition-opacity ml-0.5 flex items-center justify-center w-4 h-4 rounded hover:bg-gray-200 text-gray-400 hover:text-gray-600 flex-shrink-0"
                                          title={rCollapsed ? "展开" : "折叠"}
                                        >
                                          {rCollapsed ? (
                                            <AppIcon name="chevronDown" className="w-3 h-3" />
                                          ) : (
                                            <AppIcon name="chevronUp" className="w-3 h-3" />
                                          )}
                                        </button>
                                      </div>
                                      {!rCollapsed && rDirectParent && rParentLabel && (
                                        <button
                                          type="button"
                                          className="an-reply-quote"
                                          onClick={() => {
                                            const el = document.getElementById(
                                              `msg-${rDirectParent.msg_id}`,
                                            );
                                            if (!el) return;
                                            el.scrollIntoView({
                                              block: "center",
                                              behavior: "smooth",
                                            });
                                            const origT = el.style.transition;
                                            const prevBg = el.style.background;
                                            el.style.transition =
                                              "background 200ms";
                                            el.style.background =
                                              "var(--accent-muted)";
                                            setTimeout(() => {
                                              el.style.background = prevBg;
                                              el.style.transition = origT;
                                            }, 1200);
                                          }}
                                          title="跳转到被回复的消息"
                                        >
                                          <span className="an-rq-arrow">↪</span>
                                          <span className="an-rq-name">
                                            {rParentLabel}
                                          </span>
                                          <span className="an-rq-snip">
                                            {(
                                              rDirectParent.content || ""
                                            )
                                              .replace(/<think>[\s\S]*?<\/think>/g, "")
                                              .replace(/\s+/g, " ")
                                              .trim()
                                              .slice(0, 80) ||
                                              "(无内容)"}
                                          </span>
                                        </button>
                                      )}
                                      {!rCollapsed && (
                                        <>
                                          {renderFileAttachments(r)}
                                          <div
                                            className={`rounded-xl px-2.5 py-1.5 text-[13px] leading-relaxed ${rIsOwn ? "whitespace-pre-wrap break-words" : ""}`}
                                            style={
                                              rIsOwn
                                                ? {
                                                    background:
                                                      "var(--accent-muted)",
                                                    color: "var(--fg-1)",
                                                  }
                                                : {
                                                    background:
                                                      "var(--surface-soft)",
                                                    color: "var(--fg-1)",
                                                    border:
                                                      "1px solid var(--border)",
                                                  }
                                            }
                                          >
                                            {r._streaming && !rTextRaw ? (
                                              <span className="inline-block w-2 h-4 bg-gray-400 rounded-sm animate-pulse align-middle" />
                                            ) : (
                                              <ChatMessageRenderer
                                                content={rDisplay}
                                                keyPrefix={`${r.msg_id}-t-`}
                                                streaming={!!r._streaming}
                                                showStreamingCursor={false}
                                                onImageClick={handleMarkdownImageClick}
                                                onFileClick={handleMarkdownFileClick}
                                              />
                                            )}
                                            {r._streaming && !!rTextRaw && (
                                              <span className="inline-block w-1.5 h-4 bg-gray-400 rounded-sm animate-pulse align-middle ml-0.5" />
                                            )}
                                            {renderStopStreamButton(r)}
                                            {renderPartialBadge(r)}
                                          </div>
                                          {renderBotTraceStatus(r)}
                                          {rClarifyStatus !== null &&
                                            selectedId && (
                                              <ClarifyInlineBlock
                                                msgId={r.msg_id}
                                                schema={rClarify!}
                                                status={rClarifyStatus}
                                                replyContent={undefined}
                                                onContinue={(answers) =>
                                                  handleClarifyContinue(
                                                    r.msg_id,
                                                    rClarify!,
                                                    answers,
                                                  )
                                                }
                                                onSkip={() =>
                                                  handleClarifySkip(r.msg_id)
                                                }
                                              />
                                            )}
                                        </>
                                      )}
                                    </div>
                                    <div className="opacity-0 group-hover/tr:opacity-100 transition-opacity self-center flex items-center gap-1 flex-shrink-0">
                                      {renderMemoryLoadButton(r)}
                                      <button
                                        type="button"
                                        title="回复"
                                        onClick={() => {
                                          setReplyingTo(r);
                                          const mention =
                                            r.sender_type === "bot" &&
                                            rBot?.username
                                              ? `@${rBot.username} `
                                              : "";
                                          if (mention) setComposerInput(mention);
                                          (secretMode
                                            ? secretInputRef.current
                                            : inputRef.current
                                          )?.focus();
                                        }}
                                        className="w-6 h-6 flex items-center justify-center rounded-full hover:bg-gray-200 text-gray-400 hover:text-gray-600 flex-shrink-0"
                                      >
                                        <AppIcon name="reply" className="w-3 h-3" />
                                      </button>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                            {/* Bottom collapse button */}
                            <div className="flex justify-center py-1.5 border-t border-gray-100">
                              <button
                                type="button"
                                onClick={() => toggleTopic(m.msg_id)}
                                className="flex items-center gap-1 text-[11px] text-gray-400 hover:text-gray-600 px-2 py-0.5 rounded hover:bg-gray-100 transition-colors"
                              >
                                <AppIcon name="chevronUp" className="w-3 h-3" />
                                收起主题
                              </button>
                            </div>
                          </div>
                          </div>
                        );
                      });
                      return (
                        <div
                          style={{
                            height: rowVirtualizer.getTotalSize(),
                            position: "relative",
                            width: "100%",
                          }}
                        >
                          {virtualItems.map((virtualItem, i) => {
                            const m = topicRoots[virtualItem.index];
                            if (!m) return null;
                            const day = formatDayLabel(m.created_at);
                            const prevDay =
                              virtualItem.index > 0
                                ? formatDayLabel(
                                    topicRoots[virtualItem.index - 1]?.created_at,
                                  )
                                : "";
                            return (
                              <div
                                key={virtualItem.key}
                                ref={rowVirtualizer.measureElement}
                                data-index={virtualItem.index}
                                style={{
                                  position: "absolute",
                                  top: 0,
                                  left: 0,
                                  width: "100%",
                                  transform: `translateY(${virtualItem.start}px)`,
                                }}
                              >
                                {day && day !== prevDay ? (
                                  <div
                                    key={`day-${virtualItem.index}-${day}`}
                                    className="an-day-divider"
                                  >
                                    <span>{day}</span>
                                  </div>
                                ) : null}
                                {renderedRows[i]}
                              </div>
                            );
                          })}
                        </div>
                      );
                      })()}
                      {Object.entries(processingBots).map(
                        ([botId, username]) => (
                          <div key={botId} className="an-chat-msg flex gap-3 px-3 py-2">
                            <div className="w-9 h-9 rounded-xl bg-[#2EB67D]/20 flex items-center justify-center text-[#2EB67D] text-sm font-bold flex-shrink-0">
                              {username.slice(0, 1).toUpperCase()}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-baseline gap-2 mb-1">
                                <span className="font-semibold text-[14px] text-gray-900">
                                  {username}
                                </span>
                                <span className="text-[11px] px-1.5 py-0.5 rounded-md bg-[#2EB67D]/10 text-[#2EB67D] font-medium">
                                  Bot
                                </span>
                              </div>
                              <div className="flex items-center gap-1.5 text-[13px] text-gray-400">
                                <span className="inline-flex gap-0.5">
                                  <span
                                    className="w-1.5 h-1.5 rounded-full bg-gray-300 animate-bounce"
                                    style={{ animationDelay: "0ms" }}
                                  />
                                  <span
                                    className="w-1.5 h-1.5 rounded-full bg-gray-300 animate-bounce"
                                    style={{ animationDelay: "150ms" }}
                                  />
                                  <span
                                    className="w-1.5 h-1.5 rounded-full bg-gray-300 animate-bounce"
                                    style={{ animationDelay: "300ms" }}
                                  />
                                </span>
                                正在输入...
                              </div>
                            </div>
                          </div>
                        ),
                      )}
                    </div>
                  )}
                </div>

                {/* Input area — visually floating: rounded, drop shadow, a
                    little margin so the stream slides past the edges. */}
                <div
                  className="flex-shrink-0 px-3 sm:px-4 pb-4 pt-2"
                  style={{
                    paddingBottom: "max(1rem, env(safe-area-inset-bottom))",
                  }}
                >
                  <MessageComposer
                    value={input}
                    valueRevision={inputRevision}
                    inputRef={inputRef}
                    onValueChange={handleComposerValueChange}
                    onSend={send}
                    canSend={pendingFileIds.length > 0}
                    canSendPredicate={(value) =>
                      Boolean(value.trim() || pendingFileIds.length > 0)
                    }
                    disabled={isSystemDm}
                    placeholder={
                      isSystemDm
                        ? "好友通知会话用于处理申请，不能直接发送消息…"
                        : secretMode
                          ? "输入加密内容（仅 Bot 可读取原文）…"
                          : isDmSelected
                            ? `发消息给 ${activeDm?.counterparty.display_name || activeDm?.counterparty.username || "DM"}…`
                          : msgKind === "announcement"
                            ? `发布公告到 #${selectedChannel?.name || "频道"}…`
                            : msgKind === "topic"
                              ? "开启主题 · 标题将取首行…"
                              : `发消息到 #${selectedChannel?.name || "频道"}，@ 呼叫 Bot…`
                    }
                    kind={msgKind}
                    onKindChange={setMsgKind}
                    onCycleKind={cycleMsgKind}
                    showKindSwitcher={!replyingTo && !isDmSelected}
                    enableKindCycling={!replyingTo && !isDmSelected}
                    titleValue={composerTitle}
                    titleRef={composerTitleRef}
                    onTitleChange={setComposerTitle}
                    channelBots={channelBots}
                    channelUsers={channelUsers}
                    replyingTo={replyingTo}
                    onCancelReply={() => setReplyingTo(null)}
                    pendingFiles={pendingFileNames.map((name, index) => ({
                      name,
                      previewUrl: pendingFilePreviews[index] ?? null,
                    }))}
                    onRemovePendingFile={(index) => {
                      setPendingFileIds((prev) =>
                        prev.filter((_, itemIndex) => itemIndex !== index),
                      );
                      setPendingFileNames((prev) =>
                        prev.filter((_, itemIndex) => itemIndex !== index),
                      );
                      setPendingFilePreviews((prev) =>
                        prev.filter((_, itemIndex) => itemIndex !== index),
                      );
                    }}
                    onUploadFile={uploadFile}
                    keychainEnabled={Boolean(currentUser)}
                    keychainOpen={keychainPopupOpen}
                    keychainLoading={keychainPopupLoading}
                    keychainItems={keychainPopupItems}
                    onToggleKeychain={openKeychainPopup}
                    onCloseKeychain={() => setKeychainPopupOpen(false)}
                  />
                </div>
              </>
            ) : (
              <div className="flex-1 flex flex-col">
                {isMobile && (
                  <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-3 flex-shrink-0">
                    <button
                      type="button"
                      onClick={() => setSidebarOpen(true)}
                      className="w-8 h-8 flex items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 flex-shrink-0"
                    >
                      <AppIcon name="menu" className="w-6 h-6" />
                    </button>
                    <span className="text-sm font-semibold text-gray-700">
                      智枢协作
                    </span>
                  </div>
                )}
                <div className="flex-1 flex flex-col items-center justify-center text-center p-8">
                  <div className="w-20 h-20 rounded-3xl bg-gray-100 flex items-center justify-center mb-5">
                    <AppIcon name="messageCircle" className="w-10 h-10 text-gray-300" />
                  </div>
                  <p className="text-gray-700 text-[15px] font-semibold">
                    选择一个频道
                  </p>
                  <p className="text-gray-400 text-[13px] mt-1.5">
                    从左侧选择频道开始对话，或{" "}
                    <span className="text-[#1264A3]">创建新频道</span>
                  </p>
                </div>
              </div>
            )}
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
