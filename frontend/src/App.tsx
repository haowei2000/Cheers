import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";
import { useTheme } from "./useTheme";
import { useAuth } from "./hooks/useAuth";
import { useResize } from "./hooks/useResize";
import { Sidebar } from "./components/Sidebar";
import { ImageLightbox } from "./components/ImageLightbox";
import { ForwardMessageModal } from "./components/ForwardMessageModal";
import { AppIcon } from "./components/icons/AppIcon";
import type { MemoryTab } from "./components/ChannelHeader";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { AppModals } from "./components/app/AppModals";
import { ChannelMainFrame } from "./components/app/ChannelMainFrame";
import { ChatShell } from "./components/app/ChatShell";
import { ChatSidePanels } from "./components/app/ChatSidePanels";
import { LazyPanelFallback } from "./components/app/LazyPanelFallback";
import { ChatWorkspaceView } from "./features/chat/ChatWorkspaceView";
import { useChannelMessages } from "./features/chat/hooks/useChannelMessages";
import { useChannelParticipants } from "./features/chat/hooks/useChannelParticipants";
import { useChatRealtime } from "./features/chat/hooks/useChatRealtime";
import { useComposerController } from "./features/chat/hooks/useComposerController";
import { useFilePreviewController } from "./features/chat/hooks/useFilePreviewController";
import { useMessagePresentation } from "./features/chat/hooks/useMessagePresentation";
import { usePendingFiles } from "./features/chat/hooks/usePendingFiles";
import { useWorkspaceDirectory } from "./features/chat/hooks/useWorkspaceDirectory";
import { apiFetch } from "./api";
import { parseHelperPayload } from "./lib/helper";
import { API, API_DOCS_URL, USER_DOCS_URL } from "./lib/app-config";
import { applyDensity, getStoredDensity } from "./lib/density";
import { refreshChannels, refreshDMs } from "./lib/refresh";
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
import { upsertMessage } from "./lib/message-store";
import type {
  Message,
  ContextData,
  ClarifySchema,
  ClarifyAnswers,
  FileInfo,
} from "./types";
import { OTHER_CHOICE_ID } from "./types";

type ForwardModalState = {
  mode: "single" | "topic";
  sourceMessageIds: string[];
  sourceFileIds: string[];
  summary: string;
};

type ComposerPromptTemplateOption = {
  template_id: string;
  name: string;
  description?: string | null;
  is_builtin?: boolean;
};

const MainFilePreviewPanel = lazy(() =>
  import("./components/FilePreviewSidebar").then((module) => ({
    default: module.FilePreviewPanel,
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

  // Best-effort client error reporting; never throw from this path.
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

  // Report globally unhandled promise rejections.
  useEffect(() => {
    const handler = (e: PromiseRejectionEvent) => {
      reportClientError("UNCAUGHT", window.location.href, 0, String(e.reason));
    };
    window.addEventListener("unhandledrejection", handler);
    return () => window.removeEventListener("unhandledrejection", handler);
  }, [reportClientError]);

  // Open the login modal during startup when no user is available.
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
  const [promptTemplates, setPromptTemplates] = useState<ComposerPromptTemplateOption[]>([]);
  const [promptTemplatesLoading, setPromptTemplatesLoading] = useState(false);
  const [selectedPromptTemplateId, setSelectedPromptTemplateId] = useState<string | null>(null);
  const selectedPromptTemplateIdRef = useRef<string | null>(null);
  const setPromptTemplateOverrideId = useCallback((templateId: string | null) => {
    selectedPromptTemplateIdRef.current = templateId;
    setSelectedPromptTemplateId(templateId);
  }, []);
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

  useEffect(() => {
    if (!authToken) {
      setPromptTemplates([]);
      setPromptTemplateOverrideId(null);
      return;
    }
    let active = true;
    setPromptTemplatesLoading(true);
    apiFetch("/templates", { token: authToken })
      .then((response) => response.json())
      .then((data) => {
        if (!active) return;
        const templates: ComposerPromptTemplateOption[] = Array.isArray(data?.data)
          ? data.data
          : [];
        setPromptTemplates(templates);
        const selectedId = selectedPromptTemplateIdRef.current;
        if (
          selectedId &&
          !templates.some((template) => template.template_id === selectedId)
        ) {
          setPromptTemplateOverrideId(null);
        }
      })
      .catch(() => {
        if (active) {
          setPromptTemplates([]);
          setPromptTemplateOverrideId(null);
        }
      })
      .finally(() => {
        if (active) setPromptTemplatesLoading(false);
      });
    return () => {
      active = false;
    };
  }, [authToken, setPromptTemplateOverrideId]);
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
  const canRefreshSessions = useMemo(() => {
    const userRole = currentUser?.role ?? "";
    if (userRole === "system_admin" || userRole === "space_admin") return true;
    if (selectedChannel?.can_manage) return true;
    const channelRole = selectedChannel?.my_role ?? "";
    return channelRole === "owner" || channelRole === "admin" || channelRole === "workspace_admin";
  }, [currentUser?.role, selectedChannel?.can_manage, selectedChannel?.my_role]);
  const selectionResetReadyRef = useRef(false);
  useEffect(() => {
    setPromptTemplateOverrideId(null);
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
  }, [isDmSelected, selectedId, setPromptTemplateOverrideId]);
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
  const [secretTokens, setSecretTokens] = useState<Record<string, string>>({}); // msg_id -> token, held only by the sender's current session.
  const [forwardModalState, setForwardModalState] =
    useState<ForwardModalState | null>(null);
  const [forwardSelectionMode, setForwardSelectionMode] = useState(false);
  const [selectedForwardMsgIds, setSelectedForwardMsgIds] = useState<string[]>(
    [],
  );
  const [forwardSubmitting, setForwardSubmitting] = useState(false);
  const [fileLibraryRefreshNonce, setFileLibraryRefreshNonce] = useState(0);
  const openForwardFile = useCallback((file: FileInfo) => {
    setForwardModalState({
      mode: "single",
      sourceMessageIds: [],
      sourceFileIds: [file.file_id],
        summary: `Forward file: ${file.original_filename || file.file_id}`,
    });
  }, []);
  const {
    lightboxSrc,
    lightboxFileId,
    setLightboxSrc,
    setLightboxFileId,
    filePreviewPanel,
    setFilePreviewPanel,
    mainFilePreviewPanel,
    setMainFilePreviewPanel,
    openFilePreview,
    openPersonalFilePreviewMain,
    handleMarkdownImageClick,
    handleMarkdownFileClick,
    renderFileAttachments,
  } = useFilePreviewController({ onForwardFile: openForwardFile });
  // Resizable panel widths.
  const [leftWidth, onLeftResize] = useResize(256, 160, 480, "right");
  const [memoryWidth, onMemoryResize] = useResize(288, 200, 600, "left");
  const [filePreviewWidth, onFilePreviewResize] = useResize(
    420,
    280,
    720,
    "left",
  );
  const openPersonalFileInMain = useCallback(
    (file: FileInfo) => {
      setSelectedId(null);
      setMemoryTab(null);
      setPageTopicId(null);
      setPageTaskMsgId(null);
      setTaskPageOpen(false);
      openPersonalFilePreviewMain(file);
    },
    [
      openPersonalFilePreviewMain,
      setMemoryTab,
      setPageTaskMsgId,
      setPageTopicId,
      setSelectedId,
      setTaskPageOpen,
    ],
  );
  const uploadPersonalFiles = useCallback(
    async (files: File[]) => {
      for (const file of files) {
        await uploadFileObject(file);
      }
      setFileLibraryRefreshNonce((value) => value + 1);
    },
    [uploadFileObject],
  );
  useEffect(() => {
    if (selectedId) setMainFilePreviewPanel(null);
  }, [selectedId, setMainFilePreviewPanel]);
  useEffect(() => {
    if (!isPersonalWorkspace) setMainFilePreviewPanel(null);
  }, [isPersonalWorkspace, setMainFilePreviewPanel]);

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
    restoringInitialScroll,
    hasMore,
    loadingMore,
    messagesContainerRef,
    handleMessagesScroll,
    topicRoots,
    topicRepliesOf,
    renderItems,
    msgById,
    clarifyAnsweredParentIds,
    rowVirtualizer,
    virtualItems,
    showJumpToBottom,
    jumpToBottom,
    pageTopicSourceMessages,
    pageTopicRepliesOf,
    preloadChannelMessages,
    ensureMessageLoaded,
  } = useChannelMessages({
    selectedId,
    isDmSelected,
    authFetch,
    selectedIdRef,
    pendingScrollMsgIdRef,
    pageTopicMessages,
    expandedTopics,
    setExpandedTopics,
  });
  const [processingBots, setProcessingBots] = useState<Record<string, string>>(
    {},
  );

  const [qcOpen, setQcOpen] = useState(false);

  const handleMessageNavigate = useCallback(
    (channelId: string, msgId?: string) => {
      const workspaceId = getWorkspaceIdForChannel(channelId);
      if (workspaceId) setSelectedWorkspaceId(workspaceId);
      if (msgId) {
        if (selectedIdRef.current === channelId) {
          void ensureMessageLoaded(msgId);
        } else {
          pendingScrollMsgIdRef.current = msgId;
        }
      }
      setSelectedId(channelId);
    },
    [
      ensureMessageLoaded,
      getWorkspaceIdForChannel,
      selectedIdRef,
      setSelectedId,
      setSelectedWorkspaceId,
    ],
  );

  const handleNotifNavigate = (channelId: string, msgId?: string) => {
    handleMessageNavigate(channelId, msgId);
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
        setPageTopicError("Failed to load topic messages");
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
      toast.error("Sign in before sending messages");
      return Promise.resolve();
    }
    if (isSystemDm) {
      toast.error("Friend notification conversations cannot send messages directly");
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
        // User messages normally arrive through WebSocket broadcasts; this is only a deduplicated fallback insert.
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
    const textContent = rawContent.trim();
    if (!selectedId || ((!textContent || textContent === "@") && pendingFileIds.length === 0)) return;
    if (!currentUserId) {
      setLoginModalOpen(true);
      toast.error("Sign in before sending messages");
      return;
    }
    if (isSystemDm) {
      toast.error("Friend notification conversations cannot send messages directly");
      return;
    }
    const targetChannelId = selectedId;
    const content = textContent;
    // Reply context is conveyed by `in_reply_to_msg_id` (rendered as a chip).
    // We intentionally do NOT prepend a markdown blockquote of the parent
    // message: that would duplicate what the chip already shows AND pollute
    // bot adapters' user-message text.
    const isSecretSend = msgKind === "secret";
    // Resolve msg_type: a pending reply-to always wins; otherwise use the
    // user's current msgKind pick from the composer switcher.
    const effectiveKind = isDmSelected
      ? "normal"
      : replyingTo
        ? "reply"
        : msgKind === "secret"
          ? "normal"
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
    const selectedPromptTemplateIdForSend = selectedPromptTemplateIdRef.current;
    const selectedPromptTemplate = selectedPromptTemplateIdForSend
      ? promptTemplates.find(
          (template) => template.template_id === selectedPromptTemplateIdForSend,
        )
      : null;
    if (selectedPromptTemplateIdForSend && !selectedPromptTemplate) {
      setPromptTemplateOverrideId(null);
    }
    if (effectiveKind === "announcement") {
      body.content_data = {
        pinned_by: currentUserId,
        ...(titleTrim ? { title: titleTrim } : {}),
      };
    } else if (effectiveKind === "topic") {
      body.content_data = titleTrim ? { title: titleTrim } : {};
    }
    if (selectedPromptTemplate) {
      body.content_data = {
        ...((body.content_data as Record<string, unknown> | undefined) || {}),
        prompt_template_override_id: selectedPromptTemplate.template_id,
        prompt_template_override_name: selectedPromptTemplate.name,
      };
    }
    resetComposerAfterSend();
    setPromptTemplateOverrideId(null);
    clearPendingFiles();
    authFetch(`${API}/channels/${targetChannelId}/messages`, {
      method: "POST",
      body: JSON.stringify(body),
    })
      .then((r) => r.json())
      .then((d) => {
        // User messages normally arrive through WebSocket broadcasts; this is only a deduplicated fallback insert.
        // Insert only while the user is still in the sending channel to avoid cross-channel leakage.
        if (d.data && selectedIdRef.current === targetChannelId) {
          setMessageStore((prev) =>
            prev.byId[d.data.msg_id]
              ? prev
              : upsertMessage(prev, d.data, MAX_LOADED_MESSAGES),
          );
          // Keep the secret token only in the sender's current session; it is never broadcast over WebSocket.
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
        toast.error(data?.detail || data?.message || "Failed to refresh DM sessions");
        return;
      }
      setDmSessionRefreshNonce((v) => v + 1);
      toast.success("DM sessions refreshed");
    } catch {
      toast.error("Failed to refresh DM sessions");
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
          toast.error(d.detail || "Cannot view encrypted content");
        }
      })
      .catch(() => toast.error("Request failed"));
  };

  // Copy a message's rendered text (stripping think-folds / helper payload
  // JSON) to the system clipboard. Best-effort — silently toasts failure.
  const copyMessageText = async (m: Message) => {
    const raw = parseHelperPayload(m.content || "").text || m.content || "";
    try {
      await navigator.clipboard.writeText(raw);
      toast.success("Copied");
    } catch {
      toast.error("Copy failed");
    }
  };

  const {
    getMemoryLoadDetail,
    hasBotReplyDetails,
    renderMemoryLoadButton,
    renderStopStreamButton,
    renderPartialBadge,
    renderBotTraceStatus,
    activeAgentBridgeTaskData,
    agentBridgeTaskMessages,
    renderAgentBridgeTaskCard,
  } = useMessagePresentation({
    selectedId,
    authToken,
    isDmSelected,
    messages,
    setMessageStore,
    onShowMessageDetails: setMemoryDetailMessage,
    onOpenAgentBridgeTask: (messageId) => {
      setPageTopicId(null);
      setPageTaskMsgId(messageId);
      setTaskPageOpen(true);
    },
  });

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

  const sendTopicReply = async (
    channelId: string,
    rootMsgId: string,
    text: string,
  ) => {
    const attachedFileIds = [...pendingFileIds];
    if (!text.trim() && attachedFileIds.length === 0) return;
    if (!currentUserId) {
      setLoginModalOpen(true);
      toast.error("Sign in before replying");
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
    const lines = ["@Coordinator clarification answer:"];
    const optText = answers.option_text || {};
    for (const q of schema.questions) {
      const picked = new Set(answers.selected[q.id] || []);
      const labels = q.options
        .filter((o) => picked.has(o.id))
        .map((o) => {
          const txt = (optText[`${q.id}:${o.id}`] || "").trim();
          return txt ? `${o.label}: ${txt}` : o.label;
        });
      if (picked.has(OTHER_CHOICE_ID)) {
        const other = (answers.other_text?.[q.id] || "").trim();
        if (other) labels.push(`Other: ${other}`);
      }
      lines.push(
        `- ${q.prompt}: ${labels.length > 0 ? labels.join(", ") : "Not selected"}`,
      );
    }
    setPendingClarifyReplyMsgId(msgId);
    sendUserMessage(lines.join("\n"), msgId).catch(() => {
      setPendingClarifyReplyMsgId(null);
      toast.error("Submit failed. Try again.");
    });
  };

  const handleClarifySkip = (msgId: string) => {
    setPendingClarifyReplyMsgId(msgId);
    sendUserMessage(
      "@Coordinator The user skipped clarification. Continue with the available context.",
      msgId,
    ).catch(() => {
      setPendingClarifyReplyMsgId(null);
      toast.error("Submit failed. Try again.");
    });
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
  const messagePreviewText = useCallback((message: Message): string => {
    const raw = parseHelperPayload(message.content || "").text || message.content || "";
    return (
      raw
        .replace(/<think>[\s\S]*?<\/think>/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 80) || "(No content)"
    );
  }, []);
  const forwardMessageById = useMemo(() => {
    const map = new Map<string, Message>();
    for (const message of pageTopicSourceMessages) {
      map.set(message.msg_id, message);
    }
    return map;
  }, [pageTopicSourceMessages]);
  const forwardWorkspaceId = selectedWorkspaceId || selectedIdWorkspaceId || null;

  const openForwardMessage = useCallback(
    (message: Message) => {
      if (message.is_secret) {
        toast.error("Encrypted messages cannot be forwarded");
        return;
      }
      setForwardModalState({
        mode: "single",
        sourceMessageIds: [message.msg_id],
        sourceFileIds: [],
        summary: `Forward 1 message: ${messagePreviewText(message)}`,
      });
    },
    [messagePreviewText],
  );

  const toggleForwardSelection = useCallback((message: Message) => {
    if (message.is_secret) {
      toast.error("Encrypted messages cannot be forwarded");
      return;
    }
    setForwardSelectionMode(true);
    setSelectedForwardMsgIds((prev) =>
      prev.includes(message.msg_id)
        ? prev.filter((id) => id !== message.msg_id)
        : [...prev, message.msg_id],
    );
  }, []);

  const cancelForwardSelection = useCallback(() => {
    setForwardSelectionMode(false);
    setSelectedForwardMsgIds([]);
  }, []);

  const openForwardSelectedTopic = useCallback(() => {
    const ids = selectedForwardMsgIds.filter((id) => forwardMessageById.has(id));
    if (ids.length === 0) {
      toast.error("Select messages to forward first");
      return;
    }
    setForwardModalState({
      mode: "topic",
      sourceMessageIds: ids,
      sourceFileIds: [],
      summary: `Forward ${ids.length} messages as a topic`,
    });
  }, [forwardMessageById, selectedForwardMsgIds]);

  const insertForwardedMessages = useCallback(
    (targetChannelId: string, created: unknown) => {
      if (selectedIdRef.current !== targetChannelId || !Array.isArray(created)) {
        return;
      }
      setMessageStore((prev) =>
        created.reduce(
          (store, item) =>
            item && typeof item === "object"
              ? upsertMessage(store, item as Message, MAX_LOADED_MESSAGES)
              : store,
          prev,
        ),
      );
    },
    [selectedIdRef, setMessageStore],
  );

  const postForwardToChannel = useCallback(
    async (targetChannelId: string, state: ForwardModalState) => {
      const res = await apiFetch(`/channels/${targetChannelId}/messages/forward`, {
        method: "POST",
        token: authToken,
        body: {
          source_message_ids: state.sourceMessageIds,
          source_file_ids: state.sourceFileIds,
          mode: state.mode,
        },
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || data?.status === "error") {
        throw new Error(data?.detail || data?.message || "Forward failed");
      }
      insertForwardedMessages(targetChannelId, data?.data?.messages);
    },
    [authToken, insertForwardedMessages],
  );

  const submitForwardToChannel = useCallback(
    async (targetChannelId: string) => {
      if (!forwardModalState) return;
      if (!authToken) {
        setLoginModalOpen(true);
        toast.error("Sign in before forwarding");
        return;
      }
      const state = forwardModalState;
      setForwardSubmitting(true);
      try {
        await postForwardToChannel(targetChannelId, state);
        toast.success(state.mode === "topic" ? "Forwarded as a bundle" : "Forwarded");
        setForwardModalState(null);
        cancelForwardSelection();
        refreshChannels(setChannels, authToken);
        refreshDMs(setDMs, authToken);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Forward failed");
      } finally {
        setForwardSubmitting(false);
      }
    },
    [
      authToken,
      cancelForwardSelection,
      forwardModalState,
      postForwardToChannel,
      setChannels,
      setDMs,
    ],
  );

  const submitForwardToMember = useCallback(
    async (memberId: string, memberType: "user" | "bot") => {
      if (!forwardModalState) return;
      if (!authToken) {
        setLoginModalOpen(true);
        toast.error("Sign in before forwarding");
        return;
      }
      const workspaceId =
        workspaces.find((workspace) => workspace.kind === "personal")
          ?.workspace_id ||
        forwardWorkspaceId ||
        selectedWorkspaceId;
      if (!workspaceId) {
        toast.error("Select a workspace first");
        return;
      }
      const state = forwardModalState;
      setForwardSubmitting(true);
      try {
        const dmRes = await apiFetch("dms", {
          method: "POST",
          token: authToken,
          body: {
            workspace_id: workspaceId,
            member_id: memberId,
            member_type: memberType,
          },
        });
        const dmData = await dmRes.json().catch(() => null);
        if (!dmRes.ok || dmData?.status === "error") {
          throw new Error(dmData?.detail || dmData?.message || "Failed to open DM");
        }
        const dm = dmData?.data;
        if (!dm?.channel_id) throw new Error("Failed to open DM");
        setDMs((prev) =>
          prev.some((item) => item.channel_id === dm.channel_id)
            ? prev.map((item) => (item.channel_id === dm.channel_id ? dm : item))
            : [...prev, dm],
        );
        await postForwardToChannel(dm.channel_id, state);
        toast.success(state.mode === "topic" ? "Forwarded as a bundle" : "Forwarded");
        setForwardModalState(null);
        cancelForwardSelection();
        refreshDMs(setDMs, authToken);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Forward failed");
      } finally {
        setForwardSubmitting(false);
      }
    },
    [
      authToken,
      cancelForwardSelection,
      forwardModalState,
      forwardWorkspaceId,
      postForwardToChannel,
      selectedWorkspaceId,
      setDMs,
      workspaces,
    ],
  );

  const renderForwardActionButtons = useCallback(
    (
      message: Message,
      actionClassName = "an-chat-action",
      iconClassName = "w-3.5 h-3.5",
    ) => {
      const selected = selectedForwardMsgIds.includes(message.msg_id);
      const selectedStyle = selected
        ? { background: "var(--accent-muted)", color: "var(--accent)" }
        : undefined;
      return (
        <>
          <button
            type="button"
            title={selected ? "Cancel selection" : "Select for combined forward"}
            aria-label={selected ? "Cancel selection" : "Select for combined forward"}
            onClick={(event) => {
              event.stopPropagation();
              toggleForwardSelection(message);
            }}
            className={actionClassName}
            style={selectedStyle}
          >
            <AppIcon
              name={selected ? "checkCircle" : "check"}
              className={iconClassName}
            />
          </button>
          <button
            type="button"
            title="Forward"
            aria-label="Forward"
            onClick={(event) => {
              event.stopPropagation();
              openForwardMessage(message);
            }}
            className={actionClassName}
          >
            <AppIcon name="forward" className={iconClassName} />
          </button>
        </>
      );
    },
    [openForwardMessage, selectedForwardMsgIds, toggleForwardSelection],
  );

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
        userDocsUrl={USER_DOCS_URL}
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

      <ForwardMessageModal
        open={Boolean(forwardModalState)}
        channels={channels}
        dms={dms}
        workspaces={workspaces}
        token={authToken}
        workspaceId={forwardWorkspaceId}
        summary={forwardModalState?.summary || ""}
        submitting={forwardSubmitting}
        onClose={() => {
          if (!forwardSubmitting) setForwardModalState(null);
        }}
        onForwardToChannel={submitForwardToChannel}
        onForwardToMember={submitForwardToMember}
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
            onOpenPersonalFileMain={openPersonalFileInMain}
            onUploadPersonalFiles={uploadPersonalFiles}
            fileLibraryRefreshKey={fileLibraryRefreshNonce}
            onPreloadChannel={preloadChannelMessages}
            onOpenMessage={handleMessageNavigate}
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
            {mainFilePreviewPanel && isPersonalWorkspace ? (
              <Suspense fallback={<LazyPanelFallback />}>
                <MainFilePreviewPanel
                  url={mainFilePreviewPanel.url}
                  filename={mainFilePreviewPanel.filename}
                  contentType={mainFilePreviewPanel.contentType}
                  sizeBytes={mainFilePreviewPanel.sizeBytes}
                  subtitle={mainFilePreviewPanel.channelLabel}
                  fileId={mainFilePreviewPanel.fileId}
                  channelId={mainFilePreviewPanel.channelId}
                  scopeType={mainFilePreviewPanel.scopeType}
                  scopeId={mainFilePreviewPanel.scopeId}
                  source={mainFilePreviewPanel.source}
                  variant="main"
                  onDeleted={() => {
                    setMainFilePreviewPanel(null);
                    setFileLibraryRefreshNonce((value) => value + 1);
                  }}
                  onClose={() => {
                    setMainFilePreviewPanel(null);
                    setSelectedId(null);
                  }}
                />
              </Suspense>
            ) : (
            <ChatWorkspaceView
              selectedId={selectedId}
              selectedChannel={selectedChannel}
              activeDm={activeDm}
              activeBotDm={activeBotDm}
              activeDmSessionScopeId={activeDmSessionScopeId}
              dmSessionRefreshNonce={dmSessionRefreshNonce}
              isMobile={isMobile}
              isPersonalWorkspace={isPersonalWorkspace}
              isDmSelected={isDmSelected}
              autoAssist={autoAssist}
              memoryTab={memoryTab}
              topicRoots={topicRoots}
              topicRepliesOf={topicRepliesOf}
              taskPageOpen={taskPageOpen}
              agentBridgeTaskMessages={agentBridgeTaskMessages}
              refreshingDmSession={refreshingDmSession}
              canRefreshSessions={canRefreshSessions}
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
                onForwardMessage: openForwardMessage,
                onToggleForwardSelection: toggleForwardSelection,
                forwardSelectionMode,
                selectedForwardMsgIds,
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
                restoringInitialScroll,
                loadingMore,
                hasMore,
                messages,
                selectedChannel,
                selectedId,
                isDmSelected,
                currentUser,
                currentUserId,
                authToken,
                renderItems,
                virtualItems,
                rowVirtualizer,
                showJumpToBottom,
                onJumpToBottom: jumpToBottom,
                botById,
                botByUsername,
                coordinatorBot,
                userById,
                revealedSecrets,
                secretTokens,
                clarifyAnsweredParentIds,
                pendingClarifyReplyMsgId,
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
                forwardSelectionMode,
                renderForwardActionButtons,
              }}
              forwardSelectionBar={
                forwardSelectionMode ? (
                  <div className="absolute bottom-24 left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg-1)] px-3 py-2 text-sm shadow-lg">
                    <span className="whitespace-nowrap text-[var(--fg-2)]">
                      Selected {selectedForwardMsgIds.length} items
                    </span>
                    <button
                      type="button"
                      className="rounded-md px-2 py-1 text-xs text-[var(--fg-3)] transition-colors hover:bg-[var(--surface-soft)] hover:text-[var(--fg-1)]"
                      onClick={cancelForwardSelection}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={selectedForwardMsgIds.length === 0}
                      className="inline-flex items-center gap-1 rounded-md bg-[var(--accent)] px-2.5 py-1 text-xs font-medium text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
                      onClick={openForwardSelectedTopic}
                    >
                      <AppIcon name="forward" className="h-3.5 w-3.5" />
                      Forward as bundle
                    </button>
                  </div>
                ) : null
              }
              composerProps={{
                value: input,
                valueRevision: inputRevision,
                inputRef,
                onValueChange: handleComposerValueChange,
                onSend: send,
                canSend: pendingFileIds.length > 0,
                canSendPredicate: (value) =>
                  Boolean((value.trim() && value.trim() !== "@") || pendingFileIds.length > 0),
                disabled: isSystemDm,
                placeholder: isSystemDm
                  ? "Friend notification conversations handle requests and cannot send messages directly..."
                  : msgKind === "secret"
                    ? "Enter encrypted content (only bots can read the original)..."
                    : isDmSelected
                      ? `Message ${activeDm?.counterparty.display_name || activeDm?.counterparty.username || "DM"}...`
                      : msgKind === "announcement"
                        ? `Post announcement to #${selectedChannel?.name || "Channels"}...`
                        : msgKind === "topic"
                          ? "Start a topic · title comes from the first line..."
                          : `Message #${selectedChannel?.name || "Channels"}, @ mention bots...`,
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
                promptTemplates,
                promptTemplatesLoading,
                selectedPromptTemplateId,
                onPromptTemplateChange: setPromptTemplateOverrideId,
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
            onFileDeleted={() => setFileLibraryRefreshNonce((value) => value + 1)}
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
