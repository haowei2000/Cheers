/**
 * Generic WebSocket reconnect client with exponential backoff and jitter.
 *
 * Behavior:
 *   - After connection failure or abnormal close, backs off by base*(2^n)
 *     with 50%-100% jitter and a maximum cap.
 *   - Certain close codes (4401 auth failure / 4403 bot unavailable) are fatal.
 *   - Resets the retry counter after the connection stays healthy for a while
 *     (30s by default).
 */
import WebSocket from "ws";

import {
  WS_CLOSE_AUTH_FAIL,
  WS_CLOSE_BOT_UNAVAILABLE,
  WS_CLOSE_SUPERSEDED,
} from "./types.js";

export interface ReconnectOptions {
  baseMs: number;
  maxMs: number;
  /** How long a connection must stay healthy before the retry counter resets. */
  resetAfterMs: number;
}

export interface ReconnectingClientCallbacks {
  /** Called after the connection opens and before the first frame. */
  onOpen: (ws: WebSocket) => void | Promise<void>;
  /** Called for each received JSON frame. */
  onFrame: (frame: unknown) => void | Promise<void>;
  /** Called on normal close; reconnect will be scheduled afterward. */
  onClose: (code: number, reason: string) => void;
  /** Called on fatal errors that terminate the reconnect loop. */
  onFatal: (reason: string) => void;
}

/** Return whether a close code is fatal and should not reconnect.
 *
 *  - 4401 (auth fail): token is invalid or rotated, so immediate reconnects
 *    would only be rejected again.
 *  - 4402 (superseded): another connection with the same token took over; an
 *    automatic reconnect would kick it offline and create a ping-pong loop.
 *  - 4403 (bot unavailable): bot.status != online and needs manual intervention.
 */
export function isFatalCloseCode(code: number): boolean {
  return (
    code === WS_CLOSE_AUTH_FAIL ||
    code === WS_CLOSE_BOT_UNAVAILABLE ||
    code === WS_CLOSE_SUPERSEDED
  );
}

export function computeBackoff(attempt: number, opts: ReconnectOptions): number {
  const exp = opts.baseMs * Math.pow(2, Math.max(0, attempt - 1));
  const capped = Math.min(exp, opts.maxMs);
  // Jitter 50-100%
  return capped * (0.5 + Math.random() * 0.5);
}

export class ReconnectingClient {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private resetTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>,
    private readonly opts: ReconnectOptions,
    private readonly callbacks: ReconnectingClientCallbacks,
  ) {}

  start(): void {
    if (this.stopped) throw new Error("client has been stopped");
    void this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.resetTimer) clearTimeout(this.resetTimer);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.close(1000, "plugin stopping");
      } catch {
        /* ignore */
      }
    }
  }

  reconnectNow(reason = "client requested reconnect"): void {
    if (this.stopped) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      try {
        this.ws.close(1011, reason);
      } catch {
        this.scheduleReconnect();
      }
      return;
    }
    if (!this.reconnectTimer) {
      this.scheduleReconnect();
    }
  }

  send(frame: unknown): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const ws = new WebSocket(this.url, { headers: this.headers });
    this.ws = ws;

    ws.on("open", () => {
      // Reset attempts after the connection stays healthy for resetAfterMs.
      this.resetTimer = setTimeout(() => {
        this.attempt = 0;
      }, this.opts.resetAfterMs);
      void this.callbacks.onOpen(ws);
    });

    ws.on("message", (raw) => {
      let frame: unknown;
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        return; // ignore non-JSON
      }
      void this.callbacks.onFrame(frame);
    });

    ws.on("close", (code, reasonBuf) => {
      if (this.resetTimer) {
        clearTimeout(this.resetTimer);
        this.resetTimer = null;
      }
      const reason = reasonBuf?.toString() ?? "";
      this.callbacks.onClose(code, reason);

      if (this.stopped) return;
      if (isFatalCloseCode(code)) {
        this.callbacks.onFatal(`ws closed with fatal code=${code} reason=${reason}`);
        return;
      }
      this.scheduleReconnect();
    });

    ws.on("error", (_err) => {
      // The 'close' event follows shortly; no action is needed here.
    });
  }

  private scheduleReconnect(): void {
    this.attempt += 1;
    const delay = computeBackoff(this.attempt, this.opts);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }
}
