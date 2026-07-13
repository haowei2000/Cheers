import { useState, useCallback, useEffect, useRef, useMemo, lazy, Suspense } from "react";
import { ArrowLeft, Hash, Users, Loader2, PanelRight, PanelLeftClose, PanelLeftOpen, Paperclip, FolderTree, Settings, LayoutDashboard, Reply, X, Copy, Forward, AlertCircle } from "lucide-react";
import toast from "react-hot-toast";
import { listMessages, sendMessage } from "@/api/messages";
import { listChannelMembers, markChannelRead, joinChannel } from "@/api/channels";
import { useChatStore } from "@/stores/chatStore";
import { MessageList } from "./MessageList";
import { MembersPopover } from "./MembersPopover";
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
import { useChatRealtime, type PresenceFocus } from "./hooks/useChatRealtime";
import { WorkbenchDrawer } from "./workbench/WorkbenchDrawer";
import { ViewBoardDrawer } from "./workbench/ViewBoardDrawer";
import { LaneBoundsContext } from "@/hooks/useLaneWindow";
import { ErrorDialog } from "@/components/ui/ErrorDialog";
import { Button } from "@/components/ui/button";
import { usePopoverDismiss } from "@/components/ui/popover";
// Click-gated dialogs — kept out of the eager ChatLayout chunk. RemoteWorkspaceDialog
// pulls in DiffView + the workspace browser; all three only mount on explicit user action.
const ChannelFilesDialog = lazy(() =>
  import("./ChannelFilesDialog").then((m) => ({ default: m.ChannelFilesDialog })),
);
const ChannelSettingsDialog = lazy(() =>
  import("./ChannelSettingsDialog").then((m) => ({ default: m.ChannelSettingsDialog })),
);
const RemoteWorkspaceDialog = lazy(() =>
  import("./RemoteWorkspaceDialog").then((m) => ({ default: m.RemoteWorkspaceDialog })),
);
import { ResolveRefContext, type RefClick } from "./workspaceLink";
import { ProfileCardProvider, type ProfileData } from "./ProfileHovercard";
import { resolveRef, getWorkspaceFile } from "@/api/workspace";
import { useAuthStore } from "@/stores/authStore";
import type { Message, Channel, PermissionContentData, MemberItem } from "@/types";

// In-flight bot placeholders arrive with `channel_seq: null`; they are the
// newest thing in the channel until finalized, so order them last. Stable sort
// preserves arrival order among equal keys.
const SEQ_MAX = Number.MAX_SAFE_INTEGER;
function seqKey(m: Message): number {
  return typeof m.channel_seq === "number" ? m.channel_seq : SEQ_MAX;
}
function sortMessages(msgs: Message[]): Message[] {
  return [...msgs].sort((a, b) => seqKey(a) - seqKey(b));
}

function upsertMessage(
  msgs: Message[],
  incoming: Partial<Message> & { msg_id: string }
): Message[] {
  const idx = msgs.findIndex((m) => m.msg_id === incoming.msg_id);
  if (idx === -1) return sortMessages([...msgs, incoming as Message]);
  const reorder =
    incoming.channel_seq !== undefined &&
    msgs[idx].channel_seq !== incoming.channel_seq;
  const next = msgs.map((m, i) => (i === idx ? { ...m, ...incoming } : m));
  return reorder ? sortMessages(next) : next;
}

function mergeMessages(msgs: Message[], incoming: Message[]): Message[] {
  let out = msgs;
  for (const m of incoming) out = upsertMessage(out, m);
  return out;
}

interface Props {
  channel: Channel | null;
  /** Mobile stacked navigation: renders a back button that pops to the channel list. */
  onBack?: () => void;
  /** Desktop: whether the channel sidebar is expanded (drives the toggle icon). */
  sidebarOpen?: boolean;
  /** Desktop: collapse/expand the channel sidebar (renders a header toggle). */
  onToggleSidebar?: () => void;
}

export function ChannelView({ channel, onBack, sidebarOpen, onToggleSidebar }: Props) {
  const user = useAuthStore((s) => s.user);
  const patchChannel = useChatStore((s) => s.patchChannel);
  // Public channel the caller can see (as a workspace member) but hasn't joined
  // yet — everything membership-gated (history, members, realtime, composer) is
  // skipped and a join prompt renders instead. Joining patches the store, which
  // flips this off and lets the normal effects run.
  const isPreview = !!channel && channel.type !== "dm" && channel.is_member === false;
  const [joining, setJoining] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  // Distinguishes a failed initial history load from a genuinely empty channel —
  // without it a network/server failure renders the "No messages yet" empty state.
  const [loadError, setLoadError] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [mentionables, setMentionables] = useState<MentionCandidate[]>([]);
  // Full channel members (with bio/status) — powers the profile hovercard by id.
  const [members, setMembers] = useState<MemberItem[]>([]);
  // Slash-commands advertised by the channel's bots (⑦ command palette). Flat
  // list across all bots; refreshed on channel open and on reconnect catch-up.
  const [commands, setCommands] = useState<CommandCandidate[]>([]);
  const [onlineCount, setOnlineCount] = useState(0);
  // Workspace presence: who else is viewing which bot's workspace (from the `presence`
  // frame's `focus` array). Surfaced as viewer chips in the RemoteWorkspaceDialog.
  const [workspaceFocus, setWorkspaceFocus] = useState<PresenceFocus[]>([]);
  // Composer session target: "" = Auto (mention routing → primary); else a session_id.
  const [selectedSessionId, setSelectedSessionId] = useState("");
  // Bots @mentioned in the current draft (from the composer), so we can show their
  // mode/config controls inline when the caller is allowed to change them.
  const [mentionedBots, setMentionedBots] = useState<MentionCandidate[]>([]);
  // Header members dropdown (read-only list; management stays in settings).
  const [membersOpen, setMembersOpen] = useState(false);
  const membersRootRef = useRef<HTMLDivElement>(null);
  const closeMembers = useCallback(() => setMembersOpen(false), []);
  usePopoverDismiss(membersOpen, closeMembers, membersRootRef);
  // Message actions: reply target, multi-select set, pending forward payload.
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [selectMode, setSelectMode] = useState(false);
  const [forward, setForward] = useState<{ content: string; count: number } | null>(null);

  // Bots in the channel, derived from the mention candidates — the switcher lists
  // each bot's sessions under it.
  const switcherBots = useMemo(
    () =>
      mentionables
        .filter((m) => m.type === "bot")
        .map((m) => ({ botId: m.id, name: m.label })),
    [mentionables]
  );

  // A different channel means a different session set — drop any prior target.
  // Also drop any buffered stream deltas + cancel a pending flush so a stale frame
  // can't synthesize a phantom bubble in the newly opened channel.
  useEffect(() => {
    setSelectedSessionId("");
    setMentionedBots([]);
    setCommands([]);
    setMembersOpen(false);
    setReplyTo(null);
    setSelectMode(false);
    setSelectedIds(new Set());
    setForward(null);
    pendingDeltas.current.clear();
    if (flushHandle.current !== null) {
      cancelAnimationFrame(flushHandle.current);
      flushHandle.current = null;
    }
  }, [channel?.channel_id]);

  // Cancel any scheduled delta flush on unmount.
  useEffect(
    () => () => {
      if (flushHandle.current !== null) cancelAnimationFrame(flushHandle.current);
    },
    []
  );

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

  // Highest delivered channel_seq, used as the reconnect/refresh catch-up cursor.
  const lastSeqRef = useRef(0);
  useEffect(() => {
    let max = 0;
    for (const m of messages) {
      if (typeof m.channel_seq === "number" && m.channel_seq > max)
        max = m.channel_seq;
    }
    lastSeqRef.current = max;
  }, [messages]);

  // Initial history load (backend returns ascending: oldest first). A failure
  // sets loadError so the render shows a retryable error region instead of the
  // "No messages yet" empty state (a failed fetch must not masquerade as empty).
  const loadHistory = useCallback(() => {
    if (!channel || isPreview) return;
    setLoading(true);
    setLoadError(false);
    setMessages([]);
    listMessages(channel.channel_id, { limit: 50 })
      .then((res) => {
        setMessages(sortMessages(res.messages ?? res.data ?? []));
        setHasMore(res.meta?.has_more_before ?? false);
      })
      .catch(() => setLoadError(true))
      .finally(() => setLoading(false));
  }, [channel, isPreview]);

  useEffect(() => {
    if (!channel || isPreview) {
      setMessages([]);
      setLoadError(false);
      return;
    }
    loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel?.channel_id, isPreview]);

  // Opening a channel marks it read: clear the unread + mention badges
  // optimistically, then stamp last_read_at server-side so list_channels stops
  // counting either (both are gated on last_read_at).
  useEffect(() => {
    if (!channel || isPreview) return;
    if ((channel.unread_count ?? 0) > 0 || (channel.mention_count ?? 0) > 0)
      patchChannel(channel.channel_id, { unread_count: 0, mention_count: 0 });
    markChannelRead(channel.channel_id).catch(() => {});
  }, [channel?.channel_id, isPreview]); // eslint-disable-line react-hooks/exhaustive-deps

  // Mention candidates = channel members (users + bots).
  useEffect(() => {
    if (!channel || isPreview) {
      setMentionables([]);
      setMembers([]);
      return;
    }
    listChannelMembers(channel.channel_id)
      .then((rows) => {
        setMembers(rows);
        setMentionables(
          rows
            .filter((m) => m.member_type === "user" || m.member_type === "bot")
            .map((m) => ({
              id: m.member_id,
              type: m.member_type === "bot" ? "bot" : "user",
              label: m.display_name || m.username || m.member_id.slice(0, 8),
              sublabel: m.username,
              // Bots: whether the agent can hear audio prompts (null/undefined =
              // unknown → the composer treats it as "can't", fail-safe).
              canReceiveAudio: m.can_receive_audio ?? false,
            }))
        );
      })
      .catch(() => {
        setMembers([]);
        setMentionables([]);
      });
  }, [channel?.channel_id, isPreview]);

  // id → member profile, so a message avatar/name click can open the hovercard
  // even though the message itself carries no bio/status.
  const memberById = useMemo<Map<string, ProfileData>>(
    () => new Map(members.map((m) => [m.member_id, m])),
    [members]
  );

  const loadMore = useCallback(async () => {
    if (!channel || loadingMore || !hasMore) return;
    const oldest = messages[0];
    if (!oldest) return;
    setLoadingMore(true);
    try {
      const res = await listMessages(channel.channel_id, {
        before: oldest.msg_id,
        limit: 50,
      });
      setMessages((prev) => mergeMessages(prev, res.messages ?? res.data ?? []));
      setHasMore(res.meta?.has_more_before ?? false);
    } catch {
      // hasMore stays true, so scrolling up again retries this page. Stable id so a
      // momentum-scroll at the top that re-fires loadMore collapses to one toast.
      toast.error("Couldn't load older messages — scroll up to try again", {
        id: "load-older-failed",
      });
    } finally {
      setLoadingMore(false);
    }
  }, [channel, messages, hasMore, loadingMore]);

  // Reconnect/refresh self-heal: pull everything past our last seq and merge.
  const catchUp = useCallback(async () => {
    if (!channel) return;
    try {
      const res = await listMessages(channel.channel_id, {
        since_seq: lastSeqRef.current,
      });
      const incoming = res.messages ?? res.data ?? [];
      if (incoming.length) setMessages((prev) => mergeMessages(prev, incoming));
    } catch {
      /* best-effort; the live stream still delivers new frames */
    }
  }, [channel]);

  const handleMessage = useCallback((msg: Message) => {
    setMessages((prev) => upsertMessage(prev, msg));
    // A resolved approval landing → nudge the Audit board to re-fetch live.
    if (
      msg.msg_type === "permission" &&
      (msg.content_data as PermissionContentData | null | undefined)?.resolved === true
    ) {
      setBoardTick((t) => ({ ...t, audit: (t.audit ?? 0) + 1 }));
    }
  }, []);

  // Stream deltas arrive one WS frame per token chunk (tens/sec). Applying a
  // setMessages per frame runs a full channel render + O(N) list rebuild each time.
  // Instead buffer per-msg_id text and flush once per animation frame: the final
  // rendered content is byte-identical, only intermediate paint frequency drops from
  // token-rate to display-refresh-rate.
  const pendingDeltas = useRef<Map<string, string>>(new Map());
  const flushHandle = useRef<number | null>(null);

  const flushDeltas = useCallback(() => {
    flushHandle.current = null;
    const batch = pendingDeltas.current;
    if (batch.size === 0) return;
    pendingDeltas.current = new Map();
    setMessages((prev) => {
      let out = prev;
      let copied = false; // true once `out` is a fresh array safe to mutate in place
      for (const [msgId, delta] of batch) {
        const idx = out.findIndex((m) => m.msg_id === msgId);
        if (idx === -1) {
          // Defensive: a delta beat its placeholder bubble — synthesize one.
          out = upsertMessage(out, {
            msg_id: msgId,
            sender_type: "bot",
            content: delta,
            is_partial: true,
            _streaming: true,
          });
          copied = true; // upsertMessage returns a fresh array
        } else {
          if (!copied) {
            out = out.slice();
            copied = true;
          }
          out[idx] = {
            ...out[idx],
            content: (out[idx].content ?? "") + delta,
            _streaming: true,
          };
        }
      }
      return out;
    });
  }, []);

  const handleStreamDelta = useCallback(
    (msgId: string, delta: string) => {
      const pending = pendingDeltas.current;
      pending.set(msgId, (pending.get(msgId) ?? "") + delta);
      if (flushHandle.current === null) {
        flushHandle.current = requestAnimationFrame(flushDeltas);
      }
    },
    [flushDeltas]
  );

  const handleStreamDone = useCallback(
    (update: Partial<Message> & { msg_id: string }) => {
      // The done frame carries the full final content and overwrites wholesale, so
      // any buffered deltas for this message are stale — drop them (flushing first
      // would either duplicate text or append after finalize).
      pendingDeltas.current.delete(update.msg_id);
      setMessages((prev) =>
        upsertMessage(prev, { ...update, _streaming: false, _trace: null })
      );
    },
    []
  );

  const handleBotTrace = useCallback(
    (msgId: string | null, title: string | null) => {
      if (!msgId) return;
      setMessages((prev) => upsertMessage(prev, { msg_id: msgId, _trace: title }));
    },
    []
  );

  const handleDeleted = useCallback((msgId: string) => {
    pendingDeltas.current.delete(msgId);
    setMessages((prev) =>
      prev.map((m) =>
        m.msg_id === msgId ? { ...m, is_deleted: true, content: "" } : m
      )
    );
  }, []);

  // Transcription finished (or terminally failed) → patch every rendered message
  // carrying that file so the audio tile updates in place, no reload needed.
  const handleFileTranscribed = useCallback(
    (fileId: string, status: string, summary: string | null) => {
      setMessages((prev) =>
        prev.map((m) => {
          if (!m.files?.some((f) => f.file_id === fileId)) return m;
          return {
            ...m,
            files: m.files.map((f) =>
              f.file_id === fileId
                ? { ...f, summary: summary ?? f.summary, transcript_status: status }
                : f
            ),
          };
        })
      );
    },
    []
  );

  // Refresh the slash-command palette from `channel.commands.read`. Bot-produced
  // command names/descriptions are untrusted — they only ever render as inert
  // text in the picker. Best-effort: a failure just leaves the palette empty.
  const sendResourceReqRef = useRef<
    ((resource: string, params: Record<string, unknown>) => Promise<unknown>) | null
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
        }))
      );
      setCommands(flat);
    } catch {
      /* best-effort; the composer just won't offer "/" commands */
    }
  }, [channel, isPreview, botLabels]);

  // Realtime "ready" → self-heal the message stream AND refresh the palette
  // (a bot may have advertised new commands while we were away).
  const handleReady = useCallback(() => {
    void catchUp();
    void loadCommands();
  }, [catchUp, loadCommands]);

  const { sendResourceReq, sendPresenceFocus } = useChatRealtime(
    // Preview (not yet a member) → don't subscribe; the gateway gates realtime
    // frames on channel membership anyway.
    !channel || isPreview ? null : channel.channel_id,
    {
    onMessage: handleMessage,
    onStreamDelta: handleStreamDelta,
    onStreamDone: handleStreamDone,
    onMessageDeleted: handleDeleted,
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
        setWorkspaceTick((prev) => ({ seq: (prev?.seq ?? 0) + 1, botId: botId ?? null }));
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
            : row
        )
      ),
    }
  );
  // Keep a stable ref so loadCommands can reach the latest resource client
  // without re-subscribing the realtime hook.
  sendResourceReqRef.current = sendResourceReq;

  // Re-flatten the palette when bot labels resolve after the initial fetch.
  useEffect(() => {
    void loadCommands();
  }, [loadCommands]);
  const [wbOpen, setWbOpen] = useState(false);
  // ViewBoard open/minimal survive reloads and channel switches (it's a channel-agnostic
  // viewing preference, like a theme — the boards themselves re-scope per channel).
  const [vbOpen, setVbOpen] = useState(
    () => localStorage.getItem("cheers.viewboard.open") === "1"
  );
  // Minimal ViewBoard: a compact content-height card in a narrower column (vs the full
  // full-height column). Still reserves its own column so it never covers the chat.
  const [vbMinimal, setVbMinimal] = useState(
    () => localStorage.getItem("cheers.viewboard.minimal") === "1"
  );
  useEffect(() => {
    localStorage.setItem("cheers.viewboard.open", vbOpen ? "1" : "0");
  }, [vbOpen]);
  useEffect(() => {
    localStorage.setItem("cheers.viewboard.minimal", vbMinimal ? "1" : "0");
  }, [vbMinimal]);
  // Live-push: per-board tick bumped by board_signal frames (and new messages for
  // "activity"); the ViewBoards re-fetch when their tick changes — no manual refresh.
  const [boardTick, setBoardTick] = useState<Record<string, number>>({});
  // "workspace" ticks additionally carry the emitting bot (turn-complete signal), so
  // the workspace dialog can ignore turns finished by bots it isn't browsing.
  const [workspaceTick, setWorkspaceTick] = useState<
    { seq: number; botId: string | null } | undefined
  >(undefined);
  // Live-watch: latest bot-scoped workspace change signal (from `workspace_signal`).
  // `seq` monotonically bumps so the dialog re-reacts even to repeat signals for the
  // same paths; the dialog routes on `botId` (a channel may span several machines).
  const [workspaceSignal, setWorkspaceSignal] = useState<{
    botId: string;
    root: string;
    paths: string[];
    seq: number;
  } | null>(null);
  const [filesOpen, setFilesOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [wsOpen, setWsOpen] = useState(false);
  const [wsInit, setWsInit] = useState<{ botId?: string; path?: string }>({});
  const [filesFocus, setFilesFocus] = useState<string | undefined>(undefined);

  // The work lane is the bounded canvas the instrument windows drag/resize
  // inside. Track its element as state (not a ref) so panels re-render with the
  // real bounds once it mounts; getLaneBounds is read live on every drag/resize.
  // MUST stay above the isPreview early-return so the hook order never changes.
  const [laneEl, setLaneEl] = useState<HTMLElement | null>(null);
  const getLaneBounds = useCallback(
    () => laneEl?.getBoundingClientRect() ?? null,
    [laneEl]
  );
  // The lane also resizes without a window resize event — collapsing the sidebar
  // reflows its width via CSS. Re-clamp the floating windows on any lane box
  // change so one can't get stranded in the lane's overflow-hidden clip.
  useEffect(() => {
    if (!laneEl || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => window.dispatchEvent(new Event("resize")));
    ro.observe(laneEl);
    return () => ro.disconnect();
  }, [laneEl]);
  const [wbTarget, setWbTarget] = useState<string | undefined>(undefined);
  const [refError, setRefError] = useState<string | null>(null);
  // Jump-to-message request from ViewBoard history items (activity rows, audit
  // cards). `nonce` lets a repeat click on the same row re-trigger the scroll.
  // Best-effort: MessageList only scrolls when the message is loaded.
  const [focusMsg, setFocusMsg] = useState<{ msgId: string; nonce: number } | null>(null);
  const jumpToMessage = useCallback(
    (msgId: string) => setFocusMsg((prev) => ({ msgId, nonce: (prev?.nonce ?? 0) + 1 })),
    []
  );
  // "Open the ViewBoard on THIS board" request (same nonce pattern as focusMsg) —
  // the session chip's "Manage sessions…" jumps straight to the Sessions board.
  const [focusBoard, setFocusBoard] = useState<{ id: string; nonce: number } | null>(null);
  const openSessionsBoard = useCallback(() => {
    setVbMinimal(false);
    setVbOpen(true);
    setFocusBoard((prev) => ({ id: "sessions", nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);

  // Stable handlers for the memoized drawers so a streaming re-render of ChannelView
  // doesn't hand them fresh closures (which would defeat React.memo).
  const closeViewBoard = useCallback(() => setVbOpen(false), []);
  const toggleViewBoardMinimal = useCallback(() => setVbMinimal((m) => !m), []);
  const closeWorkbench = useCallback(() => setWbOpen(false), []);

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
            onChange={setSelectedSessionId}
            sendResourceReq={sendResourceReq}
            onManageSessions={openSessionsBoard}
          />
          {/* Model/mode + config for the @mentioned bot(s); with no live
              mention, fall back to the channel's bots so the controls are
              always reachable. */}
          <ComposerModelPopover
            channelId={channel.channel_id}
            bots={
              mentionedBots.length > 0
                ? mentionedBots.map((m) => ({ botId: m.id, name: m.label }))
                : switcherBots
            }
            selectedSessionId={selectedSessionId}
          />
        </>
      ) : null,
    // sendResourceReq and openSessionsBoard are identity-stable (useCallback).
    [channel, switcherBots, selectedSessionId, mentionedBots, sendResourceReq, openSessionsBoard]
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
            !m.is_deleted
        )
        .map((m) => m.msg_id),
    [messages]
  );
  const streamingIdsRef = useRef(streamingIds);
  streamingIdsRef.current = streamingIds;
  const channelIdForStop = channel?.channel_id;
  const stopStreaming = useCallback(async () => {
    if (!channelIdForStop) return;
    await Promise.all(
      streamingIdsRef.current.map((id) => stopTurn(channelIdForStop, id))
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
      const senderBotLabel = botLabels.get(senderBotId) || senderBotId.slice(0, 8);
      const openInbox = (fileId: string) => {
        setFilesFocus(fileId);
        setFilesOpen(true);
      };
      // 1) Strongest signal: a file THIS message attached (an inbox deliverable).
      const hit = (files || []).find((f) => (f.original_filename || "") === base);
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
          setWbOpen(true);
        } else if (r.store === "workspace" && r.bot_id && r.path) {
          // The workspace candidate is unprobed — verify the file actually exists on
          // the bot's machine before dropping the user into the browser. If it
          // doesn't, it lives nowhere we can reach → clear error, not a broken view.
          try {
            await getWorkspaceFile(channel.channel_id, r.bot_id, r.path);
            setWsInit({ botId: r.bot_id, path: r.path });
            setWsOpen(true);
          } catch (e) {
            const offline = String(e).includes("offline");
            setRefError(
              offline
                ? `Can't open "${base}": this file lives on bot "${senderBotLabel}"'s machine, but its connector is currently offline.`
                : `Couldn't find "${base}".\nIt isn't attached to this reply, on the channel Desk, or in the workspace — the bot may have only mentioned it without actually producing or sharing it.`
            );
          }
        } else {
          setRefError(
            `Couldn't find "${base}".\nIt isn't attached to this reply, on the channel Desk, or in any reachable workspace — the bot may have mentioned this file without actually producing or sharing it.`
          );
        }
      } catch (e) {
        setRefError(`Failed to open "${base}": ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [channel, botLabels]
  );

  const handleSend = useCallback(
    async (
      content: string,
      mentionIds: string[],
      fileIds: string[],
      mentionNames: string[] = []
    ) => {
    if (!channel) return;
    const sendParams: NonNullable<Message["_sendParams"]> = {
      content,
      ...(mentionIds.length ? { mention_ids: mentionIds } : {}),
      ...(mentionNames.length ? { mention_names: mentionNames } : {}),
      ...(fileIds.length ? { file_ids: fileIds } : {}),
      ...(selectedSessionId ? { session_id: selectedSessionId } : {}),
      ...(replyTo ? { reply_to_msg_id: replyTo.msg_id } : {}),
    };
    setReplyTo(null);
    try {
      const { content: body, ...opts } = sendParams;
      await sendMessage(channel.channel_id, body, opts);
    } catch {
      // Don't lose the message: drop a client-only "failed" bubble into the
      // timeline (the composer already cleared the draft) so it stays visible
      // with its content and a Retry button. Never persisted / sent to the server.
      const failed: Message = {
        msg_id: `local-failed-${crypto.randomUUID()}`,
        sender_id: user?.user_id ?? "",
        sender_type: "user",
        sender_name: user?.display_name ?? user?.username,
        content,
        created_at: new Date().toISOString(),
        ...(fileIds.length ? { file_ids: fileIds } : {}),
        _status: "failed",
        _sendParams: sendParams,
      };
      setMessages((prev) => sortMessages([...prev, failed]));
    }
    },
    [channel, selectedSessionId, replyTo, user]
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
          m.msg_id === failed.msg_id ? { ...m, _status: "sending" } : m
        )
      );
      try {
        const sent = await sendMessage(channel.channel_id, content, opts);
        setMessages((prev) =>
          upsertMessage(
            prev.filter((m) => m.msg_id !== failed.msg_id),
            sent
          )
        );
      } catch {
        setMessages((prev) =>
          prev.map((m) =>
            m.msg_id === failed.msg_id ? { ...m, _status: "failed" } : m
          )
        );
        toast.error("Still couldn't send — check your connection");
      }
    },
    [channel]
  );

  // ── Message actions: reply / copy / forward / multi-select ────────────────
  const displayName = useCallback(
    (m: Message) =>
      m.sender_name || memberNames.get(m.sender_id) || m.sender_id.slice(0, 8),
    [memberNames]
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
    [channel?.type, channel?.name, displayName]
  );

  /** Selected messages in channel order (selection set has no order of its own). */
  const selectedMessages = useMemo(
    () => messages.filter((m) => selectedIds.has(m.msg_id)),
    [messages, selectedIds]
  );

  // Stable identity: selection state deliberately NOT captured here (it travels
  // as scalar props), so a selection toggle only re-renders the affected rows
  // instead of defeating memo(MessageItem) list-wide.
  const messageActions: MessageActionHandlers = useMemo(
    () => ({
      onReply: (m) => setReplyTo(m),
      onForward: (m) => setForward({ content: buildForwardContent([m]), count: 1 }),
      onToggleSelect: (m) => {
        setSelectMode(true);
        // Entering select mode hides the reply banner — disarm the reply too so
        // the next send can't silently become a reply to an invisible target.
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
    [buildForwardContent, retryMessage]
  );

  const clearSelection = () => {
    setSelectMode(false);
    setSelectedIds(new Set());
  };

  async function copySelected() {
    const text = selectedMessages
      .map((m) => `${displayName(m)}: ${(m.content ?? "").replace(/<#file:[^>]+>/g, "").trim()}`)
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`Copied ${selectedMessages.length} message${selectedMessages.length > 1 ? "s" : ""}`);
      clearSelection();
    } catch {
      toast.error("Clipboard unavailable");
    }
  }

  // Desktop sidebar collapse toggle — lives in the channel header (and floats in
  // the empty state, so an expanded toggle is always reachable while collapsed).
  const isMac = /Mac/i.test(navigator.platform || navigator.userAgent);
  const sidebarToggle = onToggleSidebar ? (
    <button
      onClick={onToggleSidebar}
      title={`${sidebarOpen ? "Hide" : "Show"} sidebar (${isMac ? "⌘B" : "Ctrl+B"})`}
      aria-label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
      className="max-md:hidden flex items-center justify-center w-7 h-7 rounded-lg text-zinc-500 hover:text-zinc-100 hover:bg-zinc-800 flex-shrink-0 transition-colors"
    >
      {sidebarOpen ? (
        <PanelLeftClose className="w-4 h-4" />
      ) : (
        <PanelLeftOpen className="w-4 h-4" />
      )}
    </button>
  ) : null;

  if (!channel) {
    return (
      <div className="relative flex-1 flex items-center justify-center text-zinc-400 text-sm flex-col gap-3">
        {sidebarToggle && (
          <div className="absolute top-2.5 left-3">{sidebarToggle}</div>
        )}
        <Hash className="w-10 h-10 text-zinc-700" />
        <span>Select a channel to start chatting</span>
      </div>
    );
  }

  // Public channel the caller hasn't joined: a join prompt instead of the chat.
  // No history/members/composer — those are membership-gated server-side.
  if (isPreview) {
    const handleJoin = async () => {
      setJoining(true);
      try {
        await joinChannel(channel.channel_id);
        // Store patch flips is_member → the normal effects load the channel.
        patchChannel(channel.channel_id, { is_member: true });
        toast.success(`Joined #${channel.name}`);
      } catch {
        toast.error("Couldn't join the channel — please try again");
      } finally {
        setJoining(false);
      }
    };
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center gap-3 max-md:gap-1 px-4 max-md:px-2 h-12 border-b border-zinc-800 bg-zinc-950/80 backdrop-blur-sm flex-shrink-0">
          {sidebarToggle && <div className="-ml-1 mr-1">{sidebarToggle}</div>}
          {onBack && (
            <button
              onClick={onBack}
              title="Back to channels"
              aria-label="Back to channels"
              className="md:hidden flex items-center justify-center w-11 h-11 -ml-1 rounded-lg text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 flex-shrink-0"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
          )}
          <Hash className="w-4 h-4 text-zinc-500 flex-shrink-0 max-md:hidden" />
          <span className="font-semibold text-zinc-100 text-sm truncate min-w-0 max-md:pl-1">
            {channel.name}
          </span>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center gap-3 px-6 text-center">
          <Hash className="w-10 h-10 text-zinc-700" />
          <div className="text-zinc-100 font-semibold text-lg">#{channel.name}</div>
          {channel.purpose && (
            <p className="text-sm text-zinc-400 max-w-md">{channel.purpose}</p>
          )}
          <p className="text-sm text-zinc-400">
            You&apos;re not a member of this channel yet. Join to read and send
            messages.
          </p>
          <button
            type="button"
            onClick={() => void handleJoin()}
            disabled={joining}
            className="mt-2 inline-flex items-center gap-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 px-4 py-2 text-sm font-medium text-white"
          >
            {joining && <Loader2 className="w-4 h-4 animate-spin" />}
            Join channel
          </button>
        </div>
      </div>
    );
  }

  const anyWorkOpen = vbOpen || wbOpen || wsOpen || filesOpen;

  return (
    <ProfileCardProvider members={memberById}>
    {/* Desktop: instrument panels DOCK into a dedicated work area on the right,
        which reserves real layout space. The chat column is always width-capped:
        centered while the work area is closed, docked against it when open.
        Mobile: the panels stay full/near-full-screen overlay sheets. */}
    <div className="flex flex-col h-full">
      {/* Channel header — `relative z-30` lifts the header's stacking context (it
          already makes one via backdrop-blur) above the message list, so header
          dropdowns like the session panel render over the chat, not under it. */}
      <div className="relative z-30 flex items-center gap-3 max-md:gap-1 px-4 max-md:px-2 h-12 border-b border-zinc-800 bg-zinc-950/80 backdrop-blur-sm flex-shrink-0">
        {sidebarToggle && <div className="-ml-1 mr-1">{sidebarToggle}</div>}
        {onBack && (
          <button
            onClick={onBack}
            title="Back to channels"
            aria-label="Back to channels"
            className="md:hidden flex items-center justify-center w-11 h-11 -ml-1 rounded-lg text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 flex-shrink-0"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
        )}
        <Hash className="w-4 h-4 text-zinc-500 flex-shrink-0 max-md:hidden" />
        <span className="font-semibold text-zinc-100 text-sm truncate min-w-0 max-md:pl-1">
          {channel.name}
        </span>
        {channel.purpose && (
          <div className="hidden md:flex items-center gap-3 min-w-0">
            <div className="w-px h-4 bg-zinc-700" />
            <span className="text-xs text-zinc-400 truncate">
              {channel.purpose}
            </span>
          </div>
        )}
        <div className="flex-1" />
        <div className="hidden md:flex items-center gap-3 text-xs text-zinc-400">
          {/* Members: was a dead-looking span — now a real button opening the roster. */}
          <div className="relative" ref={membersRootRef}>
            <button
              type="button"
              onClick={() => setMembersOpen((v) => !v)}
              title="Channel members"
              aria-expanded={membersOpen}
              className={`flex items-center gap-1.5 rounded px-1.5 py-1 hover:text-zinc-100 hover:bg-zinc-800 transition-colors ${
                membersOpen ? "text-zinc-100 bg-zinc-800" : ""
              }`}
            >
              <Users className="w-3.5 h-3.5" />
              {mentionables.length || "Members"}
              {onlineCount > 0 && (
                <span className="flex items-center gap-1.5 ml-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                  {onlineCount} online
                </span>
              )}
            </button>
            {membersOpen && (
              <MembersPopover
                channelId={channel.channel_id}
                isDm={channel.type === "dm"}
                onManage={() => setSettingsOpen(true)}
                onClose={() => setMembersOpen(false)}
              />
            )}
          </div>
        </div>
        {/* Channel files (chat attachments) — its own view, separate from the Workbench. */}
        <button
          onClick={() => {
            setFilesFocus(undefined);
            setFilesOpen((v) => !v);
          }}
          title="Channel files"
          className={`flex items-center justify-center w-7 h-7 max-md:w-10 max-md:h-10 rounded-lg hover:bg-zinc-800 flex-shrink-0 ${
            filesOpen ? "text-zinc-100 bg-zinc-800" : "text-zinc-500 hover:text-zinc-100"
          }`}
        >
          <Paperclip className="w-4 h-4" />
        </button>
        <button
          onClick={() => {
            setWsInit({});
            setWsOpen((v) => !v);
          }}
          title="Remote workspace"
          className={`flex items-center justify-center w-7 h-7 max-md:w-10 max-md:h-10 rounded-lg hover:bg-zinc-800 flex-shrink-0 ${
            wsOpen ? "text-zinc-100 bg-zinc-800" : "text-zinc-500 hover:text-zinc-100"
          }`}
        >
          <FolderTree className="w-4 h-4" />
        </button>
        <button
          onClick={() => setVbOpen((v) => !v)}
          title="ViewBoard — live plan / cost / sessions / audit (instrument plane)"
          className={`flex items-center justify-center w-7 h-7 max-md:w-10 max-md:h-10 rounded-lg hover:bg-zinc-800 flex-shrink-0 ${
            vbOpen ? "text-zinc-100 bg-zinc-800" : "text-zinc-500 hover:text-zinc-100"
          }`}
        >
          <LayoutDashboard className="w-4 h-4" />
        </button>
        <button
          onClick={() => {
            setWbTarget(undefined);
            setWbOpen((v) => !v);
          }}
          title="Workbench — file workspace"
          className={`flex items-center justify-center w-7 h-7 max-md:w-10 max-md:h-10 rounded-lg hover:bg-zinc-800 flex-shrink-0 ${
            wbOpen ? "text-zinc-100 bg-zinc-800" : "text-zinc-500 hover:text-zinc-100"
          }`}
        >
          <PanelRight className="w-4 h-4" />
        </button>
        {channel.type !== "dm" && (
          <>
            {/* Divider: the buttons left of it toggle instrument panels in the
                lane; Settings opens a modal — a different kind of action. */}
            <div className="w-px h-4 bg-zinc-700 flex-shrink-0 mx-0.5" />
            <button
              onClick={() => setSettingsOpen(true)}
              title="Channel settings"
              className="flex items-center justify-center w-7 h-7 max-md:w-10 max-md:h-10 rounded-lg text-zinc-500 hover:text-zinc-100 hover:bg-zinc-800 flex-shrink-0"
            >
              <Settings className="w-4 h-4" />
            </button>
          </>
        )}
      </div>

      <div className="flex-1 min-h-0 flex">
      {/* Chat region — capped at 52rem when the lane is open so the lane takes
          all the remaining width; shrinks to a 24rem floor before the lane
          does. Centered when the lane is closed. */}
      <div
        className={`flex-1 min-w-0 flex flex-col ${
          anyWorkOpen ? "md:max-w-[52rem] md:min-w-[24rem]" : ""
        }`}
      >
      <div
        className={`flex flex-col h-full w-full min-w-0 md:max-w-[52rem] ${
          anyWorkOpen ? "md:ml-auto" : "md:mx-auto"
        }`}
      >
      {/* Messages */}
      {loading ? (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="w-5 h-5 text-zinc-600 animate-spin" />
        </div>
      ) : loadError ? (
        <div
          role="alert"
          className="flex-1 flex flex-col items-center justify-center gap-3 px-6 text-center"
        >
          <AlertCircle className="w-8 h-8 text-zinc-700" />
          <p className="text-sm text-zinc-400 max-w-xs">
            Couldn&apos;t load messages. Check your connection and try again.
          </p>
          <Button variant="secondary" size="sm" onClick={loadHistory}>
            Retry
          </Button>
        </div>
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
          />
        </ResolveRefContext.Provider>
      )}

      {/* Multi-select toolbar — replaces nothing, floats above the composer. */}
      {selectMode && (
        <div className="flex items-center gap-2 px-4 py-2 border-t border-zinc-800 bg-zinc-900/80 text-xs">
          <span className="text-zinc-300 font-medium">
            {selectedIds.size} selected
          </span>
          <span className="text-zinc-400">· click messages to toggle</span>
          <div className="flex-1" />
          <button
            type="button"
            disabled={selectedIds.size === 0}
            onClick={() => void copySelected()}
            className="inline-flex items-center gap-1.5 rounded-md bg-zinc-800 px-2.5 py-1 text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100 disabled:opacity-40"
          >
            <Copy className="w-3.5 h-3.5" />
            Copy
          </button>
          <button
            type="button"
            disabled={selectedIds.size === 0}
            onClick={() =>
              setForward({
                content: buildForwardContent(selectedMessages),
                count: selectedMessages.length,
              })
            }
            className="inline-flex items-center gap-1.5 rounded-md bg-zinc-800 px-2.5 py-1 text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100 disabled:opacity-40"
          >
            <Forward className="w-3.5 h-3.5" />
            Forward
          </button>
          <button
            type="button"
            onClick={clearSelection}
            className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-zinc-400 hover:text-zinc-200"
          >
            <X className="w-3.5 h-3.5" />
            Cancel
          </button>
        </div>
      )}

      {/* Reply banner — the composer's next send answers this message. */}
      {replyTo && !selectMode && (
        <div className="flex items-center gap-2 px-4 py-1.5 border-t border-zinc-800 bg-zinc-900/60 text-xs">
          <Reply className="w-3.5 h-3.5 text-indigo-400 flex-shrink-0" />
          <span className="text-zinc-400 flex-shrink-0">Replying to</span>
          <span className="text-zinc-300 font-medium flex-shrink-0">{displayName(replyTo)}</span>
          <span className="text-zinc-400 truncate italic">
            {(replyTo.content ?? "").replace(/<#file:[^>]+>/g, "").trim().slice(0, 120)}
          </span>
          <button
            type="button"
            onClick={() => setReplyTo(null)}
            title="Cancel reply"
            className="ml-auto text-zinc-500 hover:text-zinc-200 flex-shrink-0"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Composer */}
      <MessageComposer
        channelId={channel.channel_id}
        channelName={channel.name}
        mentionables={mentionables}
        commands={commands}
        toolbar={composerToolbar}
        onMentionsChange={setMentionedBots}
        streamingCount={streamingIds.length}
        onStopStreaming={stopStreaming}
        onSend={handleSend}
      />
      </div>
      </div>

      {/* Work area — a dedicated lane on the right, a bounded canvas the
          instrument windows (unchanged chrome) float, drag and resize inside.
          It fills the width left of the capped chat column. `relative` +
          `overflow-hidden` make it the positioning context and clip stray
          windows. On mobile it's display:contents — the panels stay overlay
          sheets there. LaneBoundsContext hands each window this box's live
          rect so drag/resize stays inside it. */}
      <aside
        ref={setLaneEl}
        className={
          anyWorkOpen
            ? "max-md:contents md:relative md:flex-1 md:min-w-[20rem] md:min-h-0 md:overflow-hidden"
            : "contents"
        }
      >
        <LaneBoundsContext.Provider value={anyWorkOpen ? getLaneBounds : null}>
        {wsOpen && (
          <Suspense fallback={null}>
          <RemoteWorkspaceDialog
            channelId={channel.channel_id}
            onClose={() => setWsOpen(false)}
            initialBotId={wsInit.botId}
            initialPath={wsInit.path}
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
          focusBoard={focusBoard ?? undefined}
        />

        <WorkbenchDrawer
          open={wbOpen}
          onClose={closeWorkbench}
          channelId={channel.channel_id}
          sendResourceReq={sendResourceReq}
          openFilePath={wbTarget}
          filesTick={boardTick.files}
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
          <ChannelSettingsDialog channel={channel} onClose={() => setSettingsOpen(false)} />
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
      {refError && <ErrorDialog message={refError} onClose={() => setRefError(null)} />}
    </div>
    </ProfileCardProvider>
  );
}
