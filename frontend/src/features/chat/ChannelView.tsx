import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { ArrowLeft, Hash, Users, Loader2, PanelRight, Paperclip, FolderTree, Settings, LayoutDashboard, Reply, X, Copy, Forward } from "lucide-react";
import toast from "react-hot-toast";
import { listMessages, sendMessage } from "@/api/messages";
import { listChannelMembers, markChannelRead } from "@/api/channels";
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
import { SessionSwitcher } from "./SessionSwitcher";
import { ComposerBotSettings } from "./ComposerBotSettings";
import { useChatRealtime, type PresenceFocus } from "./hooks/useChatRealtime";
import { WorkbenchDrawer } from "./workbench/WorkbenchDrawer";
import { ViewBoardDrawer } from "./workbench/ViewBoardDrawer";
import { ErrorDialog } from "@/components/ui/ErrorDialog";
import { ChannelFilesDialog } from "./ChannelFilesDialog";
import { ChannelSettingsDialog } from "./ChannelSettingsDialog";
import { RemoteWorkspaceDialog } from "./RemoteWorkspaceDialog";
import { ResolveRefContext, type RefClick } from "./workspaceLink";
import { resolveRef, getWorkspaceFile } from "@/api/workspace";
import { useAuthStore } from "@/stores/authStore";
import { useIsMobile } from "@/hooks/useIsMobile";
import type { Message, Channel, PermissionContentData } from "@/types";

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
}

export function ChannelView({ channel, onBack }: Props) {
  const user = useAuthStore((s) => s.user);
  const isMobile = useIsMobile();
  const patchChannel = useChatStore((s) => s.patchChannel);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [mentionables, setMentionables] = useState<MentionCandidate[]>([]);
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
  useEffect(() => {
    setSelectedSessionId("");
    setMentionedBots([]);
    setCommands([]);
    setMembersOpen(false);
    setReplyTo(null);
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

  // Initial history load (backend returns ascending: oldest first).
  useEffect(() => {
    if (!channel) {
      setMessages([]);
      return;
    }
    setLoading(true);
    setMessages([]);
    listMessages(channel.channel_id, { limit: 50 })
      .then((res) => {
        setMessages(sortMessages(res.messages ?? res.data ?? []));
        setHasMore(res.meta?.has_more_before ?? false);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [channel?.channel_id]);

  // Opening a channel marks it read: clear the badge optimistically, then stamp
  // last_read_at server-side so list_channels stops counting it.
  useEffect(() => {
    if (!channel) return;
    if ((channel.unread_count ?? 0) > 0) patchChannel(channel.channel_id, { unread_count: 0 });
    markChannelRead(channel.channel_id).catch(() => {});
  }, [channel?.channel_id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Mention candidates = channel members (users + bots).
  useEffect(() => {
    if (!channel) {
      setMentionables([]);
      return;
    }
    listChannelMembers(channel.channel_id)
      .then((members) =>
        setMentionables(
          members
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
        )
      )
      .catch(() => setMentionables([]));
  }, [channel?.channel_id]);

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

  const handleStreamDelta = useCallback((msgId: string, delta: string) => {
    setMessages((prev) => {
      const idx = prev.findIndex((m) => m.msg_id === msgId);
      if (idx === -1) {
        // Defensive: a delta beat its placeholder bubble — synthesize one.
        return upsertMessage(prev, {
          msg_id: msgId,
          sender_type: "bot",
          content: delta,
          is_partial: true,
          _streaming: true,
        });
      }
      return prev.map((m, i) =>
        i === idx
          ? { ...m, content: (m.content ?? "") + delta, _streaming: true }
          : m
      );
    });
  }, []);

  const handleStreamDone = useCallback(
    (update: Partial<Message> & { msg_id: string }) => {
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
    if (!channel) return;
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
  }, [channel, botLabels]);

  // Realtime "ready" → self-heal the message stream AND refresh the palette
  // (a bot may have advertised new commands while we were away).
  const handleReady = useCallback(() => {
    void catchUp();
    void loadCommands();
  }, [catchUp, loadCommands]);

  const { sendResourceReq, sendPresenceFocus } = useChatRealtime(
    channel?.channel_id ?? null,
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
    onBoardSignal: (board) =>
      setBoardTick((t) => ({ ...t, [board]: (t[board] ?? 0) + 1 })),
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
  const [wbTarget, setWbTarget] = useState<string | undefined>(undefined);
  const [refError, setRefError] = useState<string | null>(null);

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

  async function handleSend(
    content: string,
    mentionIds: string[],
    fileIds: string[]
  ) {
    if (!channel) return;
    await sendMessage(channel.channel_id, content, {
      ...(mentionIds.length ? { mention_ids: mentionIds } : {}),
      ...(fileIds.length ? { file_ids: fileIds } : {}),
      ...(selectedSessionId ? { session_id: selectedSessionId } : {}),
      ...(replyTo ? { reply_to_msg_id: replyTo.msg_id } : {}),
    });
    setReplyTo(null);
  }

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
    }),
    [buildForwardContent]
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

  // Reserve room on the right for open instrument panels so they get their OWN column
  // instead of floating over the chat + composer. Widths mirror the drawers (ViewBoard
  // 420 @ right-3, Workbench 560 @ right-0); GAP keeps a seam between chat and panel.
  const VB_W = vbMinimal ? 280 : 420;
  const WB_W = 560;
  const GAP = 12;
  const boardExtent = vbOpen ? (wbOpen ? WB_W + GAP : GAP) + VB_W : wbOpen ? WB_W : 0;
  // Phones: the panels overlay the chat as full-screen sheets instead of docking
  // into their own column — reserving side space would crush the chat to zero.
  const reservedRight = !isMobile && boardExtent > 0 ? boardExtent + GAP : 0;

  if (!channel) {
    return (
      <div className="flex-1 flex items-center justify-center text-zinc-600 text-sm flex-col gap-3">
        <Hash className="w-10 h-10 text-zinc-700" />
        <span>Select a channel to start chatting</span>
      </div>
    );
  }

  return (
    <div
      className="flex flex-col h-full transition-[padding] duration-200"
      style={{ paddingRight: reservedRight }}
    >
      {/* Channel header — `relative z-30` lifts the header's stacking context (it
          already makes one via backdrop-blur) above the message list, so header
          dropdowns like the session panel render over the chat, not under it. */}
      <div className="relative z-30 flex items-center gap-3 max-md:gap-1 px-4 max-md:px-2 h-12 border-b border-zinc-800 bg-zinc-950/80 backdrop-blur-sm flex-shrink-0">
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
            <span className="text-xs text-zinc-500 truncate">
              {channel.purpose}
            </span>
          </div>
        )}
        <div className="flex-1" />
        <div className="hidden md:flex items-center gap-3 text-xs text-zinc-500">
          {onlineCount > 0 && (
            <span className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
              {onlineCount} online
            </span>
          )}
          {/* Members: was a dead-looking span — now a real button opening the roster. */}
          <div className="relative" data-members-root>
            <button
              type="button"
              onClick={() => setMembersOpen((v) => !v)}
              title="Channel members"
              className={`flex items-center gap-1.5 rounded px-1.5 py-1 hover:text-zinc-100 hover:bg-zinc-800 transition-colors ${
                membersOpen ? "text-zinc-100 bg-zinc-800" : ""
              }`}
            >
              <Users className="w-3.5 h-3.5" />
              {mentionables.length || "Members"}
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
            setFilesOpen(true);
          }}
          title="Channel files"
          className="flex items-center justify-center w-7 h-7 max-md:w-10 max-md:h-10 rounded text-zinc-500 hover:text-zinc-100 hover:bg-zinc-800 flex-shrink-0"
        >
          <Paperclip className="w-4 h-4" />
        </button>
        <button
          onClick={() => {
            setWsInit({});
            setWsOpen(true);
          }}
          title="Remote workspace"
          className="flex items-center justify-center w-7 h-7 max-md:w-10 max-md:h-10 rounded text-zinc-500 hover:text-zinc-100 hover:bg-zinc-800 flex-shrink-0"
        >
          <FolderTree className="w-4 h-4" />
        </button>
        <button
          onClick={() => setVbOpen((v) => !v)}
          title="ViewBoard — live plan / cost / sessions / audit (instrument plane)"
          className={`flex items-center justify-center w-7 h-7 max-md:w-10 max-md:h-10 rounded hover:bg-zinc-800 flex-shrink-0 ${
            vbOpen ? "text-zinc-100 bg-zinc-800" : "text-zinc-500 hover:text-zinc-100"
          }`}
        >
          <LayoutDashboard className="w-4 h-4" />
        </button>
        <button
          onClick={() => {
            setWbTarget(undefined);
            setWbOpen(true);
          }}
          title="Workbench — file workspace"
          className="flex items-center justify-center w-7 h-7 max-md:w-10 max-md:h-10 rounded text-zinc-500 hover:text-zinc-100 hover:bg-zinc-800 flex-shrink-0"
        >
          <PanelRight className="w-4 h-4" />
        </button>
        {channel.type !== "dm" && (
          <button
            onClick={() => setSettingsOpen(true)}
            title="Channel settings"
            className="flex items-center justify-center w-7 h-7 max-md:w-10 max-md:h-10 rounded text-zinc-500 hover:text-zinc-100 hover:bg-zinc-800 flex-shrink-0"
          >
            <Settings className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Messages */}
      {loading ? (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="w-5 h-5 text-zinc-600 animate-spin" />
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
          />
        </ResolveRefContext.Provider>
      )}

      {/* Multi-select toolbar — replaces nothing, floats above the composer. */}
      {selectMode && (
        <div className="flex items-center gap-2 px-4 py-2 border-t border-zinc-800 bg-zinc-900/80 text-xs">
          <span className="text-zinc-300 font-medium">
            {selectedIds.size} selected
          </span>
          <span className="text-zinc-600">· click messages to toggle</span>
          <div className="flex-1" />
          <button
            type="button"
            disabled={selectedIds.size === 0}
            onClick={() => void copySelected()}
            className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 px-2.5 py-1 text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
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
            className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 px-2.5 py-1 text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
          >
            <Forward className="w-3.5 h-3.5" />
            Forward
          </button>
          <button
            type="button"
            onClick={clearSelection}
            className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-zinc-500 hover:text-zinc-200"
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
          <span className="text-zinc-500 flex-shrink-0">Replying to</span>
          <span className="text-zinc-300 font-medium flex-shrink-0">{displayName(replyTo)}</span>
          <span className="text-zinc-600 truncate italic">
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
        toolbar={
          <>
            <SessionSwitcher
              channelId={channel.channel_id}
              bots={switcherBots}
              value={selectedSessionId}
              onChange={setSelectedSessionId}
            />
            {/* Settings for the @mentioned bot(s); with no live mention, fall
                back to the channel's bots so the controls are always reachable
                (each bot's row self-hides when it advertises nothing). */}
            <ComposerBotSettings
              channelId={channel.channel_id}
              bots={
                mentionedBots.length > 0
                  ? mentionedBots.map((m) => ({ botId: m.id, name: m.label }))
                  : switcherBots
              }
              selectedSessionId={selectedSessionId}
            />
          </>
        }
        onMentionsChange={setMentionedBots}
        onSend={handleSend}
      />

      <WorkbenchDrawer
        open={wbOpen}
        onClose={() => setWbOpen(false)}
        channelId={channel.channel_id}
        sendResourceReq={sendResourceReq}
        openFilePath={wbTarget}
        filesTick={boardTick.files}
      />

      <ViewBoardDrawer
        open={vbOpen}
        onClose={() => setVbOpen(false)}
        channelId={channel.channel_id}
        sendResourceReq={sendResourceReq}
        selectedSessionId={selectedSessionId}
        boardTick={boardTick}
        shiftedForWorkbench={wbOpen}
        minimal={vbMinimal}
        onToggleMinimal={() => setVbMinimal((m) => !m)}
      />
      {filesOpen && (
        <ChannelFilesDialog
          channelId={channel.channel_id}
          onClose={() => setFilesOpen(false)}
          focusFileId={filesFocus}
        />
      )}
      {settingsOpen && (
        <ChannelSettingsDialog channel={channel} onClose={() => setSettingsOpen(false)} />
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
      {wsOpen && (
        <RemoteWorkspaceDialog
          channelId={channel.channel_id}
          onClose={() => setWsOpen(false)}
          initialBotId={wsInit.botId}
          initialPath={wsInit.path}
          // Default the browse to the composer's active session ("" = Auto → no
          // session scope → the dialog shows the bot's full allowed roots).
          sessionId={selectedSessionId || undefined}
          // "workspace" board tick (agent finished a turn) → the dialog refetches
          // its current dir + a clean open file. See onBoardSignal → boardTick above.
          workspaceTick={boardTick.workspace}
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
      )}
    </div>
  );
}
