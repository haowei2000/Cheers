import { useCallback, useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import FriendsPanel from "./FriendsPanel";
import NotificationPanel from "./NotificationPanel";
import ChannelMembersModal from "./ChannelMembersModal";
import MemoryPage from "./MemoryPage";
import { useTheme } from "./useTheme";
import { useAuth } from "./hooks/useAuth";
import { useResize } from "./hooks/useResize";
import { FilePreviewSidebar } from "./components/FilePreviewSidebar";
import { GuideFormBlock } from "./components/GuideFormBlock";
import { ClarifyInlineBlock } from "./components/ClarifyInlineBlock";
import { ThinkingIndicator } from "./components/ThinkingIndicator";
import { MemoryPanel } from "./components/MemoryPanel";
import { LoginModal } from "./components/LoginModal";
import { CreateWorkspaceModal } from "./components/CreateWorkspaceModal";
import { InviteWorkspaceMemberModal } from "./components/InviteWorkspaceMemberModal";
import { CreateChannelModal } from "./components/CreateChannelModal";
import { OpenClawQcModal } from "./components/OpenClawQcModal";
import { KeychainModal } from "./components/KeychainModal";
import { UserProfileModal } from "./components/UserProfileModal";
import { ChannelProfileModal } from "./components/ChannelProfileModal";
import { QaSummaryModal } from "./components/QaSummaryModal";
import { ImageGenModal } from "./components/ImageGenModal";
import { Sidebar } from "./components/Sidebar";
import { HelpModal } from "./components/HelpModal";
import {
  SettingsModal,
  applyAccent,
  applyDensity,
  getStoredAccent,
  getStoredDensity,
} from "./components/SettingsModal";
import { DragOverlay } from "./components/DragOverlay";
import { ImageLightbox } from "./components/ImageLightbox";
import { ChannelHeader } from "./components/ChannelHeader";
import { TopicPanel } from "./components/TopicPanel";
import { TopicPage } from "./components/TopicPage";
import { AnnouncementComposerModal } from "./components/AnnouncementComposerModal";
import { WorkspaceRail } from "./components/WorkspaceRail";
import { apiFetch, buildWsUrl } from "./api";
import {
  parseGuidePayload,
  isClarifyReplyUserMessage,
} from "./lib/guide";
import {
  isMsgReply,
  parseQuotePrefix,
  formatTs,
  formatDayLabel,
  TOPIC_DISPLAY_THRESHOLD,
} from "./lib/message";
import {
  buildLogicalQaBlocks,
  buildQaMarkdown,
  downloadText,
} from "./lib/qa";
import { renderWithThinkFolding, stripThinkTags } from "./lib/think";
import { refreshChannels, refreshDMs, refreshWorkspaces } from "./lib/refresh";
import type {
  Channel,
  DM,
  Workspace,
  Message,
  QaPair,
  ContextData,
  ClarifySchema,
  ClarifyAnswers,
  ChannelBot,
  ChannelUser,
  BotItem,
} from "./types";
import { OTHER_CHOICE_ID } from "./types";

const API = "/api/v1";
const DEV_USER_ID = "a0000000-0000-0000-0000-000000000001";
const API_DOCS_URL = "/docs";



export default function App() {
  const { isDark, setTheme } = useTheme();

  // Apply stored appearance prefs (density + accent) on mount
  useEffect(() => {
    applyDensity(getStoredDensity());
    applyAccent(getStoredAccent());
  }, []);

  const { currentUser, authToken, currentUserId, authFetch, setAuth, setCurrentUser, logout: clearAuth } =
    useAuth(DEV_USER_ID);

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
  // Topic viewers:
  //   openTopicId  — root msg_id for the side-dock panel
  //   pageTopicId  — root msg_id for the full-page view (mirrored to URL hash)
  const [announcementOpen, setAnnouncementOpen] = useState(false);
  // Composer send-kind: switchable between 普通消息 / 公告 / 主题 via
  // Shift-Tab or the ‹ › buttons flanking the composer. Always resets to
  // "normal" after each send. "reply" is orthogonal — replyingTo overrides
  // this.
  type MsgKind = "normal" | "announcement" | "topic";
  const MSG_KINDS_ORDER: MsgKind[] = ["normal", "announcement", "topic"];
  const MSG_KIND_LABEL: Record<MsgKind, string> = {
    normal: "消息",
    announcement: "公告",
    topic: "主题",
  };
  const [msgKind, setMsgKind] = useState<MsgKind>("normal");
  // Optional title carried by announcement + topic kinds. Normal messages
  // ignore it; we clear it whenever kind cycles or a send completes.
  const [composerTitle, setComposerTitle] = useState<string>("");
  const composerTitleRef = useRef<HTMLInputElement | null>(null);
  const cycleMsgKind = (direction: 1 | -1) => {
    setMsgKind((prev) => {
      const idx = MSG_KINDS_ORDER.indexOf(prev);
      const next =
        (idx + direction + MSG_KINDS_ORDER.length) % MSG_KINDS_ORDER.length;
      setComposerTitle("");
      return MSG_KINDS_ORDER[next];
    });
  };
  const [openTopicId, setOpenTopicId] = useState<string | null>(null);
  const [pageTopicId, setPageTopicId] = useState<string | null>(() => {
    if (typeof location === "undefined") return null;
    const m = /#topic=([^&]+)/.exec(location.hash || "");
    return m ? decodeURIComponent(m[1]) : null;
  });
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // memoryTab drives the 4-tab cluster in the channel header + the drawer.
  //   null          — drawer closed
  //   "PROJECT"     — anchors + progress + decisions (design's Project view)
  //   "FILES_INDEX" — channel files
  //   "MEMBERS"     — members list
  //   "TODO"        — todos
  const [memoryTab, setMemoryTab] = useState<
    "PROJECT" | "FILES_INDEX" | "MEMBERS" | "TODO" | null
  >(null);
  const memoryPanelOpen = memoryTab !== null;
  const [memoryPageOpen, setMemoryPageOpen] = useState(false);
  const [contextData, setContextData] = useState<ContextData>({});
  const [pendingFileIds, setPendingFileIds] = useState<string[]>([]);
  const [pendingFileNames, setPendingFileNames] = useState<string[]>([]);
  const [pendingFilePreviews, setPendingFilePreviews] = useState<
    (string | null)[]
  >([]);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const dragCounterRef = useRef(0);
  const [uploadMenuOpen, setUploadMenuOpen] = useState(false);
  const uploadMenuRef = useRef<HTMLDivElement>(null);
  const fileImgInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!uploadMenuOpen) return;
    const handle = (e: MouseEvent) => {
      if (
        uploadMenuRef.current &&
        !uploadMenuRef.current.contains(e.target as Node)
      ) {
        setUploadMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [uploadMenuOpen]);

  // Keychain insert popup
  const [keychainPopupOpen, setKeychainPopupOpen] = useState(false);
  const [keychainPopupItems, setKeychainPopupItems] = useState<
    { key_id: string; name: string }[]
  >([]);
  const [keychainPopupLoading, setKeychainPopupLoading] = useState(false);
  const keychainPopupRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!keychainPopupOpen) return;
    const handle = (e: MouseEvent) => {
      if (
        keychainPopupRef.current &&
        !keychainPopupRef.current.contains(e.target as Node)
      ) {
        setKeychainPopupOpen(false);
      }
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [keychainPopupOpen]);

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

  const insertSecret = (name: string) => {
    const snippet = `$secret{${name}}`;
    const el = inputRef.current;
    if (!el) {
      setInput((v) => v + snippet);
      setKeychainPopupOpen(false);
      return;
    }
    const start = el.selectionStart ?? input.length;
    const end = el.selectionEnd ?? input.length;
    const newVal = input.slice(0, start) + snippet + input.slice(end);
    setInput(newVal);
    setKeychainPopupOpen(false);
    // Restore cursor after snippet
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + snippet.length, start + snippet.length);
    });
  };
  const [selectedQaIds, setSelectedQaIds] = useState<Record<string, boolean>>(
    {},
  );
  const [summaryModalOpen, setSummaryModalOpen] = useState(false);
  const [summaryBusy, setSummaryBusy] = useState(false);
  const [summaryPreview, setSummaryPreview] = useState("");
  const [qaLlmReady, setQaLlmReady] = useState(false);
  const [qaLlmHint, setQaLlmHint] = useState("正在检查 LLM 配置...");
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
  const [showMentionDropdown, setShowMentionDropdown] = useState(false);
  const [mentionFilter, setMentionFilter] = useState("");
  const [mentionDropdownPlacement, setMentionDropdownPlacement] = useState<
    "top" | "bottom"
  >("bottom");
  // 文生图 / 图生图 Modal 打开状态 + 初始参数
  const [imageGenOpen, setImageGenOpen] = useState(false);
  const [imageGenInitialSourceFileId, setImageGenInitialSourceFileId] =
    useState("");
  const [imageGenInitialTab, setImageGenInitialTab] = useState<"gen" | "edit">(
    "gen",
  );
  // 加密消息状态
  const [secretMode, setSecretMode] = useState(false);
  const [revealedSecrets, setRevealedSecrets] = useState<
    Record<string, string>
  >({});
  const [secretTokens, setSecretTokens] = useState<Record<string, string>>({}); // msg_id -> token（仅发送方当次 session 持有）
  const [secretNow, setSecretNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setSecretNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  // Lightbox 状态
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [lightboxFileId, setLightboxFileId] = useState<string | null>(null);
  // 文件预览侧边栏
  const [filePreviewPanel, setFilePreviewPanel] = useState<{
    url: string;
    filename: string;
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
  const [inviteWsMemberOpen, setInviteWsMemberOpen] = useState(false);
  const [inviteWsIdentifier, setInviteWsIdentifier] = useState("");
  const [newChannelName, setNewChannelName] = useState("");
  const [allBots, setAllBots] = useState<BotItem[]>([]);
  const [selectedBotIds, setSelectedBotIds] = useState<Set<string>>(new Set());
  const [addingBots, setAddingBots] = useState(false);
  const [manageMembersOpen, setManageMembersOpen] = useState(false);
  const [friendsPanelOpen, setFriendsPanelOpen] = useState(false);
  const [notifPanelOpen, setNotifPanelOpen] = useState(false);
  const pendingScrollMsgIdRef = useRef<string | null>(null);
  const [userProfileOpen, setUserProfileOpen] = useState(false);
  const [keychainModalOpen, setKeychainModalOpen] = useState(false);
  const [channelProfileOpen, setChannelProfileOpen] = useState(false);
  const [_expandedOlderIds, _setExpandedOlderIds] = useState<Set<string>>(
    new Set(),
  );
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const isLoadingOlderRef = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const secretInputRef = useRef<HTMLInputElement | null>(null);
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);
  const [waitingForBotReply, setWaitingForBotReply] = useState(false);
  const [processingBots, setProcessingBots] = useState<Record<string, string>>(
    {},
  );

  const [qcOpen, setQcOpen] = useState(false);


  const handleNotifNavigate = (channelId: string, msgId?: string) => {
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
      body: JSON.stringify({ name: newWorkspaceName.trim() }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.status === "success") {
          toast.success("工作空间创建成功");
          setNewWorkspaceName("");
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
  const handleInviteWsMember = () => {
    if (!inviteWsIdentifier.trim()) {
      toast.error("请输入用户名");
      return;
    }
    if (!selectedWorkspaceId) {
      toast.error("请先选择工作空间");
      return;
    }
    authFetch(`${API}/workspaces/${selectedWorkspaceId}/invite`, {
      method: "POST",
      body: JSON.stringify({ identifier: inviteWsIdentifier.trim() }),
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

  function introSummary(intro: string | undefined): string {
    if (!intro) return "";
    try {
      const o = JSON.parse(intro);
      if (o.description) return o.description;
      if (Array.isArray(o.capabilities)) return o.capabilities.join(", ");
      return intro.slice(0, 50) + (intro.length > 50 ? "…" : "");
    } catch {
      return intro.slice(0, 50) + (intro.length > 50 ? "…" : "");
    }
  }

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

  // ── URL hash sync for #topic=<id> ──────────────────────────────────────
  // Writer: whenever pageTopicId changes, reflect it into the hash (without
  // adding history entries — replaceState). Reader: listen to popstate in
  // case the user navigates back/forward.
  useEffect(() => {
    if (typeof history === "undefined") return;
    const hash = location.hash || "";
    const current = /#topic=([^&]+)/.exec(hash);
    const currentId = current ? decodeURIComponent(current[1]) : null;
    if (pageTopicId === currentId) return;
    if (pageTopicId) {
      history.replaceState(
        null,
        "",
        `${location.pathname}${location.search}#topic=${encodeURIComponent(pageTopicId)}`,
      );
    } else if (/#topic=/.test(hash)) {
      history.replaceState(null, "", `${location.pathname}${location.search}`);
    }
  }, [pageTopicId]);

  useEffect(() => {
    const onPop = () => {
      const m = /#topic=([^&]+)/.exec(location.hash || "");
      setPageTopicId(m ? decodeURIComponent(m[1]) : null);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setMessages([]);
      setHasMore(true);
      setChannelBots([]);
      setSelectedQaIds({});
      setSummaryPreview("");
      setWaitingForBotReply(false);
      setProcessingBots({});
      setAutoAssist(false);
      setReplyingTo(null);
      return;
    }
    const ch = channels.find((c) => c.channel_id === selectedId);
    setAutoAssist(ch?.auto_assist ?? false);
    setLoading(true);
    authFetch(`${API}/channels/${selectedId}/members?with_username=1`)
      .then((r) => r.json())
      .then((d) => {
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
              }) => ({
                member_id: m.member_id,
                username: m.username,
                avatar_url: m.avatar_url,
                display_name: m.display_name,
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
              }) => ({
                member_id: m.member_id,
                username: m.username,
                avatar_url: m.avatar_url,
                display_name: m.display_name,
              }),
            );
          setChannelUsers(users);
        } else {
          setChannelBots([]);
          setChannelUsers([]);
        }
      })
      .catch(() => {
        setChannelBots([]);
      });
    authFetch(`${API}/channels/${selectedId}/messages`)
      .then((r) => r.json())
      .then((d) => {
        const data = d.data || [];
        setMessages(data);
        setHasMore(d.meta?.has_more ?? data.length >= 30);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [selectedId]);

  // ── 上划加载更多历史消息 ──────────────────────────────────────────────────
  const loadMoreMessages = useCallback(async () => {
    if (!selectedId || !hasMore || loadingMore) return;
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
      setHasMore(d.meta?.has_more ?? older.length >= 50);
      setMessages((prev) => [...older, ...prev]);
      // 恢复滚动位置
      requestAnimationFrame(() => {
        if (container) {
          container.scrollTop = container.scrollHeight - prevScrollHeight;
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
      if (target.scrollTop < 100 && hasMore && !loadingMore) {
        loadMoreMessages();
      }
    },
    [hasMore, loadingMore, loadMoreMessages],
  );

  // Scroll to a pending message after channel switch + messages load
  useEffect(() => {
    const msgId = pendingScrollMsgIdRef.current;
    if (!msgId || loading || messages.length === 0) return;
    pendingScrollMsgIdRef.current = null;
    setTimeout(() => {
      document
        .getElementById(`msg-${msgId}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
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
          if (msg.type === "message" && msg.data) {
            setMessages((prev) => {
              const id = msg.data.msg_id;
              if (id && prev.some((m) => m.msg_id === id)) {
                // Already present — merge post-hoc updates (e.g. permission
                // card resolution flipping content_data.resolved). Keep any
                // client-local transient fields like _streaming.
                return prev.map((m) =>
                  m.msg_id === id
                    ? {
                        ...m,
                        content: msg.data.content ?? m.content,
                        content_data:
                          msg.data.content_data ?? m.content_data,
                        msg_type: msg.data.msg_type ?? m.msg_type,
                      }
                    : m,
                );
              }
              const entry =
                msg.data.sender_type === "bot"
                  ? { ...msg.data, _streaming: true }
                  : msg.data;
              return [...prev, entry];
            });
            if (
              msg.data.sender_type === "bot" &&
              typeof msg.data.content === "string" &&
              msg.data.content.includes("已更新记忆层")
            ) {
              fetch(`${API}/channels/${selectedId}/context`)
                .then((r) => r.json())
                .then((d) => d.data && setContextData(d.data))
                .catch(() => {});
            }
          } else if (msg.type === "message_stream" && msg.data) {
            const { msg_id, delta } = msg.data;
            setMessages((prev) =>
              prev.map((m) =>
                m.msg_id === msg_id
                  ? { ...m, content: m.content + delta, _streaming: true }
                  : m,
              ),
            );
          } else if (msg.type === "message_done" && msg.data) {
            const { msg_id, content, files, file_ids } = msg.data;
            setMessages((prev) =>
              prev.map((m) =>
                m.msg_id === msg_id
                  ? {
                      ...m,
                      content,
                      _streaming: false,
                      ...(files ? { files } : {}),
                      ...(file_ids ? { file_ids } : {}),
                    }
                  : m,
              ),
            );
            if (
              typeof content === "string" &&
              content.includes("已更新记忆层")
            ) {
              fetch(`${API}/channels/${selectedId}/context`)
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
      if (ws) ws.close();
    };
  }, [selectedId, reportClientError]);

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
          if (msg.type !== "channel_new_message" || !msg.data) return;
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
  }, [currentUserId, selectedId]);

  useEffect(() => {
    if ((memoryPanelOpen || memoryPageOpen) && selectedId) {
      fetch(`${API}/channels/${selectedId}/context`)
        .then((r) => r.json())
        .then((d) => d.data && setContextData(d.data))
        .catch(console.error);
    }
  }, [memoryPanelOpen, memoryPageOpen, selectedId]);

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

  useEffect(() => {
    if (showMentionDropdown && selectedId) {
      const headers: Record<string, string> = authToken
        ? { Authorization: `Bearer ${authToken}` }
        : {};
      fetch(`${API}/bots`, { headers })
        .then((r) => r.json())
        .then((d) => setAllBots(d.data || []))
        .catch(() => setAllBots([]));
      fetch(`${API}/channels/${selectedId}/members?with_username=1`, {
        headers,
      })
        .then((r) => r.json())
        .then((d) => {
          if (!d.data) return;
          setChannelBots(
            d.data
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
                }) => ({
                  member_id: m.member_id,
                  username: m.username,
                  avatar_url: m.avatar_url,
                  display_name: m.display_name,
                }),
              ),
          );
          setChannelUsers(
            d.data
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
              ),
          );
        })
        .catch(console.error);
    }
  }, [showMentionDropdown, selectedId, authToken]);

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
                    }) => ({
                      member_id: m.member_id,
                      username: m.username,
                      avatar_url: m.avatar_url,
                      display_name: m.display_name,
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
    const targetChannelId = selectedId;
    const body: Record<string, unknown> = {
      content: content.trim(),
      sender_id: currentUserId,
      sender_type: "user",
      file_ids: [] as string[],
      msg_type: inReplyToMsgId ? "reply" : "normal",
    };
    if (inReplyToMsgId) body.in_reply_to_msg_id = inReplyToMsgId;
    return authFetch(`${API}/channels/${targetChannelId}/messages`, {
      method: "POST",
      body: JSON.stringify(body),
    })
      .then((r) => r.json())
      .then((d) => {
        // 用户消息由 WebSocket 广播接收，这里仅作兜底去重插入
        if (d.data && selectedIdRef.current === targetChannelId) {
          setMessages((prev) =>
            prev.some((m) => m.msg_id === d.data.msg_id)
              ? prev
              : [...prev, d.data],
          );
        }
      });
  };

  const send = () => {
    if (!selectedId || !input.trim()) return;
    const targetChannelId = selectedId;
    let content = input.trim();
    if (replyingTo) {
      const refBot =
        replyingTo.sender_type === "bot"
          ? channelBots.find((b) => b.member_id === replyingTo.sender_id)
          : null;
      const refLabel =
        replyingTo.sender_type === "bot"
          ? refBot?.display_name || refBot?.username || "Bot"
          : currentUser?.display_name || "用户";
      const quotedRaw =
        parseGuidePayload(replyingTo.content).text || replyingTo.content;
      const quotedText = quotedRaw.replace(/\n+/g, " ").trim().slice(0, 400);
      content = `> [${refLabel}]: ${quotedText}\n\n${content}`;
    }
    const isSecretSend = secretMode;
    // Resolve msg_type: a pending reply-to always wins; otherwise use the
    // user's current msgKind pick from the composer switcher.
    const effectiveKind: MsgKind | "reply" = replyingTo
      ? "reply"
      : msgKind;
    const body: Record<string, unknown> = {
      content,
      sender_id: currentUserId,
      sender_type: "user",
      file_ids: pendingFileIds,
      is_secret: isSecretSend,
      msg_type: effectiveKind,
    };
    if (replyingTo) body.in_reply_to_msg_id = replyingTo.msg_id;
    const titleTrim = composerTitle.trim() || null;
    if (effectiveKind === "announcement") {
      body.content_data = {
        pinned_by: currentUserId,
        ...(titleTrim ? { title: titleTrim } : {}),
      };
    } else if (effectiveKind === "topic") {
      body.content_data = titleTrim ? { title: titleTrim } : {};
    }
    setInput("");
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
          setMessages((prev) =>
            prev.some((m) => m.msg_id === d.data.msg_id)
              ? prev
              : [...prev, d.data],
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

  // Copy a message's rendered text (stripping think-folds / guide payload
  // JSON) to the system clipboard. Best-effort — silently toasts failure.
  const copyMessageText = async (m: Message) => {
    const raw = parseGuidePayload(m.content || "").text || m.content || "";
    try {
      await navigator.clipboard.writeText(raw);
      toast.success("已复制");
    } catch {
      toast.error("复制失败");
    }
  };

  const sendTopicReply = async (
    channelId: string,
    rootMsgId: string,
    text: string,
  ) => {
    if (!text.trim()) return;
    const body: Record<string, unknown> = {
      content: text.trim(),
      sender_id: currentUserId,
      sender_type: "user",
      file_ids: [],
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
      setMessages((prev) =>
        prev.some((m) => m.msg_id === d.data.msg_id) ? prev : [...prev, d.data],
      );
    }
  };

  const handleClarifyContinue = (
    msgId: string,
    schema: ClarifySchema,
    answers: ClarifyAnswers,
  ) => {
    const lines = ["@channel bot 澄清回答："];
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
      "@channel bot 用户选择跳过澄清，请在当前信息下继续回答。",
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

  // ── 文件附件渲染辅助 ──────────────────────────────────────────────────────
  const formatFileSize = (bytes?: number) => {
    if (!bytes || bytes <= 0) return "";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const fileTypeLabel = (ct?: string) => {
    if (!ct) return "文件";
    if (ct.includes("pdf")) return "PDF";
    if (ct.includes("wordprocessingml") || ct.includes("docx")) return "Word";
    if (ct.includes("text/plain")) return "文本";
    if (ct.startsWith("image/")) return "图片";
    return "文件";
  };

  const renderFileAttachments = (msg: Message, alignRight = false) => {
    const files = msg.files;
    if (!files || files.length === 0) return null;
    const images = files.filter((f) =>
      (f.content_type || "").startsWith("image/"),
    );
    const docs = files.filter(
      (f) => !(f.content_type || "").startsWith("image/"),
    );
    if (images.length === 0 && docs.length === 0) return null;
    return (
      <div
        className={`mb-1.5 space-y-1.5 ${alignRight ? "flex flex-col items-end" : ""}`}
      >
        {images.map((f) => (
          <div
            key={f.file_id}
            className="cursor-pointer rounded-xl overflow-hidden border border-gray-200 shadow-sm hover:shadow-md transition-shadow inline-block"
            onClick={() => {
              setLightboxSrc(`${API}/files/${f.file_id}/preview`);
              setLightboxFileId(f.file_id);
            }}
          >
            <img
              src={`${API}/files/${f.file_id}/preview`}
              alt={f.original_filename || "image"}
              className="max-w-[280px] max-h-[200px] object-cover block"
              loading="lazy"
            />
            {f.original_filename && (
              <div className="px-2.5 py-1.5 bg-white text-[11px] text-gray-500 border-t border-gray-100 flex items-center gap-1.5">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 16 16"
                  fill="currentColor"
                  className="w-3 h-3 text-gray-400"
                >
                  <path
                    fillRule="evenodd"
                    d="M2 4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4Zm10.5 5.707a.5.5 0 0 0-.146-.353l-2.5-2.5a.5.5 0 0 0-.708 0L7.5 8.5 6.354 7.354a.5.5 0 0 0-.708 0l-3.146 3.15V12a.5.5 0 0 0 .5.5h10a.5.5 0 0 0 .5-.5v-2.293ZM11 5.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"
                    clipRule="evenodd"
                  />
                </svg>
                <span className="truncate max-w-[200px]">
                  {f.original_filename}
                </span>
                {f.size_bytes ? (
                  <span className="text-gray-400">
                    {formatFileSize(f.size_bytes)}
                  </span>
                ) : null}
              </div>
            )}
          </div>
        ))}
        {docs.map((f) => (
          <a
            key={f.file_id}
            href={`${API}/files/${f.file_id}/download`}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-2.5 px-3 py-2.5 bg-white border border-gray-200 rounded-xl shadow-sm max-w-[300px] hover:bg-gray-50 transition-colors cursor-pointer no-underline"
          >
            <div className="w-9 h-9 rounded-lg bg-blue-50 flex items-center justify-center flex-shrink-0">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 20 20"
                fill="currentColor"
                className="w-5 h-5 text-blue-500"
              >
                <path d="M3 3.5A1.5 1.5 0 0 1 4.5 2h6.879a1.5 1.5 0 0 1 1.06.44l3.122 3.12A1.5 1.5 0 0 1 16 6.622V16.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 16.5v-13Z" />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-medium text-gray-700 truncate">
                {f.original_filename || f.file_id}
              </div>
              <div className="text-[11px] text-gray-400">
                {fileTypeLabel(f.content_type)}
                {f.size_bytes ? ` \u00B7 ${formatFileSize(f.size_bytes)}` : ""}
              </div>
            </div>
          </a>
        ))}
      </div>
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
  const blocks = buildLogicalQaBlocks(messages);
  const blockPairsForExport: QaPair[] = blocks.map((b) => {
    const lastBot = [...b.messages]
      .reverse()
      .find((m) => m.sender_type === "bot");
    const answer: Message = lastBot || {
      msg_id: `${b.question.msg_id}-no-reply`,
      sender_id: "",
      sender_type: "bot",
      content: "(无回复)",
      created_at: b.question.created_at,
    };
    return { question: b.question, answer };
  });
  const selectedPairs = blockPairsForExport.filter(
    (p) => selectedQaIds[p.question.msg_id],
  );

  const exportMdFilename = () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const ch = (selectedChannel?.name || "channel").replace(/\s+/g, "_");
    return `qa-export-${ch}-${stamp}.md`;
  };

  const downloadQaMarkdown = () => {
    if (selectedPairs.length === 0) {
      toast.error("请勾选至少一组问答");
      return;
    }
    const md = buildQaMarkdown(selectedChannel?.name || "频道", selectedPairs);
    downloadText(exportMdFilename(), md);
  };

  const refreshQaLlmStatus = async () => {
    try {
      const llmRes = await authFetch(`${API}/admin/settings/llm`);
      const llmData = await llmRes.json();
      if (!llmRes.ok) {
        setQaLlmReady(false);
        setQaLlmHint("无法读取 LLM 配置，请稍后重试。");
        return false;
      }
      const bindings = llmData?.data?.bindings || {};
      const providers = llmData?.data?.providers || [];
      const pickedId = bindings.qa_summarize || bindings.system_llm;
      const picked = providers.find(
        (p: { id: string; base_url?: string }) => p.id === pickedId,
      );
      if (!picked || !String(picked.base_url || "").trim()) {
        setQaLlmReady(false);
        setQaLlmHint(
          "未配置问答总结 LLM，请到「管理」页绑定问答总结或系统 LLM。",
        );
        return false;
      }
      setQaLlmReady(true);
      setQaLlmHint("LLM 已配置，可生成总结。");
      return true;
    } catch {
      setQaLlmReady(false);
      setQaLlmHint("检查 LLM 配置失败，请稍后重试。");
      return false;
    }
  };

  // 进入频道或收到新消息时，聊天区域滚动到最新消息（加载旧消息时跳过）
  useEffect(() => {
    if (!messagesContainerRef.current || isLoadingOlderRef.current) return;
    messagesContainerRef.current.scrollTop =
      messagesContainerRef.current.scrollHeight;
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

  const generateQaSummary = async (pairsToSummarize: QaPair[]) => {
    if (pairsToSummarize.length === 0) {
      toast.error("请勾选至少一组问答");
      return;
    }
    setSummaryBusy(true);
    try {
      const ok = await refreshQaLlmStatus();
      if (!ok) {
        toast.error("请先在管理页配置并绑定可用 LLM（问答总结或系统 LLM）。");
        return;
      }

      const pairs = pairsToSummarize.map((p) => ({
        question: stripThinkTags(
          parseGuidePayload(p.question.content).text || p.question.content,
        ),
        answer: stripThinkTags(
          parseGuidePayload(p.answer.content).text || p.answer.content,
        ),
        question_time: formatTs(p.question.created_at),
        answer_time: formatTs(p.answer.created_at),
      }));
      const res = await authFetch(`${API}/admin/qa/summarize`, {
        method: "POST",
        body: JSON.stringify({
          channel_name: selectedChannel?.name || "频道",
          pairs,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(
          data?.detail || data?.message || `总结失败 (${res.status})`,
        );
      }
      const md = data?.data?.summary_markdown || "";
      if (!md.trim()) {
        throw new Error("未获得总结结果");
      }
      setSummaryPreview(md);
    } catch (e) {
      toast.error((e as Error).message || "生成总结失败");
    } finally {
      setSummaryBusy(false);
    }
  };

  useEffect(() => {
    if (!selectedId) return;
    refreshQaLlmStatus();
  }, [selectedId]);

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

  // Build topic tree: follow parent chain to find root, group all descendants under it
  const { topicRoots, topicRepliesOf } = (() => {
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
    const replyMap = new Map<string, Message[]>();
    const replySet = new Set<string>();
    for (const m of messages) {
      const rootId = getRootId(m.msg_id);
      if (rootId !== m.msg_id) {
        replySet.add(m.msg_id);
        const arr = replyMap.get(rootId) ?? [];
        arr.push(m);
        replyMap.set(rootId, arr);
      }
    }
    for (const arr of replyMap.values()) {
      arr.sort((a, b) =>
        (a.created_at ?? "") < (b.created_at ?? "") ? -1 : 1,
      );
    }
    return {
      topicRoots: messages.filter((m) => !replySet.has(m.msg_id)),
      topicRepliesOf: (rootId: string): Message[] =>
        replyMap.get(rootId) ?? [],
    };
  })();

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

      <div className="flex h-dvh" style={{ background: "var(--bg-0)" }}>
        {isMobile && sidebarOpen && (
          <div
            className="fixed inset-0 bg-black/50 z-[55]"
            onClick={() => setSidebarOpen(false)}
          />
        )}
        {!isMobile && (
          <WorkspaceRail
            workspaces={workspaces}
            selectedWorkspaceId={selectedWorkspaceId}
            onSelect={setSelectedWorkspaceId}
            onCreate={() => setCreateWsOpen(true)}
          />
        )}
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
        />

        <HelpModal
          open={helpOpen}
          onClose={() => setHelpOpen(false)}
          apiDocsUrl={API_DOCS_URL}
        />

        <AnnouncementComposerModal
          open={announcementOpen}
          channelId={selectedId}
          channelName={selectedChannel?.name}
          currentUserId={currentUserId}
          authToken={authToken}
          onClose={() => setAnnouncementOpen(false)}
          onPublished={() => toast.success("公告已发布")}
        />

        <SettingsModal
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          isDark={isDark}
          setTheme={setTheme}
          currentUser={currentUser}
          onOpenUserProfile={() => setUserProfileOpen(true)}
          onOpenKeychain={() => setKeychainModalOpen(true)}
          onOpenNotifications={() => setNotifPanelOpen(true)}
          onOpenFriends={() => setFriendsPanelOpen(true)}
          onOpenQuickConnect={() => setQcOpen(true)}
          onOpenHelp={() => setHelpOpen(true)}
          onLogout={handleLogout}
        />

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
          onSubmit={handleCreateWorkspace}
          onClose={() => setCreateWsOpen(false)}
        />

        <InviteWorkspaceMemberModal
          open={inviteWsMemberOpen}
          value={inviteWsIdentifier}
          onChange={setInviteWsIdentifier}
          onSubmit={handleInviteWsMember}
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

        {addBotOpen && selectedId && (
          <div
            className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40"
            onClick={() => setAddBotOpen(false)}
            aria-modal="true"
            role="dialog"
          >
            <div
              className="bg-white rounded-xl shadow-2xl max-w-xl w-full mx-4 p-6 text-left max-h-[90vh] overflow-auto"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex justify-between items-center mb-4">
                <h2 className="text-lg font-bold text-gray-900">
                  管理频道 Bot
                </h2>
                <button
                  type="button"
                  onClick={() => setAddBotOpen(false)}
                  className="w-8 h-8 flex items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 hover:text-gray-600 text-xl"
                  aria-label="关闭"
                >
                  ×
                </button>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                    已加入的 Bot
                  </h3>
                  {channelBots.length === 0 ? (
                    <p className="text-sm text-gray-400">暂无</p>
                  ) : (
                    <ul className="space-y-1">
                      {channelBots.map((b) => (
                        <li
                          key={b.member_id}
                          className="flex items-center justify-between py-2 px-3 bg-[#F8F8F8] rounded-lg text-sm"
                        >
                          <span className="font-medium text-gray-800">
                            @{b.username}
                          </span>
                          <button
                            type="button"
                            onClick={() => removeBotFromChannel(b.member_id)}
                            className="text-red-500 text-xs hover:text-red-700"
                          >
                            移除
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div>
                  <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                    可添加的 Bot
                  </h3>
                  {(() => {
                    const inChannelIds = new Set(
                      channelBots.map((c) => c.member_id),
                    );
                    const available = allBots.filter(
                      (b) => !inChannelIds.has(b.bot_id),
                    );
                    if (available.length === 0)
                      return (
                        <p className="text-sm text-gray-400">
                          暂无或已全部加入
                        </p>
                      );
                    return (
                      <ul className="space-y-1">
                        {available.map((b) => {
                          const checked = selectedBotIds.has(b.bot_id);
                          return (
                            <li
                              key={b.bot_id}
                              className={`flex items-start gap-2 py-2 px-3 rounded-lg text-sm cursor-pointer transition-colors select-none ${checked ? "bg-blue-50 border border-[#1264A3]/30" : "bg-[#F8F8F8] hover:bg-gray-100"}`}
                              onClick={() =>
                                setSelectedBotIds((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(b.bot_id)) next.delete(b.bot_id);
                                  else next.add(b.bot_id);
                                  return next;
                                })
                              }
                            >
                              <input
                                type="checkbox"
                                className="mt-0.5 accent-[#1264A3] shrink-0"
                                checked={checked}
                                onChange={() => {}}
                                onClick={(e) => e.stopPropagation()}
                              />
                              <div className="flex flex-col min-w-0">
                                <span className="font-medium text-gray-800">
                                  @{b.username}
                                </span>
                                {introSummary(b.intro) && (
                                  <span
                                    className="text-xs text-gray-500 truncate"
                                    title={b.intro}
                                  >
                                    {introSummary(b.intro)}
                                  </span>
                                )}
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    );
                  })()}
                </div>
              </div>
              <div className="mt-5 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setAddBotOpen(false)}
                  className="px-4 py-2 bg-[#F8F8F8] text-gray-700 rounded-lg hover:bg-gray-200 text-sm font-medium"
                >
                  关闭
                </button>
                {selectedBotIds.size > 0 && (
                  <button
                    type="button"
                    disabled={addingBots}
                    onClick={async () => {
                      setAddingBots(true);
                      try {
                        await Promise.all(
                          [...selectedBotIds].map((id) => addBotToChannel(id)),
                        );
                        setSelectedBotIds(new Set());
                      } finally {
                        setAddingBots(false);
                      }
                    }}
                    className="px-4 py-2 bg-[#1264A3] text-white rounded-lg hover:bg-[#0f5a94] text-sm font-medium disabled:opacity-60"
                  >
                    {addingBots
                      ? "添加中…"
                      : `添加选中 (${selectedBotIds.size})`}
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* 通知面板 */}
        <NotificationPanel
          isOpen={notifPanelOpen}
          onClose={() => setNotifPanelOpen(false)}
          userToken={authToken ?? undefined}
          onNavigate={handleNotifNavigate}
        />

        {/* 好友管理面板 */}
        <FriendsPanel
          currentUserId={currentUserId}
          userToken={authToken ?? undefined}
          isOpen={friendsPanelOpen}
          onClose={() => setFriendsPanelOpen(false)}
        />

        {/* 频道成员管理模态框 */}
        {selectedId && (
          <ChannelMembersModal
            channelId={selectedId}
            channelName={selectedChannel?.name || ""}
            currentUserId={currentUserId}
            userToken={authToken ?? undefined}
            isOpen={manageMembersOpen}
            onClose={() => setManageMembersOpen(false)}
          />
        )}

        {/* Keychain modal */}
        {keychainModalOpen && authToken && (
          <KeychainModal
            userToken={authToken}
            onClose={() => setKeychainModalOpen(false)}
          />
        )}

        {/* User profile modal */}
        {userProfileOpen && currentUser && (
          <UserProfileModal
            currentUser={currentUser}
            userToken={authToken!}
            onClose={() => setUserProfileOpen(false)}
            onProfileUpdated={(data) => {
              if (!currentUser) return;
              setCurrentUser({
                ...currentUser,
                display_name: data.display_name,
              });
            }}
          />
        )}

        {/* Channel profile modal */}
        {channelProfileOpen && currentUser && selectedId && (
          <ChannelProfileModal
            channelId={selectedId}
            channelName={selectedChannel?.name || ""}
            userToken={authToken!}
            onClose={() => setChannelProfileOpen(false)}
          />
        )}

        <QaSummaryModal
          open={summaryModalOpen}
          onClose={() => setSummaryModalOpen(false)}
          pairs={blockPairsForExport}
          selectedIds={selectedQaIds}
          onToggle={(id) =>
            setSelectedQaIds((prev) => ({ ...prev, [id]: !prev[id] }))
          }
          onSelectAll={() =>
            setSelectedQaIds(
              Object.fromEntries(
                blockPairsForExport.map((p) => [p.question.msg_id, true]),
              ),
            )
          }
          onDeselectAll={() => setSelectedQaIds({})}
          channelBots={channelBots}
          summaryPreview={summaryPreview}
          summaryBusy={summaryBusy}
          qaLlmReady={qaLlmReady}
          qaLlmHint={qaLlmHint}
          onGenerate={() => generateQaSummary(selectedPairs)}
          onDownload={downloadQaMarkdown}
        />

        <div className="flex-1 flex min-w-0">
          <main
            className="flex-1 flex flex-col min-w-0 relative"
            style={{ background: "var(--bg-0)" }}
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
            <DragOverlay
              visible={isDraggingOver && !!selectedId}
              isDark={isDark}
            />

            {pageTopicId &&
              selectedId &&
              (() => {
                const rootMsg = messages.find(
                  (m) => m.msg_id === pageTopicId,
                );
                if (!rootMsg) return null;
                const rootId = pageTopicId; // narrowed non-null
                const topicReplies = messages
                  .filter((m) => m.in_reply_to_msg_id === rootId)
                  .sort((a, b) =>
                    (a.created_at || "") < (b.created_at || "") ? -1 : 1,
                  );
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
                    <TopicPage
                      rootMsg={rootMsg}
                      replies={topicReplies}
                      channel={selectedChannel}
                      channelBots={channelBots}
                      channelUsers={channelUsers}
                      currentUserId={currentUserId}
                      onBack={() => setPageTopicId(null)}
                      onGoToChannel={() => setPageTopicId(null)}
                      onSendReply={(text) =>
                        sendTopicReply(selectedId, rootId, text)
                      }
                    />
                  </div>
                );
              })()}

            {selectedId ? (
              <>
                <ChannelHeader
                  channel={selectedChannel}
                  selectedId={selectedId}
                  activeDm={
                    selectedId
                      ? dms.find((d) => d.channel_id === selectedId) ?? null
                      : null
                  }
                  isMobile={isMobile}
                  onOpenSidebar={() => setSidebarOpen(true)}
                  autoAssist={autoAssist}
                  setAutoAssist={setAutoAssist}
                  authToken={authToken}
                  setChannels={setChannels}
                  blockPairsForExport={blockPairsForExport}
                  onOpenQaSummary={() => {
                    setSelectedQaIds(
                      Object.fromEntries(
                        blockPairsForExport.map((p) => [
                          p.question.msg_id,
                          true,
                        ]),
                      ),
                    );
                    setSummaryPreview("");
                    setSummaryModalOpen(true);
                  }}
                  memoryTab={memoryTab}
                  onSetMemoryTab={setMemoryTab}
                  onOpenManageMembers={() => setManageMembersOpen(true)}
                  currentUser={currentUser}
                  onOpenChannelProfile={() => setChannelProfileOpen(true)}
                  onOpenAnnouncementComposer={
                    // DMs don't get announcements — the megaphone would make
                    // no sense in a 1:1 conversation.
                    selectedChannel?.type === "dm"
                      ? undefined
                      : () => setAnnouncementOpen(true)
                  }
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
                    setOpenTopicId(rootId);
                  }}
                  onJumpToMessage={(id) => {
                    const el = document.getElementById(`msg-${id}`);
                    if (!el) return;
                    el.scrollIntoView({ block: "center", behavior: "smooth" });
                    const orig = el.style.transition;
                    el.style.transition = "background 200ms";
                    const prev = el.style.background;
                    el.style.background = "var(--accent-muted)";
                    setTimeout(() => {
                      el.style.background = prev;
                      el.style.transition = orig;
                    }, 1200);
                  }}
                />

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
                                "@coordinator 总结这个频道最近的进展",
                                "这个频道的目标是什么？",
                                "@coordinator 帮我接下来要做什么",
                              ].map((s) => (
                                <button
                                  key={s}
                                  type="button"
                                  className="an-empty-chip"
                                  onClick={() => {
                                    setInput(s);
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
                      const renderedRows = topicRoots.map((m, idx) => {
                        // isDM gates the "intimate" bubble + self-right
                        // treatment; channel rendering is Discord-style
                        // flat, all-left, with sender grouping.
                        const isDMRender =
                          selectedChannel?.type === "dm";
                        // Stack against the previous root if same sender
                        // within 2 minutes — hide avatar/header row.
                        const prevRoot =
                          idx > 0 ? topicRoots[idx - 1] : null;
                        const prevTs = prevRoot?.created_at
                          ? new Date(prevRoot.created_at).getTime()
                          : 0;
                        const curTs = m.created_at
                          ? new Date(m.created_at).getTime()
                          : 0;
                        const isStacked =
                          !isDMRender &&
                          !!prevRoot &&
                          prevRoot.sender_id === m.sender_id &&
                          prevRoot.sender_type === m.sender_type &&
                          prevRoot.msg_type !== "announcement" &&
                          prevRoot.msg_type !== "routing" &&
                          prevRoot.msg_type !== "permission" &&
                          m.msg_type !== "announcement" &&
                          m.msg_type !== "routing" &&
                          m.msg_type !== "permission" &&
                          m.msg_type !== "topic" &&
                          prevTs > 0 &&
                          curTs > 0 &&
                          curTs - prevTs < 2 * 60 * 1000;
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
                          const coordBot = channelBots.find(
                            (b) =>
                              b.username === "channel bot" ||
                              b.username === "coordinator",
                          );
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
                                    "Coordinator"}
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
                                      const bot = channelBots.find(
                                        (b) => b.username === p.agent,
                                      );
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
                              ? channelBots.find(
                                  (b) => b.member_id === m.sender_id,
                                )
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
                                setMessages((prev) =>
                                  prev.map((x) =>
                                    x.msg_id === m.msg_id
                                      ? {
                                          ...x,
                                          content_data:
                                            data.data.content_data,
                                        }
                                      : x,
                                  ),
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
                              : channelUsers.find(
                                  (u) => u.member_id === pinnedById,
                                )
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
                          <svg
                            xmlns="http://www.w3.org/2000/svg"
                            viewBox="0 0 16 16"
                            fill="currentColor"
                            className="w-3.5 h-3.5"
                          >
                            <path
                              fillRule="evenodd"
                              d="M1.22 6.53a.75.75 0 0 1 0-1.06l3-3a.75.75 0 0 1 1.06 1.06L3.56 5.25H10a5.75 5.75 0 0 1 0 11.5H6a.75.75 0 0 1 0-1.5h4a4.25 4.25 0 0 0 0-8.5H3.56l1.72 1.72a.75.75 0 1 1-1.06 1.06l-3-3Z"
                              clipRule="evenodd"
                            />
                          </svg>
                        );

                        // ── root message ───────────────────────────────────────
                        const revealedContent = revealedSecrets[m.msg_id];
                        const effectiveContent = m.is_secret
                          ? (revealedContent ?? m.content)
                          : m.content;
                        const { text, form, clarify } =
                          parseGuidePayload(effectiveContent);
                        const clarifyAnswered =
                          !!clarify &&
                          messages.some(
                            (r) =>
                              r.in_reply_to_msg_id === m.msg_id &&
                              isClarifyReplyUserMessage(r.content),
                          );
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
                        const displayContent = isClarifyReplyUserMessage(
                          effectiveContent,
                        )
                          ? effectiveContent
                              .replace(
                                /^@(?:channel bot|引导)\s*澄清回答[：:]\s*/i,
                                "",
                              )
                              .trim()
                          : text || effectiveContent;
                        const isOwn =
                          m.sender_type === "user" &&
                          m.sender_id === currentUserId;
                        const senderBot =
                          m.sender_type === "bot"
                            ? channelBots.find(
                                (b) => b.member_id === m.sender_id,
                              )
                            : undefined;
                        const botLabel =
                          m.sender_name ||
                          senderBot?.display_name ||
                          senderBot?.username ||
                          "Bot";
                        const botInitials = botLabel.slice(0, 2).toUpperCase();
                        const senderUser =
                          m.sender_type === "user" && !isOwn
                            ? channelUsers.find(
                                (u) => u.member_id === m.sender_id,
                              )
                            : undefined;
                        const userLabel =
                          m.sender_name ||
                          senderUser?.display_name ||
                          senderUser?.username ||
                          "用户";
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
                            ? Math.max(
                                0,
                                60 -
                                  Math.floor(
                                    (secretNow -
                                      new Date(m.created_at).getTime()) /
                                      1000,
                                  ),
                              )
                            : null;
                        const isSecretExpired =
                          secretSecsLeft !== null && secretSecsLeft <= 0;
                        const isSecretUnrevealed =
                          m.is_secret && !revealedContent && !isSecretExpired;
                        const rootBubble = !isDMRender ? (
                          // ── Channel flat render — Discord style ────────
                          // All-left alignment, no bubble, sender grouping
                          // (stacked messages hide their avatar + header).
                          <div
                            id={`msg-${m.msg_id}`}
                            className="an-chat-msg group relative px-4 transition-colors"
                            style={{
                              paddingTop: isStacked ? 2 : 8,
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
                                {!isStacked ? (
                                  m.sender_type === "bot" ? (
                                    senderBot?.avatar_url ? (
                                      <img
                                        src={senderBot.avatar_url}
                                        alt={botLabel}
                                        className="w-9 h-9 rounded-xl object-cover mt-0.5"
                                      />
                                    ) : (
                                      <div
                                        className="w-9 h-9 rounded-xl flex items-center justify-center text-white text-xs font-bold select-none mt-0.5"
                                        style={{
                                          background: "var(--fg-3)",
                                        }}
                                      >
                                        {botInitials}
                                      </div>
                                    )
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
                                  )
                                ) : (
                                  // stacked: show the timestamp in the
                                  // gutter on hover so time is still
                                  // discoverable without the header row
                                  <div
                                    className="text-right pr-1 opacity-0 group-hover:opacity-100 transition-opacity mt-1"
                                    style={{
                                      fontSize: 10,
                                      color: "var(--fg-3)",
                                      fontVariantNumeric: "tabular-nums",
                                    }}
                                  >
                                    {msgTime
                                      ? msgTime.split(",").pop()?.trim()
                                      : ""}
                                  </div>
                                )}
                              </div>
                              <div className="flex-1 min-w-0">
                                {!isStacked && (
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
                                )}
                                {m.content_data?.title ? (
                                  <div
                                    className="text-[14px] font-semibold mb-1 leading-snug"
                                    style={{ color: "var(--fg-1)" }}
                                  >
                                    {m.content_data.title as string}
                                  </div>
                                ) : null}
                                {renderFileAttachments(m)}
                                <div
                                  style={{
                                    fontSize: "var(--fs-chat-body)",
                                    lineHeight: "var(--lh-chat-body)",
                                    color: "var(--fg-1)",
                                    wordWrap: "break-word",
                                  }}
                                >
                                  {isSecretExpired ? (
                                    <div className="an-secret-veil is-expired">
                                      <span className="an-secret-veil-icon">
                                        🔒
                                      </span>
                                      <div className="an-secret-veil-body">
                                        <span className="an-secret-veil-label">
                                          加密消息已过期
                                        </span>
                                        <span className="an-secret-veil-meta">
                                          一次性查看窗口已关闭
                                        </span>
                                      </div>
                                    </div>
                                  ) : isSecretUnrevealed ? (
                                    <div className="an-secret-veil">
                                      <span className="an-secret-veil-icon">
                                        🔒
                                      </span>
                                      <div className="an-secret-veil-body">
                                        <span className="an-secret-veil-label">
                                          加密消息
                                        </span>
                                        <span className="an-secret-veil-meta">
                                          {secretSecsLeft !== null
                                            ? `剩余 ${secretSecsLeft}s · 仅 Bot 可读`
                                            : "仅 Bot 可读"}
                                        </span>
                                      </div>
                                      {secretTokens[m.msg_id] && (
                                        <button
                                          type="button"
                                          className="an-secret-veil-reveal"
                                          onClick={() =>
                                            revealSecretMessage(m.msg_id)
                                          }
                                        >
                                          查看
                                        </button>
                                      )}
                                    </div>
                                  ) : (
                                    renderWithThinkFolding(
                                      displayContent,
                                      `${m.msg_id}-`,
                                      !!m._streaming,
                                      (src) => {
                                        setLightboxSrc(src);
                                        const m2 = src.match(
                                          /\/files\/([^/]+)\/preview/,
                                        );
                                        setLightboxFileId(
                                          m2 ? m2[1] : null,
                                        );
                                      },
                                      (url, name) =>
                                        setFilePreviewPanel({ url, filename: name }),
                                    )
                                  )}
                                  {m._streaming &&
                                    !!(parseGuidePayload(displayContent).text ||
                                      displayContent) && (
                                      <span
                                        className="inline-block w-1.5 h-4 rounded-sm animate-pulse align-middle ml-0.5"
                                        style={{
                                          background: "var(--fg-3)",
                                        }}
                                      />
                                    )}
                                </div>
                                {form && selectedId && m.sender_type === "bot" && (
                                  <GuideFormBlock
                                    msgId={m.msg_id}
                                    form={form}
                                    channelId={selectedId}
                                    onReply={(newMsg) =>
                                      setMessages((prev) => [
                                        ...prev,
                                        newMsg,
                                      ])
                                    }
                                    onChannelsRefresh={() =>
                                      refreshChannels(
                                        setChannels,
                                        authToken ?? undefined,
                                      )
                                    }
                                    userToken={authToken ?? undefined}
                                  />
                                )}
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
                                  <svg
                                    viewBox="0 0 16 16"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="1.5"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    className="w-3.5 h-3.5"
                                  >
                                    <rect x="5" y="5" width="8" height="9" rx="1.5" />
                                    <path d="M5 11H3.5A1.5 1.5 0 0 1 2 9.5v-6A1.5 1.5 0 0 1 3.5 2h6A1.5 1.5 0 0 1 11 3.5V5" />
                                  </svg>
                                </button>
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
                                    if (mention) setInput(mention);
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
                            className="group flex flex-row-reverse items-end gap-2.5 px-4 py-1 transition-all"
                          >
                            <div className="w-8 h-8 rounded-xl bg-[#1264A3] flex items-center justify-center text-white text-xs font-bold select-none flex-shrink-0">
                              我
                            </div>
                            <div className="flex items-end gap-1.5">
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
                                  if (mention) setInput(mention);
                                  (secretMode
                                    ? secretInputRef.current
                                    : inputRef.current
                                  )?.focus();
                                }}
                                className="opacity-0 group-hover:opacity-100 transition-opacity w-6 h-6 flex items-center justify-center rounded-full hover:bg-gray-100 text-gray-400 hover:text-gray-600 flex-shrink-0 mb-1"
                              >
                                {replyIcon}
                              </button>
                              <div className="flex flex-col items-end max-w-[85%] sm:max-w-[72%]">
                                <div className="flex items-baseline gap-1.5 mb-1 justify-end">
                                  {m.msg_type === "topic" && (
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
                                {isSecretExpired ? (
                                  <div className="an-secret-veil is-expired">
                                    <span className="an-secret-veil-icon">
                                      🔒
                                    </span>
                                    <div className="an-secret-veil-body">
                                      <span className="an-secret-veil-label">
                                        加密消息已过期
                                      </span>
                                      <span className="an-secret-veil-meta">
                                        一次性查看窗口已关闭
                                      </span>
                                    </div>
                                  </div>
                                ) : isSecretUnrevealed ? (
                                  <div className="an-secret-veil">
                                    <span className="an-secret-veil-icon">
                                      🔒
                                    </span>
                                    <div className="an-secret-veil-body">
                                      <span className="an-secret-veil-label">
                                        加密消息
                                      </span>
                                      <span className="an-secret-veil-meta">
                                        {secretSecsLeft !== null
                                          ? `剩余 ${secretSecsLeft}s · 仅 Bot 可读`
                                          : "仅 Bot 可读"}
                                      </span>
                                    </div>
                                    {secretTokens[m.msg_id] && (
                                      <button
                                        type="button"
                                        className="an-secret-veil-reveal"
                                        onClick={() =>
                                          revealSecretMessage(m.msg_id)
                                        }
                                      >
                                        查看
                                      </button>
                                    )}
                                  </div>
                                ) : (
                                  <div
                                    className="bg-[#1264A3] text-white rounded-2xl rounded-tr-sm px-3.5 py-2 text-[14px] leading-relaxed break-words"
                                  >
                                    {(() => {
                                      const q =
                                        parseQuotePrefix(displayContent);
                                      if (q)
                                        return (
                                          <>
                                            <div className="border-l-2 border-white/50 pl-2 mb-2 text-[12px] leading-snug opacity-80">
                                              <span className="font-semibold block">
                                                {q.label}
                                              </span>
                                              <span className="block line-clamp-2">
                                                {q.quote}
                                              </span>
                                            </div>
                                            <div className="whitespace-pre-wrap">
                                              {q.rest
                                                .replace(
                                                  /!\[.*?\]\(.*?\)\s*/g,
                                                  "",
                                                )
                                                .trim() || q.rest}
                                            </div>
                                          </>
                                        );
                                      return (
                                        <span className="whitespace-pre-wrap">
                                          {displayContent
                                            .replace(/!\[.*?\]\(.*?\)\s*/g, "")
                                            .trim() || displayContent}
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
                            className="group flex items-start gap-2.5 px-4 py-1 transition-all"
                          >
                            <div className="flex-shrink-0 mt-0.5">
                              {m.sender_type === "bot" ? (
                                senderBot?.avatar_url ? (
                                  <img
                                    src={senderBot.avatar_url}
                                    alt={botLabel}
                                    className="w-8 h-8 rounded-xl object-cover"
                                  />
                                ) : (
                                  <div className="w-8 h-8 rounded-xl bg-[#2EB67D] flex items-center justify-center text-white text-xs font-bold select-none">
                                    {botInitials}
                                  </div>
                                )
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
                                {m.msg_type === "topic" && (
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
                                {isSecretExpired ? (
                                  <div className="an-secret-veil is-expired">
                                    <span className="an-secret-veil-icon">
                                      🔒
                                    </span>
                                    <div className="an-secret-veil-body">
                                      <span className="an-secret-veil-label">
                                        加密消息已过期
                                      </span>
                                      <span className="an-secret-veil-meta">
                                        一次性查看窗口已关闭
                                      </span>
                                    </div>
                                  </div>
                                ) : isSecretUnrevealed ? (
                                  <div className="an-secret-veil">
                                    <span className="an-secret-veil-icon">
                                      🔒
                                    </span>
                                    <div className="an-secret-veil-body">
                                      <span className="an-secret-veil-label">
                                        加密消息
                                      </span>
                                      <span className="an-secret-veil-meta">
                                        {secretSecsLeft !== null
                                          ? `剩余 ${secretSecsLeft}s · 仅 Bot 可读`
                                          : "仅 Bot 可读"}
                                      </span>
                                    </div>
                                    {secretTokens[m.msg_id] && (
                                      <button
                                        type="button"
                                        className="an-secret-veil-reveal"
                                        onClick={() =>
                                          revealSecretMessage(m.msg_id)
                                        }
                                      >
                                        查看
                                      </button>
                                    )}
                                  </div>
                                ) : m._streaming && !text ? (
                                  <span className="inline-block w-2 h-4 bg-gray-400 rounded-sm animate-pulse align-middle" />
                                ) : (
                                  renderWithThinkFolding(
                                    text,
                                    `${m.msg_id}-`,
                                    !!m._streaming,
                                    (src) => {
                                      setLightboxSrc(src);
                                      const m2 = src.match(
                                        /\/files\/([^/]+)\/preview/,
                                      );
                                      setLightboxFileId(m2 ? m2[1] : null);
                                    },
                                    (url, name) =>
                                      setFilePreviewPanel({
                                        url,
                                        filename: name,
                                      }),
                                  )
                                )}
                                {!isSecretUnrevealed &&
                                  m._streaming &&
                                  !!text && (
                                    <span className="inline-block w-1.5 h-4 bg-gray-400 rounded-sm animate-pulse align-middle ml-0.5" />
                                  )}
                              </div>
                              {form &&
                                selectedId &&
                                m.sender_type === "bot" && (
                                  <GuideFormBlock
                                    msgId={m.msg_id}
                                    form={form}
                                    channelId={selectedId}
                                    onReply={(newMsg) =>
                                      setMessages((prev) => [...prev, newMsg])
                                    }
                                    onChannelsRefresh={() =>
                                      refreshChannels(
                                        setChannels,
                                        authToken ?? undefined,
                                      )
                                    }
                                    userToken={authToken ?? undefined}
                                  />
                                )}
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
                            <button
                              type="button"
                              title="回复"
                              onClick={() => {
                                setReplyingTo(m);
                                const mention =
                                  m.sender_type === "bot" && senderBot?.username
                                    ? `@${senderBot.username} `
                                    : "";
                                if (mention) setInput(mention);
                                (secretMode
                                  ? secretInputRef.current
                                  : inputRef.current
                                )?.focus();
                              }}
                              className="opacity-0 group-hover:opacity-100 transition-opacity self-center w-6 h-6 flex items-center justify-center rounded-full hover:bg-gray-200 text-gray-400 hover:text-gray-600 flex-shrink-0"
                            >
                              {replyIcon}
                            </button>
                          </div>
                        );

                        // ── topic card ───────────────────────────────────────
                        // An explicit 主题 (msg_type="topic") should render
                        // as a topic card regardless of reply count, so the
                        // user sees the intent reflected immediately. The
                        // 4-reply threshold only gates implicit promotion of
                        // a normal message that's accumulated replies.
                        const isExplicitTopic = m.msg_type === "topic";
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
                              ? channelBots.find(
                                  (b) => b.member_id === r.sender_id,
                                )
                              : undefined;
                          const rSenderUser =
                            r.sender_type === "user" && !rIsOwn
                              ? channelUsers.find(
                                  (u) => u.member_id === r.sender_id,
                                )
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
                            form: rForm,
                            clarify: rClarify,
                          } = parseGuidePayload(r.content);
                          const rDisplay = isClarifyReplyUserMessage(r.content)
                            ? r.content
                                .replace(
                                  /^@(?:channel bot|引导)\s*澄清回答[：:]\s*/i,
                                  "",
                                )
                                .trim()
                            : rTextRaw || r.content;
                          const rClarifyAnswered =
                            !!rClarify &&
                            messages.some(
                              (x) =>
                                x.in_reply_to_msg_id === r.msg_id &&
                                isClarifyReplyUserMessage(x.content),
                            );
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
                                  : `group flex gap-2.5 px-4 py-1 transition-all ${
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
                                    {r._streaming && !rTextRaw ? (
                                      <span className="inline-block w-2 h-4 bg-gray-400 rounded-sm animate-pulse align-middle" />
                                    ) : (
                                      renderWithThinkFolding(
                                        rDisplay,
                                        `${r.msg_id}-`,
                                        !!r._streaming,
                                        (src) => {
                                          setLightboxSrc(src);
                                          const m2 = src.match(
                                            /\/files\/([^/]+)\/preview/,
                                          );
                                          setLightboxFileId(m2 ? m2[1] : null);
                                        },
                                        (url, name) =>
                                          setFilePreviewPanel({
                                            url,
                                            filename: name,
                                          }),
                                      )
                                    )}
                                    {r._streaming && !!rTextRaw && (
                                      <span className="inline-block w-1.5 h-4 bg-gray-400 rounded-sm animate-pulse align-middle ml-0.5" />
                                    )}
                                  </div>
                                  {rForm &&
                                    selectedId &&
                                    r.sender_type === "bot" && (
                                      <GuideFormBlock
                                        msgId={r.msg_id}
                                        form={rForm}
                                        channelId={selectedId}
                                        onReply={(newMsg) =>
                                          setMessages((prev) => [
                                            ...prev,
                                            newMsg,
                                          ])
                                        }
                                        onChannelsRefresh={() =>
                                          refreshChannels(
                                            setChannels,
                                            authToken ?? undefined,
                                          )
                                        }
                                        userToken={authToken ?? undefined}
                                      />
                                    )}
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
                                    <svg
                                      viewBox="0 0 16 16"
                                      fill="none"
                                      stroke="currentColor"
                                      strokeWidth="1.5"
                                      strokeLinecap="round"
                                      strokeLinejoin="round"
                                      className="w-3.5 h-3.5"
                                    >
                                      <rect x="5" y="5" width="8" height="9" rx="1.5" />
                                      <path d="M5 11H3.5A1.5 1.5 0 0 1 2 9.5v-6A1.5 1.5 0 0 1 3.5 2h6A1.5 1.5 0 0 1 11 3.5V5" />
                                    </svg>
                                  </button>
                                  <button
                                    type="button"
                                    title="回复"
                                    onClick={() => {
                                      setReplyingTo(r);
                                      const mention =
                                        r.sender_type === "bot" && rBot?.username
                                          ? `@${rBot.username} `
                                          : "";
                                      if (mention) setInput(mention);
                                      (secretMode
                                        ? secretInputRef.current
                                        : inputRef.current
                                      )?.focus();
                                    }}
                                    className="an-chat-action"
                                  >
                                    <svg
                                      xmlns="http://www.w3.org/2000/svg"
                                      viewBox="0 0 16 16"
                                      fill="currentColor"
                                      className="w-3.5 h-3.5"
                                    >
                                      <path
                                        fillRule="evenodd"
                                        d="M1.22 6.53a.75.75 0 0 1 0-1.06l3-3a.75.75 0 0 1 1.06 1.06L3.56 5.25H10a5.75 5.75 0 0 1 0 11.5H6a.75.75 0 0 1 0-1.5h4a4.25 4.25 0 0 0 0-8.5H3.56l1.72 1.72a.75.75 0 1 1-1.06 1.06l-3-3Z"
                                        clipRule="evenodd"
                                      />
                                    </svg>
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
                              const b = channelBots.find(
                                (x) => x.member_id === sid,
                              );
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
                                : channelUsers.find(
                                    (x) => x.member_id === sid,
                                  );
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
                                avatarUrl: u?.avatar_url,
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
                                <svg
                                  xmlns="http://www.w3.org/2000/svg"
                                  viewBox="0 0 16 16"
                                  fill="currentColor"
                                  className="w-3.5 h-3.5 text-[#1264A3]"
                                >
                                  <path
                                    fillRule="evenodd"
                                    d="M1 3.5A1.5 1.5 0 0 1 2.5 2h11A1.5 1.5 0 0 1 15 3.5v6A1.5 1.5 0 0 1 13.5 11H9.25l-2.35 2.35A.75.75 0 0 1 5.5 12.75V11H2.5A1.5 1.5 0 0 1 1 9.5v-6Z"
                                    clipRule="evenodd"
                                  />
                                </svg>
                                <span className="text-[12px] font-medium text-[#1264A3]">
                                  主题 · {replies.length + 1} 条消息
                                </span>
                              </div>
                              <div className="flex items-center gap-1">
                                <button
                                  type="button"
                                  onClick={() => setOpenTopicId(m.msg_id)}
                                  className="flex items-center gap-1 text-[11px] text-gray-500 hover:text-[#1264A3] px-1.5 py-0.5 rounded hover:bg-white/80 transition-colors"
                                  title="在侧栏打开主题"
                                >
                                  <svg
                                    viewBox="0 0 12 12"
                                    width="10"
                                    height="10"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="1.5"
                                  >
                                    <path d="M4 2H2v8h8V8" strokeLinecap="round" />
                                    <path d="M7 2h3v3M10 2L6 6" strokeLinecap="round" />
                                  </svg>
                                  在侧栏打开
                                </button>
                                <button
                                  type="button"
                                  onClick={() => toggleTopic(m.msg_id)}
                                  className="flex items-center gap-1 text-[11px] text-gray-500 hover:text-gray-700 px-1.5 py-0.5 rounded hover:bg-white/80 transition-colors"
                                >
                                  <svg
                                    xmlns="http://www.w3.org/2000/svg"
                                    viewBox="0 0 16 16"
                                    fill="currentColor"
                                    className="w-3 h-3"
                                  >
                                    <path
                                      fillRule="evenodd"
                                      d="M11.78 9.78a.75.75 0 0 1-1.06 0L8 7.06 5.28 9.78a.75.75 0 0 1-1.06-1.06l3.25-3.25a.75.75 0 0 1 1.06 0l3.25 3.25a.75.75 0 0 1 0 1.06Z"
                                      clipRule="evenodd"
                                    />
                                  </svg>
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
                                    ? channelBots.find(
                                        (b) => b.member_id === r.sender_id,
                                      )
                                    : undefined;
                                const rSenderUser =
                                  r.sender_type === "user" && !rIsOwn
                                    ? channelUsers.find(
                                        (u) => u.member_id === r.sender_id,
                                      )
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
                                  form: rForm,
                                  clarify: rClarify,
                                } = parseGuidePayload(r.content);
                                const rDisplay = isClarifyReplyUserMessage(
                                  r.content,
                                )
                                  ? r.content
                                      .replace(
                                        /^@(?:channel bot|引导)\s*澄清回答[：:]\s*/i,
                                        "",
                                      )
                                      .trim()
                                  : rTextRaw || r.content;
                                const rClarifyAnswered =
                                  !!rClarify &&
                                  messages.some(
                                    (x) =>
                                      x.in_reply_to_msg_id === r.msg_id &&
                                      isClarifyReplyUserMessage(x.content),
                                  );
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
                                    ? messages.find(
                                        (x) =>
                                          x.msg_id === r.in_reply_to_msg_id,
                                      )
                                    : null;
                                const rParentBot =
                                  rDirectParent?.sender_type === "bot"
                                    ? channelBots.find(
                                        (b) =>
                                          b.member_id ===
                                          rDirectParent.sender_id,
                                      )
                                    : null;
                                const rParentSenderUser =
                                  rDirectParent?.sender_type === "user" &&
                                  rDirectParent.sender_id !== currentUserId
                                    ? channelUsers.find(
                                        (u) =>
                                          u.member_id ===
                                          rDirectParent.sender_id,
                                      )
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
                                          <svg
                                            xmlns="http://www.w3.org/2000/svg"
                                            viewBox="0 0 16 16"
                                            fill="currentColor"
                                            className="w-3 h-3"
                                          >
                                            {rCollapsed ? (
                                              <path
                                                fillRule="evenodd"
                                                d="M4.22 6.22a.75.75 0 0 1 1.06 0L8 8.94l2.72-2.72a.75.75 0 1 1 1.06 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0L4.22 7.28a.75.75 0 0 1 0-1.06Z"
                                                clipRule="evenodd"
                                              />
                                            ) : (
                                              <path
                                                fillRule="evenodd"
                                                d="M11.78 9.78a.75.75 0 0 1-1.06 0L8 7.06 5.28 9.78a.75.75 0 0 1-1.06-1.06l3.25-3.25a.75.75 0 0 1 1.06 0l3.25 3.25a.75.75 0 0 1 0 1.06Z"
                                                clipRule="evenodd"
                                              />
                                            )}
                                          </svg>
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
                                              renderWithThinkFolding(
                                                rDisplay,
                                                `${r.msg_id}-t-`,
                                                !!r._streaming,
                                                (src) => {
                                                  setLightboxSrc(src);
                                                  const m2 = src.match(
                                                    /\/files\/([^/]+)\/preview/,
                                                  );
                                                  setLightboxFileId(
                                                    m2 ? m2[1] : null,
                                                  );
                                                },
                                                (url, name) =>
                                                  setFilePreviewPanel({
                                                    url,
                                                    filename: name,
                                                  }),
                                              )
                                            )}
                                            {r._streaming && !!rTextRaw && (
                                              <span className="inline-block w-1.5 h-4 bg-gray-400 rounded-sm animate-pulse align-middle ml-0.5" />
                                            )}
                                          </div>
                                          {rForm &&
                                            selectedId &&
                                            r.sender_type === "bot" && (
                                              <GuideFormBlock
                                                msgId={r.msg_id}
                                                form={rForm}
                                                channelId={selectedId}
                                                onReply={(newMsg) =>
                                                  setMessages((prev) => [
                                                    ...prev,
                                                    newMsg,
                                                  ])
                                                }
                                                onChannelsRefresh={() =>
                                                  refreshChannels(
                                                    setChannels,
                                                    authToken ?? undefined,
                                                  )
                                                }
                                                userToken={
                                                  authToken ?? undefined
                                                }
                                              />
                                            )}
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
                                        if (mention) setInput(mention);
                                        (secretMode
                                          ? secretInputRef.current
                                          : inputRef.current
                                        )?.focus();
                                      }}
                                      className="opacity-0 group-hover/tr:opacity-100 transition-opacity self-center w-6 h-6 flex items-center justify-center rounded-full hover:bg-gray-200 text-gray-400 hover:text-gray-600 flex-shrink-0"
                                    >
                                      <svg
                                        xmlns="http://www.w3.org/2000/svg"
                                        viewBox="0 0 16 16"
                                        fill="currentColor"
                                        className="w-3 h-3"
                                      >
                                        <path
                                          fillRule="evenodd"
                                          d="M1.22 6.53a.75.75 0 0 1 0-1.06l3-3a.75.75 0 0 1 1.06 1.06L3.56 5.25H10a5.75 5.75 0 0 1 0 11.5H6a.75.75 0 0 1 0-1.5h4a4.25 4.25 0 0 0 0-8.5H3.56l1.72 1.72a.75.75 0 1 1-1.06 1.06l-3-3Z"
                                          clipRule="evenodd"
                                        />
                                      </svg>
                                    </button>
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
                                <svg
                                  xmlns="http://www.w3.org/2000/svg"
                                  viewBox="0 0 16 16"
                                  fill="currentColor"
                                  className="w-3 h-3"
                                >
                                  <path
                                    fillRule="evenodd"
                                    d="M11.78 9.78a.75.75 0 0 1-1.06 0L8 7.06 5.28 9.78a.75.75 0 0 1-1.06-1.06l3.25-3.25a.75.75 0 0 1 1.06 0l3.25 3.25a.75.75 0 0 1 0 1.06Z"
                                    clipRule="evenodd"
                                  />
                                </svg>
                                收起主题
                              </button>
                            </div>
                          </div>
                          </div>
                        );
                      });
                      // Intersperse day dividers between message groups based
                      // on their created_at calendar day. Purely presentational
                      // — runs outside the big map callback so none of the
                      // existing branch logic has to change.
                      const out: React.ReactNode[] = [];
                      let lastDay = "";
                      for (let i = 0; i < topicRoots.length; i++) {
                        const m = topicRoots[i];
                        const day = formatDayLabel(m.created_at);
                        if (day && day !== lastDay) {
                          out.push(
                            <div
                              key={`day-${i}-${day}`}
                              className="an-day-divider"
                            >
                              <span>{day}</span>
                            </div>,
                          );
                          lastDay = day;
                        }
                        out.push(renderedRows[i]);
                      }
                      return out;
                      })()}
                      {waitingForBotReply && <ThinkingIndicator />}
                      {Object.entries(processingBots).map(
                        ([botId, username]) => (
                          <div key={botId} className="flex gap-3 px-3 py-2">
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
                  {/* Kind switcher — hidden in DMs and when replying to a
                      specific message (that flow forces msg_type="reply"). */}
                  {!replyingTo && selectedChannel?.type !== "dm" && (
                    <div className="an-msgkind-switcher">
                      <button
                        type="button"
                        onClick={() => cycleMsgKind(-1)}
                        className="an-msgkind-arrow"
                        title="上一种消息类型 (Shift+Tab)"
                        aria-label="上一种消息类型"
                      >
                        ‹
                      </button>
                      <span
                        className={
                          "an-msgkind-label" +
                          (msgKind === "announcement"
                            ? " is-announcement"
                            : msgKind === "topic"
                              ? " is-topic"
                              : "")
                        }
                        title="Tab 切换 · Shift+Tab 反向"
                      >
                        {msgKind === "announcement"
                          ? "📣"
                          : msgKind === "topic"
                            ? "🧵"
                            : "💬"}{" "}
                        {MSG_KIND_LABEL[msgKind]}
                      </span>
                      <button
                        type="button"
                        onClick={() => cycleMsgKind(1)}
                        className="an-msgkind-arrow"
                        title="下一种消息类型 (Tab)"
                        aria-label="下一种消息类型"
                      >
                        ›
                      </button>
                    </div>
                  )}
                  {/* Reply bar */}
                  {replyingTo &&
                    (() => {
                      const refBot =
                        replyingTo.sender_type === "bot"
                          ? channelBots.find(
                              (b) => b.member_id === replyingTo.sender_id,
                            )
                          : null;
                      const refLabel =
                        replyingTo.sender_type === "bot"
                          ? refBot?.display_name || refBot?.username || "Bot"
                          : "我";
                      const refPreview = (
                        parseGuidePayload(replyingTo.content).text ||
                        replyingTo.content
                      )
                        .replace(/\n/g, " ")
                        .slice(0, 80);
                      return (
                        <div className="an-reply-quote mb-1" style={{ maxWidth: "none" }}>
                          <span className="an-rq-arrow">↪</span>
                          <span className="an-rq-name">{refLabel}</span>
                          <span className="an-rq-snip">
                            {refPreview}
                            {(
                              parseGuidePayload(replyingTo.content).text ||
                              replyingTo.content
                            ).length > 80
                              ? "…"
                              : ""}
                          </span>
                          <button
                            type="button"
                            onClick={() => setReplyingTo(null)}
                            className="flex-shrink-0 w-5 h-5 flex items-center justify-center rounded-full hover:bg-[var(--surface-hover)]"
                            style={{ color: "var(--fg-3)" }}
                            title="取消回复"
                          >
                            <svg
                              xmlns="http://www.w3.org/2000/svg"
                              viewBox="0 0 16 16"
                              fill="currentColor"
                              className="w-3 h-3"
                            >
                              <path d="M5.28 4.22a.75.75 0 0 0-1.06 1.06L6.94 8l-2.72 2.72a.75.75 0 1 0 1.06 1.06L8 9.06l2.72 2.72a.75.75 0 1 0 1.06-1.06L9.06 8l2.72-2.72a.75.75 0 0 0-1.06-1.06L8 6.94 5.28 4.22Z" />
                            </svg>
                          </button>
                        </div>
                      );
                    })()}
                  {pendingFileNames.length > 0 && (
                    <div className="mb-2 flex flex-wrap gap-2">
                      {pendingFileNames.map((name, i) => {
                        const preview = pendingFilePreviews[i] ?? null;
                        const removeItem = () => {
                          if (preview) URL.revokeObjectURL(preview);
                          setPendingFileIds((p) => p.filter((_, j) => j !== i));
                          setPendingFileNames((p) =>
                            p.filter((_, j) => j !== i),
                          );
                          setPendingFilePreviews((p) =>
                            p.filter((_, j) => j !== i),
                          );
                        };
                        return preview ? (
                          <div
                            key={i}
                            className="relative group cursor-pointer rounded-xl overflow-hidden border border-gray-200 shadow-sm inline-block"
                          >
                            <img
                              src={preview}
                              alt={name}
                              className="max-w-[180px] max-h-[140px] object-cover block"
                            />
                            <div className="px-2.5 py-1.5 bg-white text-[11px] text-gray-500 border-t border-gray-100 flex items-center gap-1.5 max-w-[180px]">
                              <svg
                                xmlns="http://www.w3.org/2000/svg"
                                viewBox="0 0 16 16"
                                fill="currentColor"
                                className="w-3 h-3 text-gray-400 flex-shrink-0"
                              >
                                <path
                                  fillRule="evenodd"
                                  d="M2 4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4Zm10.5 5.707a.5.5 0 0 0-.146-.353l-2.5-2.5a.5.5 0 0 0-.708 0L7.5 8.5 6.354 7.354a.5.5 0 0 0-.708 0l-3.146 3.15V12a.5.5 0 0 0 .5.5h10a.5.5 0 0 0 .5-.5v-2.293ZM11 5.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"
                                  clipRule="evenodd"
                                />
                              </svg>
                              <span className="truncate">{name}</span>
                            </div>
                            <button
                              type="button"
                              onClick={removeItem}
                              className="absolute top-1 right-1 w-5 h-5 bg-black/50 text-white rounded-full text-[11px] leading-none items-center justify-center flex sm:hidden sm:group-hover:flex"
                            >
                              ×
                            </button>
                          </div>
                        ) : (
                          <div
                            key={i}
                            className="relative group flex items-center gap-2.5 px-3 py-2.5 bg-white border border-gray-200 rounded-xl shadow-sm max-w-[240px]"
                          >
                            <div className="w-9 h-9 rounded-lg bg-blue-50 flex items-center justify-center flex-shrink-0">
                              <svg
                                xmlns="http://www.w3.org/2000/svg"
                                viewBox="0 0 20 20"
                                fill="currentColor"
                                className="w-5 h-5 text-blue-500"
                              >
                                <path d="M3 3.5A1.5 1.5 0 0 1 4.5 2h6.879a1.5 1.5 0 0 1 1.06.44l3.122 3.12A1.5 1.5 0 0 1 16 6.622V16.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 16.5v-13Z" />
                              </svg>
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="text-[13px] font-medium text-gray-700 truncate">
                                {name}
                              </div>
                              <div className="text-[11px] text-gray-400">
                                待发送
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={removeItem}
                              className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-gray-500 text-white rounded-full text-[11px] leading-none items-center justify-center flex sm:hidden sm:group-hover:flex"
                            >
                              ×
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  <div className="relative">
                    <div
                      className={
                        "an-composer overflow-hidden" +
                        (!replyingTo && msgKind === "announcement"
                          ? " is-announcement"
                          : !replyingTo && msgKind === "topic"
                            ? " is-topic"
                            : "")
                      }
                    >
                      {!replyingTo &&
                        (msgKind === "announcement" ||
                          msgKind === "topic") && (
                          <div className="an-composer-kindhead">
                            <span className="an-composer-kindhead-tag">
                              {msgKind === "announcement"
                                ? "📣 公告"
                                : "🧵 主题"}
                            </span>
                            <input
                              ref={composerTitleRef}
                              className="an-composer-title"
                              placeholder={
                                msgKind === "announcement"
                                  ? "标题（可选，例如「周五发布窗口」）…"
                                  : "主题标题（可选，例如「升级计划讨论」）…"
                              }
                              value={composerTitle}
                              onChange={(e) =>
                                setComposerTitle(e.target.value)
                              }
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  e.preventDefault();
                                  inputRef.current?.focus();
                                }
                              }}
                              maxLength={120}
                            />
                          </div>
                        )}
                      <textarea
                        ref={inputRef}
                        value={input}
                        onChange={(e) => {
                          const v = e.target.value;
                          const pos = e.target.selectionStart ?? v.length;
                          setInput(v);
                          if (!secretMode) {
                            const lastAt = v.lastIndexOf("@", pos - 1);
                            if (lastAt !== -1) {
                              const after = v.slice(lastAt + 1, pos);
                              if (
                                !after.includes(" ") &&
                                !after.includes("\n")
                              ) {
                                const rect = e.target.getBoundingClientRect();
                                const spaceBelow =
                                  window.innerHeight - rect.bottom;
                                const spaceAbove = rect.top;
                                if (
                                  spaceBelow < 180 &&
                                  spaceAbove > spaceBelow
                                ) {
                                  setMentionDropdownPlacement("top");
                                } else {
                                  setMentionDropdownPlacement("bottom");
                                }
                                setShowMentionDropdown(true);
                                setMentionFilter(after);
                                return;
                              }
                            }
                          }
                          setShowMentionDropdown(false);
                        }}
                        onKeyDown={(e) => {
                          if (showMentionDropdown && e.key === "Escape") {
                            setShowMentionDropdown(false);
                            return;
                          }
                          // Tab / Shift-Tab cycles msgKind (normal → 公告 →
                          // 主题 → normal …). Skip in DMs where only
                          // "normal" makes sense.
                          if (
                            e.key === "Tab" &&
                            !showMentionDropdown &&
                            !replyingTo &&
                            selectedChannel?.type !== "dm"
                          ) {
                            e.preventDefault();
                            cycleMsgKind(e.shiftKey ? -1 : 1);
                            return;
                          }
                          // Enter sends · Shift+Enter inserts newline
                          if (
                            e.key === "Enter" &&
                            !e.shiftKey &&
                            !e.nativeEvent.isComposing &&
                            !showMentionDropdown
                          ) {
                            e.preventDefault();
                            if (input.trim() || pendingFileIds.length > 0) {
                              send();
                            }
                          }
                        }}
                        placeholder={
                          secretMode
                            ? "输入加密内容（仅 Bot 可读取原文）…"
                            : msgKind === "announcement"
                              ? `发布公告到 #${selectedChannel?.name || "频道"}…`
                              : msgKind === "topic"
                                ? `开启主题 · 标题将取首行…`
                                : `发消息到 #${selectedChannel?.name || "频道"}，@ 呼叫 Bot…`
                        }
                        className="an-composer-textarea"
                        style={
                          secretMode ? { color: "var(--orange)" } : undefined
                        }
                        rows={1}
                      />
                      {/* Input toolbar */}
                      <div className="an-composer-bar">
                        <div className="flex items-center gap-0.5">
                          {/* 上传文件和图片菜单 */}
                          <input
                            ref={fileImgInputRef}
                            type="file"
                            accept=".txt,.md,.docx,.pdf,.xlsx,.png,.jpg,.jpeg,.webp,.gif"
                            className="hidden"
                            onChange={uploadFile}
                          />
                          {/* Keychain insert button */}
                          {currentUser && (
                            <div ref={keychainPopupRef} className="relative">
                              <button
                                type="button"
                                onClick={openKeychainPopup}
                                className="w-8 h-8 flex items-center justify-center rounded-lg transition-colors"
                                style={{
                                  color: keychainPopupOpen ? "var(--accent)" : "var(--fg-3)",
                                  background: keychainPopupOpen ? "var(--accent-muted)" : "transparent",
                                }}
                                title="插入密钥链"
                              >
                                <svg
                                  xmlns="http://www.w3.org/2000/svg"
                                  viewBox="0 0 20 20"
                                  fill="currentColor"
                                  className="w-4 h-4"
                                >
                                  <path
                                    fillRule="evenodd"
                                    d="M8 7a5 5 0 1 1 3.61 4.804l-1.903 1.903A1 1 0 0 1 9 14H8v1a1 1 0 0 1-1 1H6v1a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-2a1 1 0 0 1 .293-.707L7.196 10.39A5.002 5.002 0 0 1 8 7Zm5-3a.75.75 0 0 0 0 1.5A1.5 1.5 0 0 1 14.5 7 .75.75 0 0 0 16 7a3 3 0 0 0-3-3Z"
                                    clipRule="evenodd"
                                  />
                                </svg>
                              </button>
                              {keychainPopupOpen && (
                                <div className="an-menu absolute" style={{ bottom: 40, left: 0, minWidth: 220, maxHeight: 256, overflowY: "auto" }}>
                                  <div className="an-menu-head">插入密钥</div>
                                  {keychainPopupLoading ? (
                                    <div className="an-menu-empty">加载中…</div>
                                  ) : keychainPopupItems.length === 0 ? (
                                    <div className="an-menu-empty">
                                      暂无密钥
                                      <br />
                                      <span style={{ opacity: 0.7 }}>点击侧边栏钥匙图标添加</span>
                                    </div>
                                  ) : (
                                    keychainPopupItems.map((item) => (
                                      <button
                                        key={item.key_id}
                                        type="button"
                                        onClick={() => insertSecret(item.name)}
                                        className="an-menu-item"
                                      >
                                        <span className="an-mi-ico">
                                          <svg
                                            xmlns="http://www.w3.org/2000/svg"
                                            viewBox="0 0 16 16"
                                            fill="currentColor"
                                            className="w-3.5 h-3.5"
                                          >
                                            <path
                                              fillRule="evenodd"
                                              d="M6.5 5.5a4 4 0 1 1 2.88 3.838.75.75 0 0 0-.88.72V11h1.25a.75.75 0 0 1 0 1.5H8.5v1.25a.75.75 0 0 1-1.5 0v-3.44a5.5 5.5 0 1 1 5.5-5.31.75.75 0 0 1-1.499.05A4.001 4.001 0 0 0 6.5 5.5Zm.5 0a.5.5 0 1 0 0-1 .5.5 0 0 0 0 1Z"
                                              clipRule="evenodd"
                                            />
                                          </svg>
                                        </span>
                                        <span className="font-mono truncate">{item.name}</span>
                                      </button>
                                    ))
                                  )}
                                </div>
                              )}
                            </div>
                          )}

                          <div ref={uploadMenuRef} className="relative">
                            <button
                              type="button"
                              onClick={() => setUploadMenuOpen((o) => !o)}
                              className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
                              title="上传文件和图片"
                            >
                              <svg
                                xmlns="http://www.w3.org/2000/svg"
                                viewBox="0 0 20 20"
                                fill="currentColor"
                                className="w-4.5 h-4.5"
                              >
                                <path d="M10.75 4.75a.75.75 0 0 0-1.5 0v4.5h-4.5a.75.75 0 0 0 0 1.5h4.5v4.5a.75.75 0 0 0 1.5 0v-4.5h4.5a.75.75 0 0 0 0-1.5h-4.5v-4.5Z" />
                              </svg>
                            </button>
                            {uploadMenuOpen && (
                              <div className="an-menu absolute" style={{ bottom: 40, left: 0, minWidth: 180 }}>
                                <button
                                  type="button"
                                  className="an-menu-item"
                                  onClick={() => {
                                    setUploadMenuOpen(false);
                                    fileImgInputRef.current?.click();
                                  }}
                                >
                                  <span className="an-mi-ico">
                                    <svg
                                      xmlns="http://www.w3.org/2000/svg"
                                      viewBox="0 0 16 16"
                                      fill="currentColor"
                                      className="w-4 h-4"
                                    >
                                      <path
                                        fillRule="evenodd"
                                        d="M15.621 4.379a3 3 0 0 0-4.242 0l-7 7a3 3 0 0 0 4.241 4.243h.001l.497-.5a.75.75 0 0 1 1.064 1.057l-.498.501-.002.002a4.5 4.5 0 0 1-6.364-6.364l7-7a4.5 4.5 0 0 1 6.368 6.36l-3.455 3.553A2.625 2.625 0 1 1 9.52 9.52l3.45-3.451a.75.75 0 1 1 1.061 1.06l-3.45 3.451a1.125 1.125 0 0 0 1.587 1.595l3.454-3.553a3 3 0 0 0 0-4.242Z"
                                        clipRule="evenodd"
                                      />
                                    </svg>
                                  </span>
                                  <span>上传文件和图片</span>
                                </button>
                              </div>
                            )}
                          </div>
                        </div>
                        <span className="an-composer-hint hidden sm:inline-flex">
                          <kbd>@</kbd> 提及
                          <span style={{ opacity: 0.5 }}>·</span>
                          <kbd>↵</kbd> 发送
                          <span style={{ opacity: 0.5 }}>·</span>
                          <kbd>⇧↵</kbd> 换行
                        </span>
                        <button
                          type="button"
                          onClick={() => setSecretMode((v) => !v)}
                          title={
                            secretMode
                              ? "取消加密模式"
                              : "开启加密模式（仅 Bot 可读原文）"
                          }
                          style={
                            secretMode
                              ? { color: "var(--orange)", background: "var(--orange-muted)" }
                              : undefined
                          }
                        >
                          🔒
                        </button>
                        <button
                          type="button"
                          onClick={send}
                          className="an-composer-send"
                          disabled={
                            !input.trim() && pendingFileIds.length === 0
                          }
                          style={
                            secretMode && (input.trim() || pendingFileIds.length > 0)
                              ? { background: "var(--orange)" }
                              : undefined
                          }
                        >
                          {secretMode ? "加密发送" : "发送"}
                        </button>
                      </div>
                    </div>
                    {showMentionDropdown &&
                      (() => {
                        const allItems = [
                          ...channelBots.map((b) => ({
                            ...b,
                            kind: "bot" as const,
                          })),
                          ...channelUsers.map((u) => ({
                            ...u,
                            kind: "user" as const,
                          })),
                        ];
                        const matched = allItems.filter(
                          (item) =>
                            item.username
                              .toLowerCase()
                              .includes(mentionFilter.toLowerCase()) ||
                            (item.display_name ?? "")
                              .toLowerCase()
                              .includes(mentionFilter.toLowerCase()),
                        );
                        if (matched.length === 0) return null;
                        const placementClass =
                          mentionDropdownPlacement === "top"
                            ? "bottom-full mb-1"
                            : "top-full mt-1";
                        return (
                          <ul
                            className={`an-menu absolute left-0 right-0 ${placementClass}`}
                            style={{ maxHeight: 240, overflowY: "auto" }}
                            role="listbox"
                          >
                            <li className="an-menu-head" style={{ listStyle: "none" }}>
                              @提及 · {matched.length} 项
                            </li>
                            {matched.map((item) => (
                              <li
                                key={item.member_id}
                                role="option"
                                className="an-menu-item"
                                style={{ listStyle: "none" }}
                                onMouseDown={(e) => {
                                  e.preventDefault();
                                  const el = inputRef.current;
                                  if (!el) return;
                                  const v = el.value;
                                  const pos = el.selectionStart ?? v.length;
                                  const lastAt = v.lastIndexOf("@", pos - 1);
                                  const newVal =
                                    v.slice(0, lastAt) +
                                    "@" +
                                    item.username +
                                    " " +
                                    v.slice(pos);
                                  setInput(newVal);
                                  setShowMentionDropdown(false);
                                  setTimeout(() => {
                                    el.focus();
                                    el.setSelectionRange(
                                      lastAt + item.username.length + 2,
                                      lastAt + item.username.length + 2,
                                    );
                                  }, 0);
                                }}
                              >
                                <span
                                  className="an-mi-ico"
                                  style={{
                                    width: 22,
                                    height: 22,
                                    borderRadius: 5,
                                    color: "#fff",
                                    fontSize: 10,
                                    fontWeight: 700,
                                    background:
                                      item.kind === "bot"
                                        ? "var(--green)"
                                        : "var(--accent)",
                                  }}
                                >
                                  {item.username.slice(0, 1).toUpperCase()}
                                </span>
                                <div className="flex flex-col min-w-0 flex-1">
                                  <span
                                    className="font-medium truncate"
                                    style={{ color: "var(--fg-1)" }}
                                  >
                                    @{item.username}
                                  </span>
                                  {item.display_name && (
                                    <span className="an-mi-sub truncate">
                                      {item.display_name}
                                    </span>
                                  )}
                                </div>
                                <span
                                  className="text-[10px] px-1.5 py-0.5 rounded flex-shrink-0"
                                  style={{
                                    background:
                                      item.kind === "bot"
                                        ? "var(--green-muted)"
                                        : "var(--accent-muted)",
                                    color:
                                      item.kind === "bot"
                                        ? "var(--green)"
                                        : "var(--accent)",
                                  }}
                                >
                                  {item.kind === "bot" ? "Bot" : "用户"}
                                </span>
                              </li>
                            ))}
                          </ul>
                        );
                      })()}
                  </div>
                </div>

                <ImageGenModal
                  open={imageGenOpen}
                  onClose={() => setImageGenOpen(false)}
                  channelId={selectedId}
                  senderId={currentUserId}
                  messages={messages}
                  onMessageSent={(msg) =>
                    setMessages((prev) =>
                      prev.some((m) => m.msg_id === msg.msg_id)
                        ? prev
                        : [...prev, msg],
                    )
                  }
                  initialSourceFileId={imageGenInitialSourceFileId}
                  initialTab={imageGenInitialTab}
                />
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
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        fill="none"
                        viewBox="0 0 24 24"
                        strokeWidth={1.5}
                        stroke="currentColor"
                        className="w-6 h-6"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5"
                        />
                      </svg>
                    </button>
                    <span className="text-sm font-semibold text-gray-700">
                      智枢协作
                    </span>
                  </div>
                )}
                <div className="flex-1 flex flex-col items-center justify-center text-center p-8">
                  <div className="w-20 h-20 rounded-3xl bg-gray-100 flex items-center justify-center mb-5">
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                      className="w-10 h-10 text-gray-300"
                    >
                      <path
                        fillRule="evenodd"
                        d="M4.848 2.771A49.144 49.144 0 0 1 12 2.25c2.43 0 4.817.178 7.152.52 1.978.292 3.348 2.024 3.348 3.97v6.02c0 1.946-1.37 3.678-3.348 3.97a48.901 48.901 0 0 1-3.476.383.39.39 0 0 0-.297.17l-2.755 4.133a.75.75 0 0 1-1.248 0l-2.755-4.133a.39.39 0 0 0-.297-.17 48.9 48.9 0 0 1-3.476-.384c-1.978-.29-3.348-2.024-3.348-3.97V6.741c0-1.946 1.37-3.68 3.348-3.97Z"
                        clipRule="evenodd"
                      />
                    </svg>
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
          </main>

          {/* Topic side panel (sibling of memory panel). Hidden while the
              full-page TopicPage is active — a side panel on top of a page
              view duplicates the same topic. */}
          {openTopicId && !pageTopicId && selectedId && (() => {
            const rootMsg = messages.find(
              (m) => m.msg_id === openTopicId,
            );
            if (!rootMsg) return null;
            const rootId = openTopicId;
            const topicReplies = messages
              .filter((m) => m.in_reply_to_msg_id === rootId)
              .sort((a, b) =>
                (a.created_at || "") < (b.created_at || "") ? -1 : 1,
              );
            return (
              <TopicPanel
                rootMsg={rootMsg}
                replies={topicReplies}
                channelBots={channelBots}
                channelUsers={channelUsers}
                currentUserId={currentUserId}
                onClose={() => setOpenTopicId(null)}
                onOpenAsPage={() => {
                  setPageTopicId(rootId);
                  setOpenTopicId(null);
                }}
                onJumpToParent={() => {
                  const el = document.getElementById(`msg-${rootId}`);
                  if (!el) return;
                  el.scrollIntoView({
                    block: "center",
                    behavior: "smooth",
                  });
                  const orig = el.style.transition;
                  const prev = el.style.background;
                  el.style.transition = "background 200ms";
                  el.style.background = "var(--accent-muted)";
                  setTimeout(() => {
                    el.style.background = prev;
                    el.style.transition = orig;
                  }, 1200);
                }}
                onSendReply={(text) =>
                  sendTopicReply(selectedId, rootId, text)
                }
              />
            );
          })()}

          {/* Memory right panel */}
          {memoryPanelOpen && selectedId && (
            <div
              className={
                isMobile
                  ? "fixed inset-0 z-[70] bg-white"
                  : "relative flex-shrink-0 flex"
              }
              style={{ width: isMobile ? "100%" : memoryWidth }}
            >
              {!isMobile && (
                <div
                  onMouseDown={onMemoryResize}
                  className="absolute top-0 left-0 h-full w-1 cursor-col-resize hover:bg-gray-300 transition-colors z-10"
                />
              )}
              <MemoryPanel
                channelId={selectedId}
                channelName={selectedChannel?.name ?? ""}
                contextData={contextData}
                activeLayer={memoryTab ?? undefined}
                onLayerChange={(l) =>
                  setMemoryTab(
                    l as "PROJECT" | "FILES_INDEX" | "MEMBERS" | "TODO",
                  )
                }
                onClose={() => setMemoryTab(null)}
                onExpand={() => {
                  setMemoryPageOpen(true);
                  setMemoryTab(null);
                }}
              />
            </div>
          )}
          {/* File preview sidebar */}
          {filePreviewPanel && (
            <div
              className={
                isMobile
                  ? "fixed inset-0 z-[70] bg-white"
                  : "relative flex-shrink-0 flex"
              }
              style={{ width: isMobile ? "100%" : filePreviewWidth }}
            >
              {!isMobile && (
                <div
                  onMouseDown={onFilePreviewResize}
                  className="absolute top-0 left-0 h-full w-1 cursor-col-resize hover:bg-gray-300 transition-colors z-10"
                />
              )}
              <FilePreviewSidebar
                url={filePreviewPanel.url}
                filename={filePreviewPanel.filename}
                onClose={() => setFilePreviewPanel(null)}
              />
            </div>
          )}
        </div>
      </div>

      {/* Memory full-page overlay */}
      {memoryPageOpen && selectedId && (
        <MemoryPage
          channelId={selectedId}
          channelName={selectedChannel?.name ?? ""}
          contextData={contextData}
          onClose={() => setMemoryPageOpen(false)}
        />
      )}

      <ImageLightbox
        src={lightboxSrc}
        fileId={lightboxFileId}
        onClose={() => {
          setLightboxSrc(null);
          setLightboxFileId(null);
        }}
        onEdit={(fileId) => {
          setImageGenInitialSourceFileId(fileId);
          setImageGenInitialTab("edit");
          setImageGenOpen(true);
          setLightboxSrc(null);
          setLightboxFileId(null);
        }}
      />
    </>
  );
}
