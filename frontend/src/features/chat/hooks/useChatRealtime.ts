import { useEffect, useRef, useCallback, useState } from "react";
import { buildWsUrl } from "@/api/client";
import { useAuthStore } from "@/stores/authStore";
import type { Message, VoiceTranscriptSegment, WsEvent } from "@/types";

/** Live-connection state for the open channel, driving the tier-M banner:
 *  connecting → first attempt (no banner; the channel is still loading anyway),
 *  online → subscribed, reconnecting → dropped and retrying with backoff,
 *  offline → retry budget exhausted (manual `reconnectNow` is the exit). */
export type RealtimeStatus = "connecting" | "online" | "reconnecting" | "offline";

/** Workspace-presence entry inside a `presence` frame: WHO is currently viewing
 *  WHICH bot's workspace, and at what `path` (a file, else a directory/cwd). */
export interface PresenceFocus {
  user_id: string;
  bot_id: string;
  path?: string | null;
}

interface Callbacks {
  onMessage: (msg: Message) => void;
  onStreamDelta: (msgId: string, delta: string) => void;
  onStreamDone: (msg: Partial<Message> & { msg_id: string }) => void;
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
  /** Agent progress (trace) for a streaming bot message. */
  onBotTrace?: (msgId: string | null, title: string | null) => void;
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

const BASE_DELAY = 1000;
const MAX_DELAY = 30000;
const MAX_RETRIES = 10;
/** How long an idle (no subscriber) socket is kept alive before closing — long
 *  enough to survive a channel switch or a brief navigation away from chat. */
const IDLE_CLOSE_DELAY = 30000;

// ── Resource req/res over the same channel socket (workbench fs/channel access) ──

const RESOURCE_REQ_TIMEOUT = 15000;

/** Result payload of a resource_req on success (handler `data`). */
export type ResourceData = unknown;

/** Thrown when a resource_req fails (rejected by dispatch_user or transport). */
export class ResourceError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ResourceError";
    this.code = code;
  }
}

interface ResourceRes {
  ok: boolean;
  data?: unknown;
  code?: string;
  error?: string;
}

interface PendingReq {
  resolve: (data: ResourceData) => void;
  reject: (err: ResourceError) => void;
  timer: ReturnType<typeof setTimeout>;
}

// Backend browser WS protocol:
//   1. Connect to /ws
//   2. Client → {"type":"auth","token":"..."}
//   3. Server → {"type":"auth_ok","user_id":"..."}
//   4. Client → {"type":"subscribe","channel_id":"..."}
//   5. Server → {"type":"subscribed","channel_id":"..."}
//   6. Broadcast frames arrive tagged with channel_id
//
// The socket is a MODULE-LEVEL SINGLETON shared across channel switches
// (Discord-style): switching channels sends unsubscribe(old) + subscribe(new)
// on the live connection instead of tearing it down and paying a fresh
// TCP/TLS/WS + auth handshake per switch. Only one ChannelView mounts at a
// time, so a single active subscription is all the state we need.

/** The one mounted channel subscriber (ChannelView's realtime hook instance). */
interface ActiveSub {
  channelId: string;
  cbs: React.MutableRefObject<Callbacks>;
  setStatus: (s: RealtimeStatus) => void;
}

let ws: WebSocket | null = null;
let wsToken: string | null = null;
let authed = false;
let retryCount = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let active: ActiveSub | null = null;
// The server rejected our token (auth_err): reconnecting with the same token
// would just loop, so stop; the session-expired takeover is the exit.
let authFailed = false;
const pendingReqs = new Map<string, PendingReq>();

function rejectAllPending(err: ResourceError) {
  for (const p of pendingReqs.values()) {
    clearTimeout(p.timer);
    p.reject(err);
  }
  pendingReqs.clear();
}

function clearRetryTimer() {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

function closeSocket() {
  clearRetryTimer();
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  const s = ws;
  ws = null;
  authed = false;
  if (s) {
    // Detach handlers so the close doesn't schedule a reconnect.
    s.onclose = null;
    s.onerror = null;
    s.onmessage = null;
    s.onopen = null;
    try {
      s.close();
    } catch {
      /* already closed */
    }
  }
  rejectAllPending(new ResourceError("DISCONNECTED", "socket closed"));
}

function sendFrame(frame: Record<string, unknown>): boolean {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(frame));
  return true;
}

function subscribeActive() {
  if (active && authed) {
    sendFrame({ type: "subscribe", channel_id: active.channelId });
  }
}

function handleFrame(event: WsEvent & { channel_id?: string }) {
  // Resource req/res correlation (workbench fs/channel access over this socket).
  if ((event as { type?: string }).type === "resource_res") {
    const res = event as unknown as ResourceRes & { req_id?: string };
    const pending = res.req_id ? pendingReqs.get(res.req_id) : undefined;
    if (pending && res.req_id) {
      pendingReqs.delete(res.req_id);
      clearTimeout(pending.timer);
      if (res.ok) pending.resolve(res.data);
      else
        pending.reject(
          new ResourceError(res.code ?? "ERROR", res.error ?? "resource error")
        );
    }
    return;
  }

  const { type, data } = event;

  // Protocol control frames — handle then return
  if (type === "auth_ok") {
    authed = true;
    retryCount = 0;
    subscribeActive();
    return;
  }
  if (type === "auth_err") {
    // Dead token → tier L: flip the global session-expired takeover and stop
    // the reconnect loop (retrying with the same token can never succeed).
    authFailed = true;
    useAuthStore.getState().markSessionExpired();
    ws?.close();
    return;
  }
  if (type === "subscribed") {
    // Only the ack for the CURRENT channel flips us online — a stale ack from a
    // channel we already left (switch mid-handshake) must not fire onReady.
    if (active && event.channel_id === active.channelId) {
      active.setStatus("online");
      // (Re)subscribe ack — trigger REST since-seq catch-up to heal any gap
      // from a dropped connection (write-before-deliver self-heal).
      active.cbs.current.onReady?.();
    }
    return;
  }
  if (type === "unsubscribed" || type === "pong") {
    return;
  }

  // Broadcast frames — drop anything for a channel we're no longer viewing
  // (frames can still arrive between our unsubscribe and the server ack).
  if (!active) return;
  if (event.channel_id && event.channel_id !== active.channelId) return;
  const cbs = active.cbs.current;

  if (type === "message") {
    cbs.onMessage(data as unknown as Message);
    // A new message advances the channel's activity stream → nudge the board.
    cbs.onBoardSignal?.("activity");
  } else if (type === "message_stream") {
    const d = data as { msg_id: string; delta: string };
    cbs.onStreamDelta(d.msg_id, d.delta ?? "");
  } else if (type === "message_done") {
    cbs.onStreamDone(data as unknown as Partial<Message> & { msg_id: string });
  } else if (type === "message_deleted") {
    cbs.onMessageDeleted((data as { msg_id: string }).msg_id);
  } else if (type === "bot_processing") {
    cbs.onBotProcessing?.((data as { bot_id: string }).bot_id);
  } else if (type === "bot_unavailable") {
    const d = data as { bot_id: string; placeholder_msg_id: string };
    cbs.onBotUnavailable?.(d.bot_id, d.placeholder_msg_id);
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
    const d = data as {
      msg_id?: string | null;
      title?: string | null;
      status?: string | null;
    };
    cbs.onBotTrace?.(d.msg_id ?? null, d.title ?? d.status ?? null);
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

/** Open (or reuse) the singleton socket for `token`. No-op while a healthy
 *  socket for the same token is open or connecting. */
function ensureSocket(token: string) {
  if (authFailed && wsToken === token) return;
  if (
    ws &&
    wsToken === token &&
    (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }
  closeSocket();
  wsToken = token;
  authFailed = false;

  const socket = new WebSocket(buildWsUrl("/ws"));
  ws = socket;
  authed = false;

  socket.onopen = () => {
    // Phase 1: authenticate
    socket.send(JSON.stringify({ type: "auth", token }));
  };

  socket.onmessage = (ev) => {
    let event: WsEvent & { channel_id?: string };
    try {
      event = JSON.parse(ev.data as string) as WsEvent & { channel_id?: string };
    } catch {
      return;
    }
    handleFrame(event);
  };

  socket.onclose = () => {
    if (ws !== socket) return; // superseded by a newer socket
    ws = null;
    authed = false;
    // Reject any in-flight resource requests bound to this socket.
    rejectAllPending(new ResourceError("DISCONNECTED", "socket closed"));
    if (authFailed) return;
    // No subscriber → reconnect lazily on the next attach instead of burning
    // the retry budget while nobody is looking at a channel.
    if (!active) return;
    if (retryCount >= MAX_RETRIES) {
      active.setStatus("offline");
      return;
    }
    active.setStatus("reconnecting");
    const delay = Math.min(BASE_DELAY * 2 ** retryCount, MAX_DELAY);
    retryCount += 1;
    retryTimer = setTimeout(() => {
      if (wsToken) ensureSocket(wsToken);
    }, delay);
  };

  socket.onerror = () => {
    socket.close();
  };
}

/** Mount a channel subscription on the shared socket. Reuses a live authed
 *  socket by just swapping subscriptions; otherwise (re)connects. */
function attach(sub: ActiveSub, token: string) {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  const prev = active;
  active = sub;
  if (wsToken !== token) {
    // Token changed (re-login) — the old socket's auth is stale.
    authFailed = false;
    ensureSocket(token);
    return;
  }
  if (ws && ws.readyState === WebSocket.OPEN && authed) {
    if (prev && prev.channelId !== sub.channelId) {
      sendFrame({ type: "unsubscribe", channel_id: prev.channelId });
    }
    sendFrame({ type: "subscribe", channel_id: sub.channelId });
    return;
  }
  // Socket connecting / mid-auth: auth_ok will subscribe the active channel.
  // Socket dead: reconnect (a pending backoff timer keeps its own schedule).
  if (!ws && !retryTimer) ensureSocket(token);
}

/** Unmount the channel subscription. The socket is kept warm for a grace
 *  period so a channel switch (detach→attach) never pays a reconnect. */
function detach(sub: ActiveSub) {
  if (active !== sub) return; // superseded by a newer attach
  sendFrame({ type: "unsubscribe", channel_id: sub.channelId });
  active = null;
  clearRetryTimer();
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (!active) closeSocket();
  }, IDLE_CLOSE_DELAY);
}

export function useChatRealtime(channelId: string | null, cbs: Callbacks) {
  const token = useAuthStore((s) => s.token);
  const cbsRef = useRef(cbs);
  cbsRef.current = cbs;
  const [status, setStatus] = useState<RealtimeStatus>("connecting");

  // Recovery: the exponential-backoff loop caps out after MAX_RETRIES (~2.5min),
  // which after a laptop sleep or a network blip would otherwise leave the channel
  // silently frozen forever. Coming back online, refocusing the tab, or the
  // banner's "Retry now" is the escape hatch — reset the retry budget and
  // reconnect now if the socket has died.
  const reconnectNow = useCallback(() => {
    if (authFailed || !token) return;
    if (ws && ws.readyState !== WebSocket.CLOSED) return; // already up or mid-connect
    clearRetryTimer();
    retryCount = 0;
    if (channelId) setStatus("reconnecting");
    ensureSocket(token);
  }, [token, channelId]);

  useEffect(() => {
    if (!channelId || !token) return;
    setStatus("connecting"); // fresh subscription — don't carry a stale banner across channels
    const sub: ActiveSub = { channelId, cbs: cbsRef, setStatus };
    attach(sub, token);

    const revive = () => {
      if (document.visibilityState === "hidden") return;
      reconnectNow();
    };
    window.addEventListener("online", revive);
    document.addEventListener("visibilitychange", revive);

    return () => {
      window.removeEventListener("online", revive);
      document.removeEventListener("visibilitychange", revive);
      detach(sub);
    };
  }, [channelId, token, reconnectNow]);

  // Logout: the token is gone — a still-authed idle socket must not linger.
  useEffect(() => {
    if (!token) closeSocket();
  }, [token]);

  // Imperative resource client: send a resource_req on the live channel socket and
  // resolve when the matching resource_res (by req_id) returns. Used by the workbench
  // (File/Context plugins) to read/write the channel workspace fs.
  const sendResourceReq = useCallback(
    (resource: string, params: Record<string, unknown>): Promise<ResourceData> => {
      return new Promise<ResourceData>((resolve, reject) => {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          reject(new ResourceError("DISCONNECTED", "socket not connected"));
          return;
        }
        const reqId = crypto.randomUUID();
        const timer = setTimeout(() => {
          pendingReqs.delete(reqId);
          reject(new ResourceError("TIMEOUT", "resource request timed out"));
        }, RESOURCE_REQ_TIMEOUT);
        pendingReqs.set(reqId, { resolve, reject, timer });
        sendFrame({ type: "resource_req", req_id: reqId, resource, params });
      });
    },
    []
  );

  // Broadcast the caller's workspace focus (which bot's workspace / which path they're
  // viewing) so peers see it in the next `presence` snapshot. `focus === null` clears it
  // (dialog closed / bot switched). Best-effort: a no-op if the socket isn't open —
  // the gateway re-derives presence on the next (re)subscribe anyway.
  const sendPresenceFocus = useCallback(
    (chanId: string, focus: { bot_id: string; path?: string | null } | null) => {
      sendFrame({ type: "presence_focus", channel_id: chanId, focus });
    },
    []
  );

  return { sendResourceReq, sendPresenceFocus, status, reconnectNow };
}
