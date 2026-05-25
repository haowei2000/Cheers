import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export class JsonRpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = "JsonRpcError";
  }
}

export class JsonRpcRequestTimeoutError extends Error {
  constructor(
    public readonly method: string,
    public readonly timeoutMs: number,
  ) {
    super(`ACP request timed out after ${timeoutMs}ms: ${method}`);
    this.name = "JsonRpcRequestTimeoutError";
  }
}

type JsonRpcId = string | number | null;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

export interface StdioPeerOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  requestTimeoutMs?: number;
  onNotification?: (method: string, params: unknown) => void | Promise<void>;
  onRequest?: (method: string, params: unknown) => unknown | Promise<unknown>;
  onStderr?: (line: string) => void;
}

export class JsonRpcStdioPeer {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<JsonRpcId, Pending>();
  private closed = false;
  private requestTimeoutMs: number;

  constructor(private readonly opts: StdioPeerOptions) {
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 120_000;
  }

  start(): void {
    if (this.child) return;
    this.child = spawn(this.opts.command, this.opts.args ?? [], {
      cwd: this.opts.cwd,
      env: { ...process.env, ...(this.opts.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.on("close", (code, signal) => {
      this.closed = true;
      const err = new Error(`ACP agent exited code=${code ?? "null"} signal=${signal ?? "null"}`);
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(err);
      }
      this.pending.clear();
    });
    this.child.on("error", (err) => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(err);
      }
      this.pending.clear();
    });

    createInterface({ input: this.child.stdout }).on("line", (line) => {
      void this.handleLine(line);
    });
    createInterface({ input: this.child.stderr }).on("line", (line) => {
      this.opts.onStderr?.(line);
    });
  }

  async stop(): Promise<void> {
    if (!this.child || this.closed) return;
    const child = this.child;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        resolve();
      }, 1500);
      child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs = this.requestTimeoutMs): Promise<T> {
    if (!this.child || this.closed) {
      return Promise.reject(new Error("ACP agent process is not running"));
    }
    const id = this.nextId++;
    const frame = { jsonrpc: "2.0", id, method, params };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new JsonRpcRequestTimeoutError(method, timeoutMs));
      }, timeoutMs);
      this.pending.set(id, { resolve: (v) => resolve(v as T), reject, timer });
      this.write(frame);
    });
  }

  setRequestTimeoutMs(timeoutMs: number): void {
    this.requestTimeoutMs = timeoutMs;
  }

  notify(method: string, params?: unknown): void {
    if (!this.child || this.closed) return;
    this.write({ jsonrpc: "2.0", method, params });
  }

  private write(frame: unknown): void {
    this.child?.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  private async handleLine(line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) return;
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return;
    }

    if ("id" in frame && ("result" in frame || "error" in frame)) {
      const id = frame.id as JsonRpcId;
      const pending = this.pending.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      if (frame.error && typeof frame.error === "object") {
        const err = frame.error as { code?: number; message?: string; data?: unknown };
        pending.reject(new JsonRpcError(err.code ?? -32000, err.message ?? "JSON-RPC error", err.data));
      } else {
        pending.resolve(frame.result);
      }
      return;
    }

    if (typeof frame.method !== "string") return;
    if ("id" in frame) {
      await this.handleRequest(frame.id as JsonRpcId, frame.method, frame.params);
    } else {
      await this.opts.onNotification?.(frame.method, frame.params);
    }
  }

  private async handleRequest(id: JsonRpcId, method: string, params: unknown): Promise<void> {
    try {
      if (!this.opts.onRequest) {
        throw new JsonRpcError(-32601, `Method not found: ${method}`);
      }
      const result = await this.opts.onRequest(method, params);
      this.write({ jsonrpc: "2.0", id, result });
    } catch (err) {
      const rpcErr = err instanceof JsonRpcError
        ? err
        : new JsonRpcError(-32603, err instanceof Error ? err.message : String(err));
      this.write({
        jsonrpc: "2.0",
        id,
        error: { code: rpcErr.code, message: rpcErr.message, data: rpcErr.data },
      });
    }
  }
}
