/**
 * 精简的 PluginRuntime 类型形状（对齐 OpenClaw 2026.4.15 types.d.ts 的 PluginRuntime）。
 * 只声明我们真正使用的 subagent 子集，其他字段保持为 unknown 的 forward-compat 出口。
 */
export interface PluginRuntime {
  subagent: {
    run(params: {
      sessionKey: string;
      message: string;
      provider?: string;
      model?: string;
      extraSystemPrompt?: string;
      lane?: string;
      deliver?: boolean;
      idempotencyKey?: string;
    }): Promise<{ runId: string }>;
    waitForRun(params: { runId: string; timeoutMs?: number }): Promise<{
      status: "ok" | "error" | "timeout";
      error?: string;
    }>;
    getSessionMessages(params: { sessionKey: string; limit?: number }): Promise<{
      messages: unknown[];
    }>;
    deleteSession(params: { sessionKey: string; deleteTranscript?: boolean }): Promise<void>;
  };
  channel?: unknown;
  [k: string]: unknown;
}
