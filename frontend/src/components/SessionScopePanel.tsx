import { useEffect, useState } from "react";
import { apiFetch } from "../api";
import type { AgentBridgeSession } from "../types";

type ScopeType = "channel" | "topic" | "task";

function fmtTime(value?: string | null): string {
  if (!value) return "-";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function scopeLabel(type: string, id: string): string {
  if (type === "channel") return `频道 · ${id}`;
  if (type === "topic") return `主题 · ${id}`;
  if (type === "task") return `任务 · ${id}`;
  if (type === "dm") return `私聊 · ${id}`;
  return `${type} · ${id}`;
}

function shortKey(value: string): string {
  if (!value) return "-";
  if (value.length <= 34) return value;
  return `${value.slice(0, 18)}…${value.slice(-12)}`;
}

function statusLabel(status: string): string {
  if (status === "task_owned") return "Task 接管";
  if (status === "active") return "Active";
  if (status === "closed") return "Closed";
  return status || "-";
}

export function SessionList({ sessions }: { sessions: AgentBridgeSession[] }) {
  if (sessions.length === 0) {
    return (
      <div className="text-xs" style={{ color: "var(--fg-3)" }}>
        暂无 Agent Bridge session。
      </div>
    );
  }
  return (
    <div className="grid gap-2">
      {sessions.map((s) => (
        <div
          key={s.session_id}
          className="rounded-md border p-3 text-xs"
          style={{ borderColor: "var(--border)", background: "var(--surface-soft)" }}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="font-semibold truncate" style={{ color: "var(--fg-1)" }}>
                {s.bot_display_name || s.bot_username || s.bot_id}
              </div>
              <div className="mt-1 font-mono break-all" style={{ color: "var(--fg-3)" }}>
                {shortKey(s.provider_session_key)}
              </div>
            </div>
            <span
              className="rounded px-2 py-0.5 whitespace-nowrap"
              style={{
                background: s.status === "task_owned" ? "var(--accent-muted)" : "var(--green-muted)",
                color: s.status === "task_owned" ? "var(--accent)" : "var(--green)",
              }}
            >
              {statusLabel(s.status)}
            </span>
          </div>
          <div className="mt-2 grid gap-1 sm:grid-cols-2" style={{ color: "var(--fg-2)" }}>
            <div>Provider：{s.provider} / {s.provider_agent_id}</div>
            <div>Account：{s.provider_account_id}</div>
            <div>当前 scope：{scopeLabel(s.current_scope_type, s.current_scope_id)}</div>
            <div>最后使用：{fmtTime(s.last_used_at)}</div>
          </div>
          {s.bindings.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {s.bindings.map((b) => (
                <span
                  key={b.binding_id}
                  className="rounded border px-1.5 py-0.5 font-mono"
                  style={{ borderColor: "var(--border)", color: "var(--fg-3)" }}
                  title={b.scope_id}
                >
                  {b.role}:{b.scope_type}
                </span>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export function SessionScopePanel({
  scopeType,
  scopeId,
  channelId,
  botId,
  title = "对应 Session",
}: {
  scopeType: ScopeType;
  scopeId: string;
  channelId: string;
  botId?: string | null;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [sessions, setSessions] = useState<AgentBridgeSession[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    if (!scopeId || !channelId) {
      setSessions([]);
      return;
    }
    const params = new URLSearchParams({
      scope_type: scopeType,
      scope_id: scopeId,
      channel_id: channelId,
    });
    if (botId) params.set("bot_id", botId);
    setLoading(true);
    setError(null);
    apiFetch(`/agent-bridge/sessions/scope?${params.toString()}`)
      .then((r) => r.json())
      .then((d) => {
        if (!active) return;
        setSessions(Array.isArray(d?.data) ? d.data : []);
      })
      .catch((e: unknown) => {
        if (!active) return;
        setError((e as Error).message || "加载 session 失败");
        setSessions([]);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [botId, channelId, scopeId, scopeType]);

  return (
    <div className="border-b px-4 py-2" style={{ borderColor: "var(--border)", background: "var(--bg-0)" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 text-left"
      >
        <span className="text-xs font-semibold" style={{ color: "var(--fg-2)" }}>
          {title}
        </span>
        <span className="text-xs" style={{ color: "var(--fg-3)" }}>
          {loading ? "加载中" : `${sessions.length} 个 active session`} · {open ? "收起" : "展开"}
        </span>
      </button>
      {open && (
        <div className="mt-2">
          {error ? (
            <div className="text-xs" style={{ color: "var(--red)" }}>{error}</div>
          ) : (
            <SessionList sessions={sessions} />
          )}
        </div>
      )}
    </div>
  );
}

export function BotSessionsPanel({
  botId,
  authToken,
}: {
  botId: string;
  authToken?: string | null;
}) {
  const [sessions, setSessions] = useState<AgentBridgeSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    apiFetch(`/bots/${botId}/sessions`, { token: authToken })
      .then((r) => r.json())
      .then((d) => {
        if (!active) return;
        setSessions(Array.isArray(d?.data) ? d.data : []);
      })
      .catch((e: unknown) => {
        if (!active) return;
        setError((e as Error).message || "加载 session 失败");
        setSessions([]);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [authToken, botId]);

  return (
    <div className="an-row-card" style={{ flexDirection: "column", alignItems: "stretch", gap: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <div>
          <div className="an-rc-title">Active Sessions</div>
          <div className="an-rc-sub">该 Bot 当前可复用的 Agent Bridge provider session</div>
        </div>
        <div className="an-rc-sub">{loading ? "加载中…" : `${sessions.length} 个`}</div>
      </div>
      {error ? (
        <div className="an-rc-sub" style={{ color: "var(--red)" }}>{error}</div>
      ) : (
        <SessionList sessions={sessions} />
      )}
    </div>
  );
}
