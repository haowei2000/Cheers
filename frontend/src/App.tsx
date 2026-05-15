import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";
import { useTheme } from "./useTheme";
import { useAuth } from "./hooks/useAuth";
import { useResize } from "./hooks/useResize";
import { AppIcon } from "./components/icons/AppIcon";
import { Sidebar } from "./components/Sidebar";
import { ImageLightbox } from "./components/ImageLightbox";
import { ChatAttachments } from "./components/ChatMessageRenderer";
import type { MemoryTab } from "./components/ChannelHeader";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { AppModals } from "./components/app/AppModals";
import { ChannelMainFrame } from "./components/app/ChannelMainFrame";
import { ChatShell } from "./components/app/ChatShell";
import { ChatSidePanels } from "./components/app/ChatSidePanels";
import { ChatWorkspaceView } from "./features/chat/ChatWorkspaceView";
import { useChannelMessages } from "./features/chat/hooks/useChannelMessages";
import { useChannelParticipants } from "./features/chat/hooks/useChannelParticipants";
import { useChatRealtime } from "./features/chat/hooks/useChatRealtime";
import { useComposerController } from "./features/chat/hooks/useComposerController";
import { usePendingFiles } from "./features/chat/hooks/usePendingFiles";
import { useWorkspaceDirectory } from "./features/chat/hooks/useWorkspaceDirectory";
import { AgentBridgeTaskCard } from "./features/chat/messages/AgentBridgeTaskCard";
import { apiFetch } from "./api";
import { parseHelperPayload } from "./lib/helper";
import { API, API_DOCS_URL } from "./lib/app-config";
import { applyDensity, getStoredDensity } from "./lib/density";
import {
  getActiveAgentBridgeTaskData,
  getAgentBridgeTaskData,
  type AgentBridgeTaskMessage,
} from "./lib/agent-bridge";
import {
  buildChatPath,
  buildChatSearch,
  readChatUrlState,
  type ChatRouteParams,
} from "./lib/chat-routing";
import {
  MAX_LOADED_MESSAGES,
  VIRTUAL_MESSAGE_ESTIMATED_HEIGHT,
} from "./lib/message-window";
import {
  patchMessage,
  upsertMessage,
} from "./lib/message-store";
import type {
  Message,
  FileInfo,
  ContextData,
  ClarifySchema,
  ClarifyAnswers,
  AgentBridgeTaskContentData,
  MemoryLoadDetail,
} from "./types";
import { OTHER_CHOICE_ID } from "./types";

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

  const [settingsOpen, setSettingsOpen] = useState(false);
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
  const {
    channels,
    setChannels,
    dms,
    setDMs,
    workspaces,
    setWorkspaces,
    selectedWorkspaceId,
    setSelectedWorkspaceId,
    selectedId,
    setSelectedId,
    selectedIdRef,
    selectedIdWorkspaceId,
    selectedChannel,
    isPersonalWorkspace,
    activeDm,
    isSystemDm,
    isDmSelected,
    activeBotDm,
    activeDmSessionScopeId,
    createWsOpen,
    setCreateWsOpen,
    createChannelOpen,
    setCreateChannelOpen,
    newWorkspaceName,
    setNewWorkspaceName,
    newWorkspaceAvatarUrl,
    setNewWorkspaceAvatarUrl,
    inviteWsMemberOpen,
    setInviteWsMemberOpen,
    inviteWsIdentifier,
    setInviteWsIdentifier,
    newChannelName,
    setNewChannelName,
    handleCreateWorkspace,
    inviteWorkspaceMember,
    handleInviteWsMember,
    handleCreateChannel,
    openDirectMessage,
    botMentionIdsForChannel,
    getWorkspaceIdForChannel,
    resetDirectory,
  } = useWorkspaceDirectory({
    routeWorkspaceId,
    routeChannelId,
    authToken,
    authFetch,
    currentUserId,
    onCloseSettings: () => setSettingsOpen(false),
  });
  const selectionResetReadyRef = useRef(false);
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
  const [memoryDetailMessage, setMemoryDetailMessage] = useState<Message | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
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
  const {
    autoAssist,
    setAutoAssist,
    channelBots,
    channelUsers,
    allBots,
    selectedBotIds,
    setSelectedBotIds,
    addingBots,
    setAddingBots,
    addBotToChannel,
    removeBotFromChannel,
  } = useChannelParticipants({
    selectedId,
    channels,
    addBotOpen,
    authToken,
    authFetch,
    selectedIdRef,
  });
  const [channelSettingsOpen, setChannelSettingsOpen] = useState(false);
  const [notifPanelOpen, setNotifPanelOpen] = useState(false);
  const pendingScrollMsgIdRef = useRef<string | null>(null);
  const [_expandedOlderIds, _setExpandedOlderIds] = useState<Set<string>>(
    new Set(),
  );
  const {
    setMessageStore,
    messages,
    setMessages,
    loading,
    hasMore,
    loadingMore,
    messagesContainerRef,
    handleMessagesScroll,
    topicRoots,
    topicRepliesOf,
    msgById,
    clarifyAnsweredParentIds,
    rowVirtualizer,
    virtualItems,
    pageTopicSourceMessages,
    pageTopicRepliesOf,
  } = useChannelMessages({
    selectedId,
    isDmSelected,
    authFetch,
    selectedIdRef,
    pendingScrollMsgIdRef,
    pageTopicMessages,
    setExpandedTopics,
  });
  const [processingBots, setProcessingBots] = useState<Record<string, string>>(
    {},
  );

  const [qcOpen, setQcOpen] = useState(false);


  const handleNotifNavigate = (channelId: string, msgId?: string) => {
    const workspaceId = getWorkspaceIdForChannel(channelId);
    if (workspaceId) setSelectedWorkspaceId(workspaceId);
    setSelectedId(channelId);
    if (msgId) pendingScrollMsgIdRef.current = msgId;
    setNotifPanelOpen(false);
  };

  const handleLogout = () => {
    clearAuth();
    resetDirectory();
    setMessages([]);
    setLoginModalOpen(true);
  };

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
      setProcessingBots({});
      setReplyingTo(null);
    }
  }, [selectedId, setReplyingTo]);

  useChatRealtime({
    selectedId,
    authFetch,
    setContextData,
    setMessageStore,
    setProcessingBots,
    reportClientError,
  });

  useEffect(() => {
    if (memoryPanelOpen && selectedId) {
      authFetch(`${API}/channels/${selectedId}/context`)
        .then((r) => r.json())
        .then((d) => d.data && setContextData(d.data))
        .catch(console.error);
    }
  }, [authFetch, memoryPanelOpen, selectedId]);

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
  const selectedDetailMessage = memoryDetailMessage
    ? msgById.get(memoryDetailMessage.msg_id) || memoryDetailMessage
    : null;
  const selectedMemoryLoadDetail = selectedDetailMessage
    ? getMemoryLoadDetail(selectedDetailMessage)
    : null;
  const selectedBotTraceEvents = selectedDetailMessage?._bot_trace || [];

  return (
    <>
      <AppModals
        loginModalOpen={loginModalOpen}
        currentUser={currentUser}
        onCloseLogin={() => setLoginModalOpen(false)}
        onLoginSuccess={(user, token) => {
          setAuth(user, token);
          setLoginModalOpen(false);
        }}
        selectedDetailMessage={selectedDetailMessage}
        selectedMemoryLoadDetail={selectedMemoryLoadDetail}
        selectedBotTraceEvents={selectedBotTraceEvents}
        onCloseMessageDetail={() => setMemoryDetailMessage(null)}
        helpOpen={helpOpen}
        onCloseHelp={() => setHelpOpen(false)}
        apiDocsUrl={API_DOCS_URL}
        settingsOpen={settingsOpen}
        onCloseSettings={() => setSettingsOpen(false)}
        isDark={isDark}
        setTheme={setTheme}
        authToken={authToken}
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
        qcOpen={qcOpen}
        onCloseQc={() => setQcOpen(false)}
        selectedId={selectedId}
        selectedChannel={selectedChannel}
        createWsOpen={createWsOpen}
        newWorkspaceName={newWorkspaceName}
        setNewWorkspaceName={setNewWorkspaceName}
        newWorkspaceAvatarUrl={newWorkspaceAvatarUrl}
        setNewWorkspaceAvatarUrl={setNewWorkspaceAvatarUrl}
        onCreateWorkspace={handleCreateWorkspace}
        onCloseCreateWorkspace={() => setCreateWsOpen(false)}
        inviteWsMemberOpen={inviteWsMemberOpen}
        inviteWsIdentifier={inviteWsIdentifier}
        selectedWorkspaceId={selectedWorkspaceId}
        setInviteWsIdentifier={setInviteWsIdentifier}
        onInviteWorkspaceMember={handleInviteWsMember}
        onPickWorkspaceUser={inviteWorkspaceMember}
        onCloseInviteWorkspaceMember={() => setInviteWsMemberOpen(false)}
        createChannelOpen={createChannelOpen}
        workspaces={workspaces}
        setSelectedWorkspaceId={setSelectedWorkspaceId}
        newChannelName={newChannelName}
        setNewChannelName={setNewChannelName}
        onCreateChannel={handleCreateChannel}
        onCloseCreateChannel={() => setCreateChannelOpen(false)}
        addBotOpen={addBotOpen}
        channelBots={channelBots}
        allBots={allBots}
        selectedBotIds={selectedBotIds}
        setSelectedBotIds={setSelectedBotIds}
        addingBots={addingBots}
        setAddingBots={setAddingBots}
        onCloseAddBot={() => setAddBotOpen(false)}
        onRemoveBot={removeBotFromChannel}
        onAddBotToChannel={addBotToChannel}
        notifPanelOpen={notifPanelOpen}
        onCloseNotifications={() => setNotifPanelOpen(false)}
        onNotificationNavigate={handleNotifNavigate}
        channelSettingsOpen={channelSettingsOpen}
        currentUserId={currentUserId}
        onCloseChannelSettings={() => setChannelSettingsOpen(false)}
        setChannels={setChannels}
        setAutoAssist={setAutoAssist}
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
