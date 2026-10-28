import { useEffect, useRef, useCallback, useState } from "react";
import { useAuthStore } from "@/stores/authStore";
import { clientSessionGeneration } from "@/lib/clientSession";
import type { Message, TraceEvent, VoiceTranscriptSegment } from "@/types";
import { normalizeTraceEvent } from "../traceEvent";
import { claimConfirmationUpdate } from "../taskClaimProjection";
import { realtimeTransport, sendResourceRequest, type RealtimeFrame, type RealtimeStatus } from "@/lib/realtimeTransport";

export type { RealtimeStatus } from "@/lib/realtimeTransport";

/** Workspace-presence entry inside a `presence` frame: WHO is currently viewing
 *  WHICH bot's workspace, and at what `path` (a file, else a directory/cwd). */
export interface PresenceFocus {
  user_id: string;
  bot_id: string;
  path?: string | null;
}

interface Callbacks {
  onMessage: (msg: Message) => void;
  onStreamDelta: (msgId: string, delta: string, senderId?: string) => void;
  onStreamDone: (msg: Partial<Message> & { msg_id: string }) => void;
  onContentDataUpdated?: (msgId: string, contentData: Message["content_data"]) => void;
  onMessageDeleted: (msgId: string) => void;
  onBotProcessing?: (botId: string) => void;
  /** A mentioned bot could not accept the task. The transient placeholder was
   * removed server-side, so clients should remove it locally and surface a toast. */
  onBotUnavailable?: (botId: string, placeholderMsgId: string) => void;
  /** Fired after every (re)subscribe ack — used to run REST seq catch-up. */
  onReady?: () => void;
  /** Channel presence update (online user ids + count + online bot ids).
   *  `count` already includes online bots — don't add `botIds.length` to it.
   *  `focus` (workspace presence) may be absent on older gateways → empty array. */
  onPresence?: (
    userIds: string[],
    count: number,
    botIds?: string[],
    focus?: PresenceFocus[]
  ) => void;
  /** Canonical agent lifecycle event for a streaming bot message. */
  onBotTrace?: (event: TraceEvent) => void;
  /** ViewBoard live-push: a board's underlying data changed → re-pull that board.
   *  `board` is e.g. "plan" | "cost" | "commands" (gateway board_signal) or
   *  "activity" (synthesized here on each new message). `botId` is the emitting
   *  bot when the frame carries one (the "workspace" turn-complete tick does),
   *  letting bot-scoped consumers ignore other bots' ticks; null when absent. */
  onBoardSignal?: (board: string, botId?: string | null) => void;
  /** Live-watch: the agent changed file(s) under a watched dir on ITS machine.
   *  Carries `bot_id` (route by it — a channel can have several bots on different
   *  machines), the workspace `root`, and the changed `paths`. Recipients re-fetch
   *  through their own authorized workspace REST reads (the frame has no content). */
  onWorkspaceSignal?: (sig: {
    bot_id: string;
    root: string;
    paths: string[];
  }) => void;
  /** An audio file's transcription finished (status "done" with the transcript
   *  snippet) or terminally failed (status "failed") — update its tiles in place. */
  onFileTranscribed?: (
    fileId: string,
    status: string,
    summary: string | null
  ) => void;
  /** A durable final voice transcript segment; interim captions stay in LiveKit. */
  onVoiceTranscriptFinal?: (segment: VoiceTranscriptSegment) => void;
  /** A proactive task claim was created or resolved; refresh the approval tray. */
  onTaskClaimChange?: () => void;
  /** A member edited their profile (name/avatar/bio/status) — patch that member's
   *  card in place so the hovercard reflects it without a channel-switch/reload.
   *  Only the provided fields are meaningful; `member_id` always identifies who. */
  onMemberUpdated?: (member: {
    member_id: string;
    display_name?: string | null;
    avatar_url?: string | null;
    bio?: string | null;
    status_text?: string | null;
    status_emoji?: string | null;
    status_updated_at?: string | null;
  }) => void;
}

/** Channel event interpretation stays with chat; authentication, routing and RPC
 * correlation belong to the app-wide transport. */
export function handleChannelFrame(event: RealtimeFrame, cbs: Callbacks) {
  const { type, data } = event;

  if (type === "message") {
    cbs.onMessage(data as unknown as Message);
    // A new message advances the channel's activity stream → nudge the board.
    cbs.onBoardSignal?.("activity");
  } else if (type === "message_stream") {
    const d = data as { msg_id: string; delta: string; sender_id?: string };
    cbs.onStreamDelta(d.msg_id, d.delta ?? "", d.sender_id);
  } else if (type === "message_done") {
    cbs.onStreamDone(data as unknown as Partial<Message> & { msg_id: string });
  } else if (type === "suggestions_updated" || type === "cards_updated") {
    const update = data as { msg_id: string; content_data: Message["content_data"] };
    cbs.onContentDataUpdated?.(update.msg_id, update.content_data);
  } else if (type === "message_deleted") {
    cbs.onMessageDeleted((data as { msg_id: string }).msg_id);
  } else if (type === "bot_processing") {
    cbs.onBotProcessing?.((data as { bot_id: string }).bot_id);
  } else if (type === "bot_unavailable") {
    const d = data as { bot_id: string; placeholder_msg_id: string };
    cbs.onBotUnavailable?.(d.bot_id, d.placeholder_msg_id);
  } else if (type === "task_claim_created" || type === "task_claim_updated") {
    const confirmation = event.channel_id ? claimConfirmationUpdate(data, event.channel_id) : null;
    if (confirmation) cbs.onContentDataUpdated?.(confirmation.msg_id, confirmation.content_data);
    cbs.onTaskClaimChange?.();
  } else if (type === "presence") {
    const d = data as {
      online_user_ids?: string[];
      online_bot_ids?: string[];
      count?: number;
      focus?: PresenceFocus[];
    };
    // `focus` is new (workspace presence); tolerate its absence on older gateways.
    const focus = Array.isArray(d.focus)
      ? d.focus.filter(
          (f): f is PresenceFocus =>
            !!f && typeof f.user_id === "string" && typeof f.bot_id === "string"
        )
      : [];
    cbs.onPresence?.(
      d.online_user_ids ?? [],
      d.count ?? 0,
      d.online_bot_ids ?? [],
      focus
    );
  } else if (type === "bot_trace") {
    const event = normalizeTraceEvent(data);
    if (event) cbs.onBotTrace?.(event);
  } else if (type === "board_signal") {
    const d = data as { board?: string; bot_id?: string };
    cbs.onBoardSignal?.(d.board ?? "", d.bot_id ?? null);
  } else if (type === "workspace_signal") {
    const d = data as {
      bot_id?: string;
      root?: string;
      paths?: string[];
    };
    if (d.bot_id) {
      cbs.onWorkspaceSignal?.({
        bot_id: d.bot_id,
        root: d.root ?? "",
        paths: Array.isArray(d.paths) ? d.paths : [],
      });
    }
  } else if (type === "file_transcribed") {
    const d = data as {
      file_id?: string;
      status?: string;
      summary?: string | null;
    };
    if (d.file_id) {
      cbs.onFileTranscribed?.(d.file_id, d.status ?? "done", d.summary ?? null);
    }
  } else if (type === "voice_transcript_final") {
    const segment = data as unknown as VoiceTranscriptSegment;
    if (segment.segment_id && typeof segment.channel_seq === "number") {
      cbs.onVoiceTranscriptFinal?.(segment);
    }
  } else if (type === "member_updated") {
    const d = data as { member_id?: string };
    if (d.member_id) {
      cbs.onMemberUpdated?.(
        data as { member_id: string } & Record<string, unknown>
      );
    }
  }
}

export function useChatRealtime(channelId: string | null, cbs: Callbacks) {
  const session = useAuthStore((s) => s.token ? clientSessionGeneration() : null);
  const cbsRef = useRef(cbs);
  cbsRef.current = cbs;
  const [status, setStatus] = useState<RealtimeStatus>("connecting");

  useEffect(() => {
    if (!channelId || session === null) return;
    setStatus("connecting");
    const transport = realtimeTransport();
    const unsubscribe = transport.subscribeChannels([channelId], {
      onFrame: (frame) => handleChannelFrame(frame, cbsRef.current),
      onReady: () => cbsRef.current.onReady?.(),
      onStatus: setStatus,
    });
    return () => {
      // Fleet may retain this channel subscription after chat detaches.
      transport.sendPresenceFocus(channelId, null);
      unsubscribe();
    };
  }, [channelId, session]);

  const reconnectNow = useCallback(() => realtimeTransport().reconnectNow(), []);
  const sendPresenceFocus = useCallback(
    (chanId: string, focus: { bot_id: string; path?: string | null } | null) => {
      realtimeTransport().sendPresenceFocus(chanId, focus);
    }, []
  );
  return { sendResourceReq: sendResourceRequest, sendPresenceFocus, status, reconnectNow };
}
