/**
 * WS 指数退避 + jitter 的通用重连器。
 *
 * 行为：
 *   - 连接失败或异常关闭后，按 base*(2^n) 退避，叠加 50%-100% jitter，上限 max
 *   - 某些 close code（4401 鉴权失败 / 4403 bot 不可用）视为致命，不重连
 *   - connect 成功一段时间（默认 30s）后重置重试计数器
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
  /** connect 后稳定运行多久视为"这次连接成功"，重置重试计数 */
  resetAfterMs: number;
}

export interface ReconnectingClientCallbacks {
  /** 成功建连时调用（accept 之后、首帧前） */
  onOpen: (ws: WebSocket) => void | Promise<void>;
  /** 收到任一 JSON 帧时调用 */
  onFrame: (frame: unknown) => void | Promise<void>;
  /** 正常断开（后续会 schedule 重连） */
  onClose: (code: number, reason: string) => void;
  /** 致命错误，循环终止 */
  onFatal: (reason: string) => void;
}

/** 判断 close code 是否致命：不应再重连。
 *
 *  - 4401 (auth fail)：token 无效 / 已轮换 —— 立刻重连只会继续被拒
 *  - 4402 (superseded)：另一个连接用同 token 接管了我们；自动重连会把对方也踢
 *    下线，造成 ping-pong 死循环
 *  - 4403 (bot unavailable)：bot.status != online，需要人为介入
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
      // 连接稳定 resetAfterMs 后，认为 attempt 可以重置
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
      // 'close' 会紧随而来；这里不做动作
    });
  }

  private scheduleReconnect(): void {
    this.attempt += 1;
    const delay = computeBackoff(this.attempt, this.opts);
    this.reconnectTimer = setTimeout(() => {
      void this.connect();
    }, delay);
  }
}
