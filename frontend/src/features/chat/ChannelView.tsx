import { Button as UiButton } from "@/components/ui/button";
import {
  useState,
  useCallback,
  useEffect,
  useRef,
  useMemo,
  lazy,
  Suspense,
} from "react";
import {
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  X,
  Copy,
  Forward,
  WifiOff,
} from "lucide-react";
import toast from "react-hot-toast";
import { listMessages, sendMessage } from "@/api/messages";
import {
  useContextPickStore,
  toBundle,
  messageContextItem,
  type ContextItem,
} from "./context/contextPick";
import { ContextPickBar } from "./context/ContextPickBar";
import { useChatStore } from "@/stores/chatStore";
import { MessageList } from "./MessageList";
import { DiscussionView } from "./DiscussionView";
import { ReplyComposerBanner } from "./ReplyComposerBanner";
import { ForwardDialog } from "./ForwardDialog";
import type { MessageActionHandlers } from "./MessageItem";
import {
  MessageComposer,
  type MentionCandidate,
  type CommandCandidate,
} from "./MessageComposer";
import { SessionChip } from "./SessionChip";
import { ComposerModelPopover } from "./ComposerModelPopover";
import { stopTurn } from "./stopTurn";
import {
  consumePushFocusMsg,
  onPushTarget,
  setActivePushChannel,
} from "@/lib/push";
import { useChatRealtime, type PresenceFocus } from "./hooks/useChatRealtime";
import { WorkbenchDrawer } from "./workbench/WorkbenchDrawer";
import { ViewBoardDrawer } from "./workbench/ViewBoardDrawer";
import { LaneBoundsContext } from "@/hooks/useLaneWindow";
import { LaneZones } from "./workbench/LaneZones";
import { LaneResizer } from "./workbench/LaneResizer";
import { ErrorDialog } from "@/components/ui/ErrorDialog";
import { Banner } from "@/components/ui/banner";
import { ErrorState } from "@/components/ui/error-state";
import { ChannelChrome } from "./ChannelChrome";
import { useWindowChromePlacement } from "@/features/desktop/WindowChromeContext";
import { usesMacKeyboardShortcuts } from "@/features/desktop/desktopPlatform";
// Click-gated dialogs — kept out of the eager ChatLayout chunk. RemoteWorkspaceDialog
// pulls in DiffView + the workspace browser; all three only mount on explicit user action.
const ChannelFilesDialog = lazy(() =>
  import("./ChannelFilesDialog").then((m) => ({
    default: m.ChannelFilesDialog,
  })),
);
const ChannelSettingsDialog = lazy(() =>
  import("./ChannelSettingsDialog").then((m) => ({
    default: m.ChannelSettingsDialog,
  })),
);
const RemoteWorkspaceDialog = lazy(() =>
  import("./RemoteWorkspaceDialog").then((m) => ({
    default: m.RemoteWorkspaceDialog,
  })),
);
const VoiceRoomPanel = lazy(() =>
  import("./VoiceRoomPanel").then((m) => ({ default: m.VoiceRoomPanel })),
);
import { ResolveRefContext, type RefClick } from "./workspaceLink";
import { ProfileCardProvider } from "./ProfileHovercard";
import { resolveRef, getWorkspaceFile } from "@/api/workspace";
import { parseLocator } from "./locator";
import { locateWorkspaceFile } from "./wsLocate";
import { useAuthStore } from "@/stores/authStore";
import type {
  Message,
  Channel,
  PermissionContentData,
} from "@/types";
import { messageSessionId } from "./messageTree";
import { mergeMessages, sortMessages, upsertMessage } from "./messageCollection";
import { ChannelSelectionState } from "./ChannelSelectionState";
import { ChannelPreview } from "./ChannelPreview";
import { ChannelToolbar } from "./ChannelToolbar";
import { useChannelRoster } from "./hooks/useChannelRoster";
import { useChannelInstruments } from "./hooks/useChannelInstruments";
import { useChannelMessages } from "./hooks/useChannelMessages";

export { ChannelSelectionState } from "./ChannelSelectionState";

interface Props {
  channel: Channel | null;
  /** A workspace switch is waiting for its own channel snapshot. */
  channelSelectionPending?: boolean;
  /** Mobile stacked navigation: renders a back button that pops to the channel list. */
  onBack?: () => void;
  /** Desktop: whether the channel sidebar is expanded (drives the toggle icon). */
  sidebarOpen?: boolean;
  /** Desktop: collapse/expand the channel sidebar (renders a header toggle). */
  onToggleSidebar?: () => void;
}

export function ChannelView({
  channel,
  channelSelectionPending = false,
  onBack,
  sidebarOpen,
  onToggleSidebar,
}: Props) {
  const user = useAuthStore((s) => s.user);
  const patchChannel = useChatStore((s) => s.patchChannel);
  // Public channel the caller can see (as a workspace member) but hasn't joined
  // yet — everything membership-gated (history, members, realtime, composer) is
  // skipped and a join prompt renders instead. Joining patches the store, which
  // flips this off and lets the normal effects run.
  const isPreview =
    !!channel && channel.type !== "dm" && channel.is_member === false;
  const activeChannelRef = useRef<string | null>(channel?.channel_id ?? null);
  activeChannelRef.current = channel?.channel_id ?? null;
  const {
    mentionables,
    setMembers,
    memberById,
    voiceSpeakerNames,
    voiceTranscripts,
    setVoiceTranscripts,
    loadVoiceTranscript,
  } = useChannelRoster({ channel, preview: isPreview, activeChannelRef });
  const permissionResolvedRef = useRef<() => void>(() => {});
  const onPermissionResolved = useCallback(
    () => permissionResolvedRef.current(),
    [],
  );
  const {
    messages,
    setMessages,
    loading,
    loadError,
    hasMore,
    setHasMore,
    loadingMore,
    loadingRef,
    pendingCatchUpRef,
    pendingDeltas,
    catchUp,
    loadHistory,
    loadMore,
    handleMessage,
    handleStreamDelta,
    handleStreamDone,
    handleBotTrace,
    handleDeleted,
    handleFileTranscribed,
  } = useChannelMessages({
    channel,
    preview: isPreview,
    activeChannelRef,
    patchChannel,
    onPermissionResolved,
  });
  // Slash-commands advertised by the channel's bots (⑦ command palette). Flat
  // list across all bots; refreshed on channel open and on reconnect catch-up.
  const [commands, setCommands] = useState<CommandCandidate[]>([]);
  const [onlineCount, setOnlineCount] = useState(0);
  // Workspace presence: who else is viewing which bot's workspace (from the `presence`
  // frame's `focus` array). Surfaced as viewer chips in the RemoteWorkspaceDialog.
  const [workspaceFocus, setWorkspaceFocus] = useState<PresenceFocus[]>([]);
  // Composer session target: "" = Auto (mention routing → primary); else a session_id.
  const [selectedSessionId, setSelectedSessionId] = useState("");
  // The owning bot of the pinned session (null for Auto) — narrows the composer's
  // model chip to the single bot a pinned session actually targets.
  const [selectedSessionBotId, setSelectedSessionBotId] = useState<
    string | null
  >(null);
  // Bots @mentioned in the current draft (from the composer), so we can show their
  // mode/config controls inline when the caller is allowed to change them.
  const [mentionedBots, setMentionedBots] = useState<MentionCandidate[]>([]);
  // Header members dropdown (read-only list; management stays in settings).
  // Message actions: reply target, multi-select set, pending forward payload.
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [discussionComposerRoot, setDiscussionComposerRoot] =
    useState<Message | null>(null);
  /** Live+REST rows for the open topic — reply defaults look here, not only the chat window. */
  const discussionThreadRef = useRef<Message[]>([]);
  const [creatingDiscussion, setCreatingDiscussion] = useState(false);
  const [openDiscussionRequest, setOpenDiscussionRequest] = useState<{
    id: string;
    nonce: number;
  } | null>(null);
  const handleDiscussionComposerContextChange = useCallback(
    (root: Message | null, creating: boolean) => {
      setDiscussionComposerRoot((prevRoot) => {
        if (prevRoot?.msg_id !== root?.msg_id || creating) {
          setReplyTo(null);
        }
        return root;
      });
      setCreatingDiscussion(creating);
    },
    [],
  );
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [selectMode, setSelectMode] = useState(false);
  const [forward, setForward] = useState<{
    content: string;
    count: number;
  } | null>(null);
  // Live draft text (from the composer) → F3 suggested context (filename detection).
  const [draftText, setDraftText] = useState("");

  // Bots in the channel, derived from the mention candidates — the switcher lists
  // each bot's sessions under it.
  const switcherBots = useMemo(
    () =>
      mentionables
        .filter((m) => m.type === "bot")
        .map((m) => ({ botId: m.id, name: m.label })),
    [mentionables],
  );

  // Channel file index (id + name) built from loaded messages' attachments — no
  // extra fetch. Powers F3 filename suggestions (draft names a file → offer it).
  // Attachments never change during streaming, but `flushDeltas` swaps the whole
  // `messages` array identity every rAF, so keying this off `messages` would rebuild
  // the nested O(messages × attachments) index on every token delta. Instead key off a
  // cheap signature of just the messages that HAVE files (id + count) — it only changes
  // when attachments actually change, keeping both the work AND the value identity stable
  // across deltas. (Cheap enough to compute inline each render.)
  let channelFilesKey = `${messages.length}`;
  for (const m of messages) {
    const n = m.files?.length ?? 0;
    if (n) channelFilesKey += `|${m.msg_id}:${n}`;
  }
  const channelFiles = useMemo(() => {
    const byId = new Map<string, { file_id: string; filename: string }>();
    for (const m of messages) {
      for (const f of m.files ?? []) {
        const name = f.original_filename?.trim();
        if (f.file_id && name && !byId.has(f.file_id)) {
          byId.set(f.file_id, { file_id: f.file_id, filename: name });
        }
      }
    }
    return Array.from(byId.values());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelFilesKey]);

  // A different channel means a different session set — drop any prior target.
  // Also drop any buffered stream deltas + cancel a pending flush so a stale frame
  // can't synthesize a phantom bubble in the newly opened channel.
  useEffect(() => {
    setSelectedSessionId("");
    setSelectedSessionBotId(null);
    setMentionedBots([]);
    setCommands([]);
    setReplyTo(null);
    setDiscussionComposerRoot(null);
    setCreatingDiscussion(false);
    setOpenDiscussionRequest(null);
    setSelectMode(false);
    setSelectedIds(new Set());
    setForward(null);
  }, [channel?.channel_id]);

  // Esc backs out of the transient message-action states (reply draft / selection).
  // Composer popups (mention/command picker, attach menu) preventDefault their own
  // Escape — skip those so one Esc doesn't also cancel the reply underneath.
  useEffect(() => {
    if (!replyTo && !selectMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      setReplyTo(null);
      setSelectMode(false);
      setSelectedIds(new Set());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [replyTo, selectMode]);

  // Per-bot display label, so a command can show which bot advertised it.
  const botLabels = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of mentionables) if (m.type === "bot") map.set(m.id, m.label);
    return map;
  }, [mentionables]);

  // Member id → display label (users and bots), so messages missing a
  // sender_name still render a name instead of a sliced id.
  const memberNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of mentionables) map.set(m.id, m.label);
    return map;
  }, [mentionables]);

  // Refresh the slash-command palette from `channel.commands.read`. Bot-produced
  // command names/descriptions are untrusted — they only ever render as inert
  // text in the picker. Best-effort: a failure just leaves the palette empty.
  const sendResourceReqRef = useRef<
    | ((resource: string, params: Record<string, unknown>) => Promise<unknown>)
    | null
  >(null);
  const loadCommands = useCallback(async () => {
    if (!channel || isPreview) return;
    const send = sendResourceReqRef.current;
    if (!send) return;
    try {
      const res = (await send("channel.commands.read", {
        channel_id: channel.channel_id,
      })) as {
        bots?: {
          bot_id: string;
          commands?: { name: string; description?: string | null }[];
        }[];
      };
      const flat: CommandCandidate[] = (res.bots ?? []).flatMap((b) =>
        (b.commands ?? []).map((c) => ({
          name: c.name,
          description: c.description ?? undefined,
          botId: b.bot_id,
          botLabel: botLabels.get(b.bot_id) || b.bot_id.slice(0, 8),
        })),
      );
      setCommands(flat);
    } catch {
      /* best-effort; the composer just won't offer "/" commands */
    }
  }, [channel, isPreview, botLabels]);

  // Realtime "ready" → self-heal the message stream AND refresh the palette
  // (a bot may have advertised new commands while we were away). While the
  // initial history load is still in flight, defer the catch-up until it
  // resolves — a since_seq=0 catch-up would just re-fetch the same page.
  const handleReady = useCallback(() => {
    if (loadingRef.current) pendingCatchUpRef.current = true;
    else void catchUp();
    void loadCommands();
    void loadVoiceTranscript();
  }, [catchUp, loadCommands, loadVoiceTranscript, loadingRef, pendingCatchUpRef]);


  const {
    sendResourceReq,
    sendPresenceFocus,
    status: rtStatus,
    reconnectNow,
  } = useChatRealtime(
    // Preview (not yet a member) → don't subscribe; the gateway gates realtime
    // frames on channel membership anyway.
    !channel || isPreview ? null : channel.channel_id,
    {
      onMessage: handleMessage,
      onStreamDelta: handleStreamDelta,
      onStreamDone: handleStreamDone,
      onMessageDeleted: handleDeleted,
      onBotUnavailable: (botId, placeholderMsgId) => {
        pendingDeltas.current.delete(placeholderMsgId);
        setMessages((prev) =>
          prev.filter((m) => m.msg_id !== placeholderMsgId),
        );
        const botName = memberById.get(botId)?.display_name ?? "This bot";
        toast.error(
          `${botName} is offline and couldn't receive your message.`,
          {
            id: `bot-offline-${botId}`,
          },
        );
      },
      onReady: handleReady,
      // Backend `count` already includes online bots — display as-is, never re-add botIds.
      // `focus` carries workspace presence (who's viewing which bot's workspace).
      onPresence: (_ids, count, _botIds, focus) => {
        setOnlineCount(count);
        setWorkspaceFocus(focus ?? []);
      },
      onBotTrace: handleBotTrace,
      onBoardSignal: (board, botId) => {
        // "workspace" ticks live in their own bot-scoped cell (no ViewBoard consumes
        // a plain workspace count); everything else feeds the per-board counters.
        if (board === "workspace")
          setWorkspaceTick((prev) => ({
            seq: (prev?.seq ?? 0) + 1,
            botId: botId ?? null,
          }));
        else setBoardTick((t) => ({ ...t, [board]: (t[board] ?? 0) + 1 }));
      },
      // Live-watch: an agent touched files on its machine. Stash the bot-scoped signal
      // (bumping `seq` so repeat signals for the same paths still re-trigger); the open
      // workspace dialog filters by its own `botId` and refetches. See RemoteWorkspaceDialog.
      onWorkspaceSignal: (sig) =>
        setWorkspaceSignal((prev) => ({
          botId: sig.bot_id,
          root: sig.root,
          paths: sig.paths,
          seq: (prev?.seq ?? 0) + 1,
        })),
      onFileTranscribed: handleFileTranscribed,
      onVoiceTranscriptFinal: (segment) =>
        setVoiceTranscripts((previous) => {
          const existing = previous.findIndex(
            (item) => item.segment_id === segment.segment_id,
          );
          const next =
            existing === -1
              ? [...previous, segment]
              : previous.map((item, index) =>
                  index === existing ? segment : item,
                );
          return next.sort(
            (left, right) => left.channel_seq - right.channel_seq,
          );
        }),
      // A member edited their profile → patch their row in place so the hovercard
      // (which reads from `memberById`) reflects the new avatar/bio/status live.
      // Only overwrite fields the frame actually carries (undefined = unchanged).
      onMemberUpdated: (m) =>
        setMembers((prev) =>
          prev.map((row) =>
            row.member_id === m.member_id
              ? {
                  ...row,
                  ...(m.display_name !== undefined && {
                    display_name: m.display_name ?? undefined,
                  }),
                  ...(m.avatar_url !== undefined && {
                    avatar_url: m.avatar_url ?? undefined,
                  }),
                  ...(m.bio !== undefined && { bio: m.bio ?? undefined }),
                  ...(m.status_text !== undefined && {
                    status_text: m.status_text ?? undefined,
                  }),
                  ...(m.status_emoji !== undefined && {
                    status_emoji: m.status_emoji ?? undefined,
                  }),
                  ...(m.status_updated_at !== undefined && {
                    status_updated_at: m.status_updated_at ?? undefined,
                  }),
                }
              : row,
          ),
        ),
    },
  );
  // Keep a stable ref so loadCommands can reach the latest resource client
  // without re-subscribing the realtime hook.
  sendResourceReqRef.current = sendResourceReq;

  // Tier-M connection banner: a dropped socket only surfaces after a short grace
  // period (most blips heal within a retry or two), but a dead one (retry budget
  // spent) shows immediately. Clears itself the moment the socket is back.
  const [showConnBanner, setShowConnBanner] = useState(false);
  useEffect(() => {
    if (rtStatus === "reconnecting") {
      const t = setTimeout(() => setShowConnBanner(true), 1500);
      return () => clearTimeout(t);
    }
    setShowConnBanner(rtStatus === "offline");
  }, [rtStatus]);

  // If the realtime connection drops mid-stream, a bot bubble can be left with
  // `_streaming: true` indefinitely (no done frame arrives), which the streaming
  // fast-path renders as plain pre-wrap text. Finalize any lingering stream when we
  // go offline so it falls back to full Markdown; reconnect catch-up then reconciles
  // it with the persisted server state.
  useEffect(() => {
    if (rtStatus !== "offline") return;
    setMessages((prev) =>
      prev.some((m) => m._streaming)
        ? prev.map((m) => (m._streaming ? { ...m, _streaming: false } : m))
        : prev,
    );
  }, [rtStatus, setMessages]);

  // Re-flatten the palette when bot labels resolve after the initial fetch.
  useEffect(() => {
    void loadCommands();
  }, [loadCommands]);
  const {
    wbOpen,
    setWbOpen,
    vbOpen,
    setVbOpen,
    vbMinimal,
    setVbMinimal,
    boardTick,
    setBoardTick,
    workspaceTick,
    setWorkspaceTick,
    workspaceSignal,
    setWorkspaceSignal,
    filesOpen,
    setFilesOpen,
    settingsOpen,
    setSettingsOpen,
    wsOpen,
    setWsOpen,
    wsInit,
    setWsInit,
    composePrefill,
    setComposePrefill,
    filesFocus,
    setFilesFocus,
    setLaneEl,
    getLaneBounds,
    laneWidth,
    setLaneWidth,
    commitLaneWidth,
    openInstrument,
  } = useChannelInstruments();
  permissionResolvedRef.current = () =>
    setBoardTick((ticks) => ({ ...ticks, audit: (ticks.audit ?? 0) + 1 }));

  const [wbTarget, setWbTarget] = useState<string | undefined>(undefined);
  const [refError, setRefError] = useState<string | null>(null);
  // Jump-to-message request from ViewBoard history items (activity rows, audit
  // cards). `nonce` lets a repeat click on the same row re-trigger the scroll.
  // If the target isn't in the loaded window (initial load is only the newest
  // page), page older history in — bounded — until it appears, then focus; the
  // old behavior just toasted "scroll up to load older history" at the user.
  const [focusMsg, setFocusMsg] = useState<{
    msgId: string;
    nonce: number;
    requestId?: string | null;
  } | null>(null);
  const messagesRef = useRef<Message[]>(messages);
  messagesRef.current = messages;
  const jumpBackfillRef = useRef(false);
  // × 50/page — comfortably covers the Activity board's 200-event window.
  const JUMP_BACKFILL_PAGES = 8;
  const jumpToMessage = useCallback(
    async (msgId: string, requestId?: string | null) => {
      const focus = () =>
        setFocusMsg((prev) => ({
          msgId,
          requestId: requestId ?? null,
          nonce: (prev?.nonce ?? 0) + 1,
        }));
      if (messagesRef.current.some((m) => m.msg_id === msgId)) return focus();
      if (!channel || jumpBackfillRef.current) return;
      jumpBackfillRef.current = true;
      const toastId = toast.loading("Loading older history…");
      try {
        let oldest = messagesRef.current[0];
        for (let page = 0; page < JUMP_BACKFILL_PAGES && oldest; page++) {
          const res = await listMessages(channel.channel_id, {
            before: oldest.msg_id,
            limit: 50,
          });
          if (activeChannelRef.current !== channel.channel_id) return;
          const batch = res.messages ?? res.data ?? [];
          setMessages((prev) => mergeMessages(prev, batch));
          setHasMore(res.meta?.has_more_before ?? false);
          // Focus in the same batch as setMessages: MessageList's focus effect
          // runs after the commit that renders the new rows, so the anchor exists.
          if (batch.some((m) => m.msg_id === msgId)) return focus();
          const sorted = sortMessages(batch);
          if (!sorted.length || !(res.meta?.has_more_before ?? false)) break;
          oldest = sorted[0];
        }
        toast("Couldn't find that message in this channel's history", {
          icon: "🔍",
          id: "jump-not-found",
        });
      } catch {
        toast.error("Couldn't load older messages — try again", {
          id: "load-older-failed",
        });
      } finally {
        toast.dismiss(toastId);
        jumpBackfillRef.current = false;
      }
    },
    [channel, setHasMore, setMessages],
  );
  // Web Push integration: report the open channel to the SW bridge (so a
  // notification for a channel the user is already viewing is suppressed), and
  // consume a clicked notification's target — jump straight to the card. The
  // onPushTarget subscription covers a click landing while this channel is
  // already mounted; the readiness gate covers arriving via navigation: the
  // consume must wait for THIS channel's initial history (consuming while
  // messages still holds the previous channel — or nothing — would hand
  // jumpToMessage a stale backfill cursor and burn the one-shot target).
  const channelIdForPush = channel?.channel_id;
  const pushHistoryReady = !loading && !isPreview && messages.length > 0;
  useEffect(() => {
    if (!channelIdForPush) return;
    setActivePushChannel(channelIdForPush);
    return () => setActivePushChannel(null);
  }, [channelIdForPush]);
  useEffect(() => {
    if (!channelIdForPush || !pushHistoryReady) return;
    const check = () => {
      const msgId = consumePushFocusMsg(channelIdForPush);
      if (msgId) void jumpToMessage(msgId);
    };
    check();
    return onPushTarget(check);
  }, [channelIdForPush, pushHistoryReady, jumpToMessage]);

  // "Open the ViewBoard on THIS board" request (same nonce pattern as focusMsg) —
  // the session chip's "Manage sessions…" jumps straight to the Sessions board.
  const [focusBoard, setFocusBoard] = useState<{
    id: string;
    nonce: number;
  } | null>(null);
  const openSessionsBoard = useCallback(() => {
    setVbMinimal(false);
    openInstrument("viewboard", "open", true);
    setVbOpen(true);
    setFocusBoard((prev) => ({
      id: "sessions",
      nonce: (prev?.nonce ?? 0) + 1,
    }));
  }, [openInstrument, setVbMinimal, setVbOpen]);

  // Add-context menu → open a side surface (untargeted) so the user can pick a
  // file to attach from its own panel.
  const browseWorkbench = useCallback(() => {
    setWbTarget(undefined);
    openInstrument("workbench", "open", true);
    setWbOpen(true);
  }, [openInstrument, setWbOpen]);
  const browseWorkspace = useCallback(() => {
    setWsInit({});
    openInstrument("workspace", "open", true);
    setWsOpen(true);
  }, [openInstrument, setWsInit, setWsOpen]);
  // A pending context chip → jump to where that resource actually lives: a
  // Workbench file (`fs.read`) opens the Workbench focused on it; a bot's
  // workspace file (`workspace.read`) opens the Remote workspace at that path.
  const jumpToContextSource = useCallback(
    (item: ContextItem) => {
      if (item.verb === "fs.read") {
        const path = item.params.path;
        if (typeof path === "string") {
          setWbTarget(path);
          openInstrument("workbench", "open", true);
          setWbOpen(true);
        }
      } else if (item.verb === "workspace.read") {
        const botId = item.params.bot_id;
        const path = item.params.path;
        setWsInit({
          botId: typeof botId === "string" ? botId : undefined,
          path: typeof path === "string" ? path : undefined,
        });
        openInstrument("workspace", "open", true);
        setWsOpen(true);
      }
    },
    [openInstrument, setWbOpen, setWsInit, setWsOpen]
  );

  // Stable handlers for the memoized drawers so a streaming re-render of ChannelView
  // doesn't hand them fresh closures (which would defeat React.memo).
  const closeViewBoard = useCallback(() => setVbOpen(false), [setVbOpen]);
  const toggleViewBoardMinimal = useCallback(
    () => setVbMinimal((m) => !m),
    [setVbMinimal],
  );
  const closeWorkbench = useCallback(() => setWbOpen(false), [setWbOpen]);

  // Hoisted so the memoized MessageComposer isn't handed a fresh `toolbar` element
  // on every streaming delta render. Null when there's no channel (composer unmounted).
  const composerToolbar = useMemo(
    () =>
      channel ? (
        <>
          <SessionChip
            channelId={channel.channel_id}
            bots={switcherBots}
            value={selectedSessionId}
            onChange={(sid, botId) => {
              setSelectedSessionId(sid);
              setSelectedSessionBotId(botId ?? null);
            }}
            sendResourceReq={sendResourceReq}
            onManageSessions={openSessionsBoard}
          />
          {/* Model/mode + config for the target bot(s). A pinned session routes
              to exactly one bot (its own), so narrow to that bot and show its
              session's model; otherwise the @mentioned bots, falling back to the
              channel's bots so the controls are always reachable. */}
          <ComposerModelPopover
            channelId={channel.channel_id}
            bots={
              selectedSessionId && selectedSessionBotId
                ? [
                    {
                      botId: selectedSessionBotId,
                      name:
                        switcherBots.find(
                          (b) => b.botId === selectedSessionBotId,
                        )?.name ?? selectedSessionBotId,
                    },
                  ]
                : mentionedBots.length > 0
                  ? mentionedBots.map((m) => ({ botId: m.id, name: m.label }))
                  : switcherBots
            }
            selectedSessionId={selectedSessionId}
          />
        </>
      ) : null,
    // sendResourceReq and openSessionsBoard are identity-stable (useCallback).
    [
      channel,
      switcherBots,
      selectedSessionId,
      selectedSessionBotId,
      mentionedBots,
      sendResourceReq,
      openSessionsBoard,
    ],
  );

  // In-flight bot turns, for the composer's send→stop morph. The array identity
  // churns per delta flush, but the composer only receives the COUNT (changes on
  // stream start/end) and a stable callback reading the live ids from a ref — so
  // token streaming still never re-renders the memoized composer.
  const streamingIds = useMemo(
    () =>
      messages
        .filter(
          (m) =>
            m.sender_type === "bot" &&
            (m._streaming || m.is_partial) &&
            !m.is_deleted,
        )
        .map((m) => m.msg_id),
    [messages],
  );
  const streamingIdsRef = useRef(streamingIds);
  streamingIdsRef.current = streamingIds;
  const channelIdForStop = channel?.channel_id;
  const stopStreaming = useCallback(async () => {
    if (!channelIdForStop) return;
    await Promise.all(
      streamingIdsRef.current.map((id) => stopTurn(channelIdForStop, id)),
    );
  }, [channelIdForStop]);

  // Resolve a clicked file reference by PROVENANCE and TAKE THE USER TO where it
  // lives — the channel files view (inbox), the workbench File panel (desk), or the
  // workspace browser — instead of a silent download. Never assumes the bot followed
  // a convention; degrades to a clear error popup (not a 404) when it resolves to nothing.
  const resolveAndOpenRef = useCallback(
    async ({ senderBotId, ref, files }: RefClick) => {
      if (!channel) return;
      const base = ref.split("/").pop() || ref;
      const senderBotLabel =
        botLabels.get(senderBotId) || senderBotId.slice(0, 8);
      const openInbox = (fileId: string) => {
        setFilesFocus(fileId);
        openInstrument("files", "open", true);
        setFilesOpen(true);
      };
      // 1) Strongest signal: a file THIS message attached (an inbox deliverable).
      const hit = (files || []).find(
        (f) => (f.original_filename || "") === base,
      );
      if (hit) {
        openInbox(hit.file_id);
        return;
      }
      try {
        const r = await resolveRef(channel.channel_id, ref, senderBotId);
        if (r.store === "inbox" && r.file_id) {
          openInbox(r.file_id);
        } else if (r.store === "desk" && r.path) {
          setWbTarget(r.path);
          openInstrument("workbench", "open", true);
          setWbOpen(true);
        } else if (r.store === "workspace" && r.bot_id && r.path) {
          // The workspace candidate is unprobed — verify the file actually exists on
          // the bot's machine before dropping the user into the browser. If it
          // doesn't, it lives nowhere we can reach → clear error, not a broken view.
          try {
            await getWorkspaceFile(channel.channel_id, r.bot_id, r.path);
            setWsInit({ botId: r.bot_id, path: r.path });
            openInstrument("workspace", "open", true);
            setWsOpen(true);
          } catch (e) {
            const offline = String(e).includes("offline");
            setRefError(
              offline
                ? `Can't open "${base}": this file lives on bot "${senderBotLabel}"'s machine, but its connector is currently offline.`
                : `Couldn't find "${base}".\nIt isn't attached to this reply, on the channel Desk, or in the workspace — the bot may have only mentioned it without actually producing or sharing it.`,
            );
          }
        } else {
          setRefError(
            `Couldn't find "${base}".\nIt isn't attached to this reply, on the channel Desk, or in any reachable workspace — the bot may have mentioned this file without actually producing or sharing it.`,
          );
        }
      } catch (e) {
        setRefError(
          `Failed to open "${base}": ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
    [
      channel,
      botLabels,
      openInstrument,
      setFilesFocus,
      setFilesOpen,
      setWbOpen,
      setWsInit,
      setWsOpen,
    ],
  );

  // Resolve a `cheers:` locator (the DETERMINISTIC cousin of resolveAndOpenRef's
  // provenance heuristic — the locator names its store explicitly) and take the user
  // there: desk → Workbench deep-link, ws → existence-probe then the workspace browser
  // at the anchored line, inbox → channel files. Pure UI routing: every read behind
  // the jump still passes the existing authz. Fed by renderer plugins via cheers:open.
  const openLocator = useCallback(
    async (uri: string) => {
      if (!channel) return;
      const loc = parseLocator(uri);
      if (!loc) {
        setRefError(`Unrecognized locator:\n${uri.slice(0, 200)}`);
        return;
      }
      if (loc.kind === "desk") {
        setWbTarget(loc.path);
        openInstrument("workbench", "open", true);
        setWbOpen(true);
        return;
      }
      if (loc.kind === "inbox") {
        setFilesFocus(loc.fileId);
        openInstrument("files", "open", true);
        setFilesOpen(true);
        return;
      }
      if (loc.kind === "msg") {
        setRefError("Message locators (cheers:msg/…) aren't supported yet.");
        return;
      }
      // ws: "@handle" resolves through this channel's bot members; anything else is a bot id.
      let botId = loc.bot;
      if (botId.startsWith("@")) {
        const handle = botId.slice(1).toLowerCase();
        const hits = [...botLabels.entries()].filter(
          ([, label]) => label.toLowerCase() === handle,
        );
        if (hits.length === 1) {
          botId = hits[0][0];
        } else if (hits.length === 0 && botLabels.size === 1) {
          // Wrong/stale/invented handle, but the channel has exactly ONE bot: the map is
          // channel-local, so the intent is unambiguous — resolve to it and let the
          // existence probe below gate the jump. (Agents do invent handles; a map full
          // of them should still be navigable in the common single-bot channel.)
          botId = [...botLabels.keys()][0];
        } else {
          const known =
            [...botLabels.values()].map((l) => `@${l}`).join(", ") || "(none)";
          setRefError(
            hits.length === 0
              ? `No bot named "@${handle}" in this channel — bots here: ${known}.\nThe locator may be stale or invented; ask the bot to fix the loc fields in its map file.`
              : `More than one bot answers to "@${handle}" here — open the workspace browser and pick one.`,
          );
          return;
        }
      }
      // Probe before navigating (same reasoning as resolveAndOpenRef): landing the user
      // in a browser for a file that isn't reachable is worse than a clear error. Bot-
      // written paths carry root-basis uncertainty, so the probe is TOLERANT — exact
      // path first, then bounded root-offset corrections (see wsLocate.ts).
      try {
        const resolved = await locateWorkspaceFile(
          channel.channel_id,
          botId,
          loc.path,
        );
        if (!resolved) {
          setRefError(
            `Couldn't find "${loc.path}" in that bot's workspace — not at that path, not one level up, not under any top-level folder.\nThe file may have moved or been renamed; ask the bot to refresh the loc fields in its map file.`,
          );
          return;
        }
        // A directory loc opens the folder view (the dialog's deep-link already falls
        // back to listing); a line anchor only makes sense on a file.
        setWsInit({
          botId,
          path: resolved.path,
          line: resolved.kind === "file" ? loc.line : undefined,
        });
        openInstrument("workspace", "open", true);
        setWsOpen(true);
      } catch (e) {
        const offline = String(e).includes("offline");
        setRefError(
          offline
            ? `Can't open "${loc.path}": that bot's connector is currently offline.`
            : `Couldn't open "${loc.path}" in that workspace: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
    [
      channel,
      botLabels,
      openInstrument,
      setFilesFocus,
      setFilesOpen,
      setWbOpen,
      setWsInit,
      setWsOpen,
    ],
  );

  // A renderer plugin suggested a message (cheers:compose). Prefill only — the human
  // reviews, edits, and presses send; that keystroke is what makes it a channel action.
  const composeMessage = useCallback((text: string) => {
    setComposePrefill((p) => ({
      kind: "text",
      text,
      seq: (p?.seq ?? 0) + 1,
    }));
  }, [setComposePrefill]);

  const handleSend = useCallback(
    async (
      content: string,
      mentionIds: string[],
      fileIds: string[],
      mentionNames: string[] = [],
    ) => {
      if (!channel) return;
      // Attached resource context (docs/design/RESOURCE_CONTEXT.md): read the
      // channel's pending picks and ship them as a bundle, then clear on success.
      const pending =
        useContextPickStore.getState().byChannel[channel.channel_id] ?? [];
      const bundle = toBundle(pending, channel.channel_id);
      const sendParams: NonNullable<Message["_sendParams"]> = {
        content,
        ...(mentionIds.length ? { mention_ids: mentionIds } : {}),
        ...(mentionNames.length ? { mention_names: mentionNames } : {}),
        ...(fileIds.length ? { file_ids: fileIds } : {}),
        ...(selectedSessionId ? { session_id: selectedSessionId } : {}),
        ...(replyTo
          ? { reply_to_msg_id: replyTo.msg_id }
          : channel.conversation_mode === "discuss" &&
              !creatingDiscussion &&
              discussionComposerRoot
            ? { reply_to_msg_id: discussionComposerRoot.msg_id }
            : {}),
        ...(bundle ? { context_bundle: bundle } : {}),
      };
      try {
        const { content: body, ...opts } = sendParams;
        const sent = await sendMessage(channel.channel_id, body, opts);
        if (
          channel.conversation_mode === "discuss" &&
          creatingDiscussion
        ) {
          setOpenDiscussionRequest((current) => ({
            id: sent.msg_id,
            nonce: (current?.nonce ?? 0) + 1,
          }));
          setCreatingDiscussion(false);
          setDiscussionComposerRoot(sent);
        }
        setReplyTo(null);
        useContextPickStore.getState().clear(channel.channel_id);
      } catch (error) {
        // Rejections such as an offline @bot are intentionally not persisted.
        // Keep the draft in the composer and surface the server's reason instead.
        toast.error(error instanceof Error ? error.message : "Couldn't send message");
        throw error;
      }
    },
    [
      channel,
      selectedSessionId,
      replyTo,
      creatingDiscussion,
      discussionComposerRoot,
    ],
  );

  // Retry a failed send: flip the placeholder to "sending", replay the original
  // arguments verbatim, then drop the placeholder on success (the confirmed row
  // is upserted from the response, and the WS echo dedups by msg_id).
  const retryMessage = useCallback(
    async (failed: Message) => {
      if (!channel || !failed._sendParams) return;
      const { content, ...opts } = failed._sendParams;
      setMessages((prev) =>
        prev.map((m) =>
          m.msg_id === failed.msg_id ? { ...m, _status: "sending" } : m,
        ),
      );
      try {
        const sent = await sendMessage(channel.channel_id, content, opts);
        setMessages((prev) =>
          upsertMessage(
            prev.filter((m) => m.msg_id !== failed.msg_id),
            sent,
          ),
        );
      } catch {
        setMessages((prev) =>
          prev.map((m) =>
            m.msg_id === failed.msg_id ? { ...m, _status: "failed" } : m,
          ),
        );
        toast.error("Still couldn't send — check your connection");
      }
    },
    [channel, setMessages],
  );

  // ── Message actions: reply / copy / forward / multi-select ────────────────
  const displayName = useCallback(
    (m: Message) =>
      m.sender_name || memberNames.get(m.sender_id) || m.sender_id.slice(0, 8),
    [memberNames],
  );

  /** Markdown quote block with provenance — the forward payload. */
  const buildForwardContent = useCallback(
    (msgs: Message[]): string => {
      const blocks = msgs.map((m) => {
        const text = (m.content ?? "").replace(/<#file:[^>]+>/g, "").trim();
        const body = (text || "(empty message)")
          .split("\n")
          .map((l) => `> ${l}`)
          .join("\n");
        const files = m.files?.length
          ? `\n> _(${m.files.length} attachment${m.files.length > 1 ? "s" : ""} not included)_`
          : "";
        return `> **${displayName(m)}**:\n${body}${files}`;
      });
      // DM channels are nameless (labelled by peer) — don't render a bare "#".
      const source =
        channel?.type === "dm"
          ? "a direct message"
          : `#${channel?.name ?? "channel"}`;
      return `**↪ Forwarded from ${source}**\n${blocks.join("\n>\n")}`;
    },
    [channel?.type, channel?.name, displayName],
  );

  /** Selected messages in channel order (selection set has no order of its own). */
  const selectedMessages = useMemo(
    () => messages.filter((m) => selectedIds.has(m.msg_id)),
    [messages, selectedIds],
  );
  const discussionRealtimeVersion = useMemo(
    () =>
      messages.reduce(
        (version, message) =>
          Math.max(version, message.channel_seq ?? 0),
        0,
      ) * 1_000 + messages.length,
    [messages],
  );

  // Live pending ACP permission cards — feeds the ViewBoard minimal Approvals dropdown.
  const pendingPermissionMessages = useMemo(
    () =>
      messages.filter((m) => {
        if (m.msg_type !== "permission") return false;
        return !(m.content_data as PermissionContentData | null | undefined)
          ?.resolved;
      }),
    [messages],
  );

  // Reply uses the same bottom composer as a normal send. The only difference is
  // defaults copied from the source turn: session target, @bot, and message context.
  // `reply_to_msg_id` still nests the outgoing message under the source.
  const applyReplyDefaults = useCallback(
    (m: Message) => {
      let bot: Message | null = null;
      if (m.sender_type === "bot") {
        bot = m;
      } else {
        // Prefer the latest bot child under this message (the turn being continued).
        // Discussion threads keep REST replies off the chat window — search both.
        const seen = new Set<string>();
        const pool: Message[] = [];
        for (const row of discussionThreadRef.current) {
          if (seen.has(row.msg_id)) continue;
          seen.add(row.msg_id);
          pool.push(row);
        }
        for (const row of messages) {
          if (seen.has(row.msg_id)) continue;
          seen.add(row.msg_id);
          pool.push(row);
        }
        const botKids = pool
          .filter(
            (x) =>
              x.reply_to_msg_id === m.msg_id &&
              x.sender_type === "bot" &&
              !x.is_deleted,
          )
          .sort((a, b) => (a.channel_seq ?? 0) - (b.channel_seq ?? 0));
        bot = botKids[botKids.length - 1] ?? null;
      }

      if (bot) {
        setSelectedSessionBotId(bot.sender_id);
        setSelectedSessionId(messageSessionId(bot) ?? "");
        const label =
          bot.sender_name ||
          mentionables.find((x) => x.id === bot!.sender_id)?.label;
        if (label) {
          setComposePrefill((p) => ({
            kind: "mention",
            memberId: bot!.sender_id,
            text: `@${label} `,
            seq: (p?.seq ?? 0) + 1,
          }));
        }
      }

      if (channel?.channel_id) {
        const ctx = messageContextItem(m);
        if (ctx) useContextPickStore.getState().add(channel.channel_id, ctx);
      }
    },
    [messages, mentionables, channel?.channel_id, setComposePrefill],
  );

  const mentionMember = useCallback(
    (memberId: string) => {
      if (memberId === user?.user_id) return;
      const candidate = mentionables.find((item) => item.id === memberId);
      if (!candidate) {
        toast.error("This member is no longer available to mention");
        return;
      }
      setComposePrefill((previous) => ({
        kind: "mention",
        memberId: candidate.id,
        text: `@${candidate.label} `,
        seq: (previous?.seq ?? 0) + 1,
      }));
    },
    [mentionables, user?.user_id, setComposePrefill],
  );

  // Stable identity: selection state deliberately NOT captured here (it travels
  // as scalar props), so a selection toggle only re-renders the affected rows
  // instead of defeating memo(MessageItem) list-wide.
  const messageActions: MessageActionHandlers = useMemo(
    () => ({
      onReply: (m) => {
        setReplyTo(m);
        applyReplyDefaults(m);
      },
      onForward: (m) =>
        setForward({ content: buildForwardContent([m]), count: 1 }),
      onMention: (m) => mentionMember(m.sender_id),
      onToggleSelect: (m) => {
        setSelectMode(true);
        // Entering select mode — disarm reply so the next send can't silently
        // nest under an invisible target.
        setReplyTo(null);
        setSelectedIds((prev) => {
          const next = new Set(prev);
          if (next.has(m.msg_id)) next.delete(m.msg_id);
          else next.add(m.msg_id);
          return next;
        });
      },
      onRetry: retryMessage,
    }),
    [buildForwardContent, retryMessage, applyReplyDefaults, mentionMember],
  );

  const clearSelection = () => {
    setSelectMode(false);
    setSelectedIds(new Set());
  };

  async function copySelected() {
    const text = selectedMessages
      .map(
        (m) =>
          `${displayName(m)}: ${(m.content ?? "").replace(/<#file:[^>]+>/g, "").trim()}`,
      )
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
      toast.success(
        `Copied ${selectedMessages.length} message${selectedMessages.length > 1 ? "s" : ""}`,
      );
      clearSelection();
    } catch {
      toast.error("Clipboard unavailable");
    }
  }

  // Inline shells keep the collapse toggle in the channel surface (and float it
  // in the empty state). The desktop window frame owns the hosted toggle.
  const isMac = usesMacKeyboardShortcuts();
  const chromePlacement = useWindowChromePlacement();
  const sidebarToggle = onToggleSidebar && chromePlacement === "inline" ? (
    <UiButton variant="plain"
      onClick={onToggleSidebar}
      title={`${sidebarOpen ? "Hide" : "Show"} sidebar (${isMac ? "⌘B" : "Ctrl+B"})`}
      aria-label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
      content="icon" controlSize="compact" className="max-md:hidden flex items-center justify-center rounded-sm text-content-primary hover:text-content-strong hover:bg-zinc-800 flex-shrink-0 transition-colors"
    >
      {sidebarOpen ? (
        <PanelLeftClose className="w-4 h-4" aria-hidden="true" />
      ) : (
        <PanelLeftOpen className="w-4 h-4" aria-hidden="true" />
      )}
    </UiButton>
  ) : null;

  if (!channel) {
    return (
      <ChannelSelectionState
        pending={channelSelectionPending}
        sidebarToggle={sidebarToggle}
      />
    );
  }

  // Public channel the caller hasn't joined: a join prompt instead of the chat.
  // No history/members/composer — those are membership-gated server-side.
  if (isPreview) {
    return (
      <ChannelPreview channel={channel} sidebarToggle={sidebarToggle} onBack={onBack} />
    );
  }

  const anyWorkOpen = vbOpen || wbOpen || wsOpen || filesOpen;
  // DM channels are nameless on the wire (`channels.name` is '') — label them by
  // the other participant, same fallback chain as Sidebar/ForwardDialog/QuickPanel.
  const isDm = channel.type === "dm";
  const channelTitle = isDm
    ? channel.peer_name || channel.name || "Direct Message"
    : channel.name;

  const channelToolbar = (
    <ChannelToolbar
      channelId={channel.channel_id}
      isDm={channel.type === "dm"}
      memberCount={mentionables.length}
      onlineCount={onlineCount}
      filesOpen={filesOpen}
      workspaceOpen={wsOpen}
      viewBoardOpen={vbOpen}
      workbenchOpen={wbOpen}
      onManage={() => setSettingsOpen(true)}
      onToggleFiles={() => {
        setFilesFocus(undefined);
        setFilesOpen((open) => {
          if (!open) openInstrument("files", "open", false);
          return !open;
        });
      }}
      onToggleWorkspace={() => {
        setWsInit({});
        setWsOpen((open) => {
          if (!open) openInstrument("workspace", "open", false);
          return !open;
        });
      }}
      onToggleViewBoard={() =>
        setVbOpen((open) => {
          if (!open) openInstrument("viewboard", "open", false);
          return !open;
        })
      }
      onToggleWorkbench={() => {
        setWbTarget(undefined);
        setWbOpen((open) => {
          if (!open) openInstrument("workbench", "open", false);
          return !open;
        });
      }}
    />
  );

  return (
    <ProfileCardProvider
      members={memberById}
      currentUserId={user?.user_id}
      onMention={(member) => mentionMember(member.member_id)}
    >
      {/* Desktop: instrument panels DOCK into a dedicated work area on the right,
        which reserves real layout space. The chat column is always width-capped:
        centered while the work area is closed, docked against it when open.
        Mobile: the panels stay full/near-full-screen overlay sheets. */}
      <div className="flex flex-col h-full">
        <ChannelChrome
          title={channelTitle}
          purpose={channel.purpose}
          isDm={isDm}
          sidebarToggle={sidebarToggle}
          onBack={onBack}
          actions={channelToolbar}
        />

        <div className="flex-1 min-h-0 flex">
          {/* Chat region — fills the width left of the (resizable) lane, down to a
          24rem floor; the inner column below caps the reading width at 52rem and
          stays centered in that space (whether or not the lane is open) so it
          never strands a wide empty gutter on one side. */}
          <div
            className={`flex-1 min-w-0 flex flex-col ${
              // Tighter chat floor on mid-width desktops so the lane can reach a
              // reading-friendly width; full 24rem once the window is wide enough.
              anyWorkOpen ? "md:min-w-[20rem] min-[1100px]:min-w-[24rem]" : ""
            }`}
          >
            <div
              className={`flex h-full w-full min-w-0 flex-col ${
                channel.conversation_mode === "discuss"
                  ? ""
                  : "md:mx-auto md:max-w-[52rem]"
              }`}
            >
              {channel.kind === "voice" && (
                <Suspense
                  fallback={
                    <div className="mx-4 mb-3 h-[74px] rounded-sm bg-zinc-900/50 animate-pulse" />
                  }
                >
                  <VoiceRoomPanel
                    channelId={channel.channel_id}
                    transcripts={voiceTranscripts}
                    speakerNames={voiceSpeakerNames}
                    canManage={
                      channel.can_manage === true ||
                      channel.my_role === "owner" ||
                      channel.my_role === "admin"
                    }
                    onFinalSegment={() => {
                      // Re-renders clear any in-progress interim bubbles for this segment
                      // (VoiceRoomPanel drops them from local state on the data-channel
                      // final too — this just forces the React render pass).
                      setVoiceTranscripts((prev) => [...prev]);
                    }}
                  />
                </Suspense>
              )}
              {/* Live-connection banner (tier M): the channel is readable but frozen. */}
              {showConnBanner && (
                <Banner
                  severity={rtStatus === "offline" ? "error" : "warning"}
                  icon={WifiOff}
                  className="mx-4 mt-2 flex-shrink-0"
                  action={{ label: "Retry now", onClick: reconnectNow }}
                >
                  {rtStatus === "offline"
                    ? "Connection lost — new messages are paused."
                    : "Connection lost — reconnecting…"}
                </Banner>
              )}
              {/* Messages */}
              {channel.conversation_mode === "discuss" ? (
                <ResolveRefContext.Provider value={resolveAndOpenRef}>
                  <DiscussionView
                    channelId={channel.channel_id}
                    currentUserId={user?.user_id}
                    senderNames={memberNames}
                    actions={messageActions}
                    replyToId={replyTo && !selectMode ? replyTo.msg_id : null}
                    realtimeVersion={discussionRealtimeVersion}
                    openDiscussionId={openDiscussionRequest?.id ?? null}
                    liveMessages={messages}
                    discussionThreadRef={discussionThreadRef}
                    footer={
                      !selectMode ? (
                        <>
                          {replyTo && (
                            <ReplyComposerBanner
                              message={replyTo}
                              senderName={memberNames.get(replyTo.sender_id)}
                              onCancel={() => setReplyTo(null)}
                            />
                          )}
                          <MessageComposer
                            channelId={channel.channel_id}
                            channelName={channel.name}
                            mentionables={mentionables}
                            commands={commands}
                            toolbar={composerToolbar}
                            contextBar={
                              <ContextPickBar
                                channelId={channel.channel_id}
                                replyTo={replyTo}
                                draftText={draftText}
                                files={channelFiles}
                                onBrowseWorkbench={browseWorkbench}
                                onBrowseWorkspace={browseWorkspace}
                                onJumpToSource={jumpToContextSource}
                              />
                            }
                            onMentionsChange={setMentionedBots}
                            onTextChange={setDraftText}
                            prefill={composePrefill}
                            streamingCount={streamingIds.length}
                            onStopStreaming={stopStreaming}
                            onSend={handleSend}
                          />
                        </>
                      ) : null
                    }
                    onComposerContextChange={handleDiscussionComposerContextChange}
                  />
                </ResolveRefContext.Provider>
              ) : loading ? (
                <div className="flex-1 flex items-center justify-center">
                  <Loader2 className="w-5 h-5 text-content-muted animate-spin" />
                </div>
              ) : loadError ? (
                <ErrorState
                  className="flex-1"
                  title="Couldn't load messages"
                  description="Check your connection and try again."
                  action={{ label: "Retry", onClick: loadHistory }}
                />
              ) : (
                <ResolveRefContext.Provider value={resolveAndOpenRef}>
                  <MessageList
                    messages={messages}
                    currentUserId={user?.user_id}
                    channelId={channel.channel_id}
                    senderNames={memberNames}
                    hasMore={hasMore}
                    onLoadMore={loadMore}
                    loading={loadingMore}
                    actions={messageActions}
                    selectMode={selectMode}
                    selectedIds={selectedIds}
                    focusMsg={focusMsg}
                    replyToId={replyTo && !selectMode ? replyTo.msg_id : null}
                    conversationMode={channel.conversation_mode ?? "chat"}
                  />
                </ResolveRefContext.Provider>
              )}

              {/* Multi-select toolbar — replaces nothing, floats above the composer. */}
              {selectMode && (
                <div className="mx-4 mt-2 flex items-center gap-2 rounded-sm bg-zinc-900/80 px-3 py-2 text-compact">
                  <span className="text-content-secondary font-medium">
                    {selectedIds.size} selected
                  </span>
                  <span className="text-content-muted">
                    · click messages to toggle
                  </span>
                  <div className="flex-1" />
                  <UiButton action="copy" content="iconText" variant="plain"
                    type="button"
                    disabled={selectedIds.size === 0}
                    onClick={() => void copySelected()}
                    controlSize="regular" className="inline-flex items-center gap-2 rounded-sm bg-zinc-800 text-content-primary hover:bg-zinc-700 hover:text-content-strong disabled:opacity-50"
                  >
                    <Copy className="w-3.5 h-3.5" />
                    Copy
                  </UiButton>
                  <UiButton action="send" content="iconText" variant="plain"
                    type="button"
                    disabled={selectedIds.size === 0}
                    onClick={() =>
                      setForward({
                        content: buildForwardContent(selectedMessages),
                        count: selectedMessages.length,
                      })
                    }
                    controlSize="regular" className="inline-flex items-center gap-2 rounded-sm bg-zinc-800 text-content-primary hover:bg-zinc-700 hover:text-content-strong disabled:opacity-50"
                  >
                    <Forward className="w-3.5 h-3.5" />
                    Forward
                  </UiButton>
                  <UiButton action="cancel" content="iconText" variant="plain"
                    type="button"
                    onClick={clearSelection}
                    controlSize="regular" className="inline-flex items-center gap-2 rounded-sm text-content-primary hover:text-content-strong"
                  >
                    <X className="w-3.5 h-3.5" />
                    Cancel
                  </UiButton>
                </div>
              )}

              {/* Same composer for root sends and replies — reply only pre-fills
                  session / @ / context (and sets reply_to on send). Esc clears nesting. */}
              {!selectMode && channel.conversation_mode !== "discuss" && (
                <>
                  {replyTo && (
                    <ReplyComposerBanner
                      message={replyTo}
                      senderName={memberNames.get(replyTo.sender_id)}
                      onCancel={() => setReplyTo(null)}
                    />
                  )}
                  <MessageComposer
                    channelId={channel.channel_id}
                    channelName={channel.name}
                    mentionables={mentionables}
                    commands={commands}
                    toolbar={composerToolbar}
                    contextBar={
                      <ContextPickBar
                        channelId={channel.channel_id}
                        replyTo={replyTo}
                        draftText={draftText}
                        files={channelFiles}
                        onBrowseWorkbench={browseWorkbench}
                        onBrowseWorkspace={browseWorkspace}
                        onJumpToSource={jumpToContextSource}
                      />
                    }
                    onMentionsChange={setMentionedBots}
                    onTextChange={setDraftText}
                    prefill={composePrefill}
                    streamingCount={streamingIds.length}
                    onStopStreaming={stopStreaming}
                    onSend={handleSend}
                  />
                </>
              )}
            </div>
          </div>

          {/* Splitter — drag to resize the lane's width (desktop only, when open). */}
          {anyWorkOpen && (
            <LaneResizer onChange={setLaneWidth} onCommit={commitLaneWidth} />
          )}

          {/* Work area — a dedicated lane on the right: a bounded canvas the instrument
          windows (ViewBoard, Workbench, Remote workspace, Channel files) float,
          drag and resize inside. `relative` + `overflow-hidden` make it the
          positioning context and clip stray windows; dragging a window overlays a
          grid of snap zones (LaneZones) and drops snap the window into a zone. Its
          width is user-adjustable via the splitter (explicit `width`, clamped by
          min/max so neither column collapses). On mobile it's display:contents —
          the panels stay full-screen overlay sheets there (width ignored).
          LaneBoundsContext hands each window this box's live rect so
          drag/resize/snap stay inside it. */}
          <aside
            ref={setLaneEl}
            style={{ width: laneWidth }}
            className={
              anyWorkOpen
                ? "max-md:contents md:relative md:shrink-0 md:min-w-[16rem] md:max-w-[calc(100%-20rem)] min-[1100px]:max-w-[calc(100%-24rem)] md:min-h-0 md:overflow-hidden"
                : "contents"
            }
          >
            <LaneBoundsContext.Provider
              value={anyWorkOpen ? getLaneBounds : null}
            >
              {anyWorkOpen && <LaneZones />}
              {wsOpen && (
                <Suspense fallback={null}>
                  <RemoteWorkspaceDialog
                    channelId={channel.channel_id}
                    onClose={() => setWsOpen(false)}
                    initialBotId={wsInit.botId}
                    initialPath={wsInit.path}
                    initialLine={wsInit.line}
                    // Default the browse to the composer's active session ("" = Auto → no
                    // session scope → the dialog shows the bot's full allowed roots).
                    sessionId={selectedSessionId || undefined}
                    // "workspace" board tick (an agent finished a turn; carries the emitting
                    // bot) → the dialog refetches its current dir + a clean open file, but
                    // only when the tick's bot is the one being browsed.
                    workspaceTick={workspaceTick}
                    // Live-watch: the bot-scoped `workspace_signal` (agent touched a file). The
                    // dialog registers a watch while open and refetches when a signal for ITS bot
                    // arrives. See onWorkspaceSignal → workspaceSignal above.
                    workspaceSignal={workspaceSignal}
                    // Workspace presence: broadcast our own focus + render who ELSE is viewing this
                    // bot's workspace. `focus` is the parsed presence list; names resolve via the
                    // channel member map; currentUserId filters ourselves out of the chips.
                    sendPresenceFocus={sendPresenceFocus}
                    workspaceFocus={workspaceFocus}
                    currentUserId={user?.user_id}
                    memberNames={memberNames}
                  />
                </Suspense>
              )}

              <ViewBoardDrawer
                open={vbOpen}
                onClose={closeViewBoard}
                channelId={channel.channel_id}
                sendResourceReq={sendResourceReq}
                selectedSessionId={selectedSessionId}
                boardTick={boardTick}
                minimal={vbMinimal}
                onToggleMinimal={toggleViewBoardMinimal}
                onJumpToMessage={jumpToMessage}
                pendingApprovals={pendingPermissionMessages}
                currentUserId={user?.user_id}
                focusBoard={focusBoard ?? undefined}
              />

              <WorkbenchDrawer
                open={wbOpen}
                onClose={closeWorkbench}
                channelId={channel.channel_id}
                sendResourceReq={sendResourceReq}
                openFilePath={wbTarget}
                filesTick={boardTick.files}
                onOpenLocator={openLocator}
                onCompose={composeMessage}
              />

              {/* Channel files lives in the lane too, so it floats/drags/resizes like the
            other instrument panels instead of over the whole viewport. */}
              {filesOpen && (
                <Suspense fallback={null}>
                  <ChannelFilesDialog
                    channelId={channel.channel_id}
                    onClose={() => setFilesOpen(false)}
                    focusFileId={filesFocus}
                  />
                </Suspense>
              )}
            </LaneBoundsContext.Provider>
          </aside>
        </div>
        {settingsOpen && (
          <Suspense fallback={null}>
            <ChannelSettingsDialog
              channel={channel}
              onClose={() => setSettingsOpen(false)}
            />
          </Suspense>
        )}
        {forward && (
          <ForwardDialog
            content={forward.content}
            sourceChannelId={channel.channel_id}
            messageCount={forward.count}
            onClose={() => {
              setForward(null);
              clearSelection();
            }}
          />
        )}
        {refError && (
          <ErrorDialog message={refError} onClose={() => setRefError(null)} />
        )}
      </div>
    </ProfileCardProvider>
  );
}
