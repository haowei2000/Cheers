import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../api";
import type { AgentBridgeSession } from "../types";
import { AppIcon } from "./icons/AppIcon";

type ScopeType = "channel" | "dm" | "topic" | "task";

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

function statusTone(status: string): { background: string; color: string } {
  if (status === "task_owned") return { background: "var(--accent-muted)", color: "var(--accent)" };
  if (status === "closed") return { background: "var(--surface-soft)", color: "var(--fg-3)" };
  return { background: "var(--green-muted)", color: "var(--green)" };
}

function sessionScopeCounts(sessions: AgentBridgeSession[]): string {
  const counts = sessions.reduce<Record<string, number>>((acc, s) => {
    const key = s.current_scope_type || "unknown";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  return Object.entries(counts)
    .map(([key, count]) => `${key}:${count}`)
    .join(" · ");
}

async function copyText(value: string): Promise<void> {
  if (!value || typeof navigator === "undefined" || !navigator.clipboard) return;
  await navigator.clipboard.writeText(value);
}

function SessionCard({ session }: { session: AgentBridgeSession }) {
  const [expanded, setExpanded] = useState(false);
  const tone = statusTone(session.status);
  const bindings = session.bindings || [];
  const visibleBindings = expanded ? bindings : bindings.slice(0, 4);

  return (
    <div
      className="rounded-md border text-xs"
      style={{ borderColor: "var(--border)", background: "var(--bg-0)", overflow: "hidden" }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) auto",
          gap: 10,
          padding: "10px 12px",
          borderBottom: "1px solid var(--border)",
          background: "var(--surface)",
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div className="font-semibold truncate" style={{ color: "var(--fg-1)" }}>
            {scopeLabel(session.current_scope_type, session.current_scope_id)}
          </div>
          <div className="mt-1 font-mono truncate" style={{ color: "var(--fg-3)" }} title={session.session_id}>
            session:{session.session_id}
          </div>
        </div>
        <span
          className="rounded px-2 py-0.5 whitespace-nowrap"
          style={{ alignSelf: "start", background: tone.background, color: tone.color }}
        >
          {statusLabel(session.status)}
        </span>
      </div>

      <div style={{ padding: "10px 12px", display: "grid", gap: 10 }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr) auto",
            gap: 8,
            alignItems: "start",
          }}
        >
          <div
            className="font-mono"
            style={{
              color: "var(--fg-2)",
              background: "var(--surface-soft)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              padding: "7px 8px",
              lineHeight: 1.45,
              overflowWrap: "anywhere",
            }}
            title={session.provider_session_key}
          >
            {expanded ? session.provider_session_key : shortKey(session.provider_session_key)}
          </div>
          <button
            type="button"
            onClick={() => void copyText(session.provider_session_key)}
            title="复制 provider session key"
            aria-label="复制 provider session key"
            style={{
              width: 30,
              height: 30,
              display: "inline-grid",
              placeItems: "center",
              border: "1px solid var(--border)",
              borderRadius: 6,
              background: "var(--bg-0)",
              color: "var(--fg-2)",
              cursor: "pointer",
            }}
          >
            <AppIcon name="copy" style={{ width: 15, height: 15 }} />
          </button>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            gap: "6px 12px",
            color: "var(--fg-2)",
          }}
        >
          <div>Provider：{session.provider} / {session.provider_agent_id}</div>
          <div>Account：{session.provider_account_id}</div>
          <div>创建：{fmtTime(session.created_at)}</div>
          <div>最后使用：{fmtTime(session.last_used_at)}</div>
        </div>

        {bindings.length > 0 && (
          <div style={{ display: "grid", gap: 6 }}>
            <div className="an-rc-sub" style={{ marginTop: 0 }}>
              Bindings · {bindings.length}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {visibleBindings.map((b) => (
                <span
                  key={b.binding_id}
                  className="rounded border px-1.5 py-0.5 font-mono"
                  style={{
                    borderColor: b.detached_at ? "var(--red)" : "var(--border)",
                    color: b.detached_at ? "var(--red)" : "var(--fg-3)",
                    maxWidth: "100%",
                    overflowWrap: "anywhere",
                  }}
                  title={b.scope_id}
                >
                  {b.role}:{b.scope_type}:{b.scope_id}
                </span>
              ))}
            </div>
          </div>
        )}

        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          style={{
            justifySelf: "start",
            border: 0,
            background: "transparent",
            color: "var(--accent)",
            padding: 0,
            fontSize: 12,
            fontFamily: "inherit",
            cursor: "pointer",
          }}
        >
          {expanded ? "收起详情" : "展开详情"}
        </button>
      </div>
    </div>
  );
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
      {sessions.map((s) => <SessionCard key={s.session_id} session={s} />)}
    </div>
  );
}

export function SessionScopePanel({
  scopeType,
  scopeId,
  channelId,
  botId,
  title = "对应 Session",
  refreshKey = 0,
  variant = "block",
  onRefresh,
  refreshing = false,
}: {
  scopeType: ScopeType;
  scopeId: string;
  channelId: string;
  botId?: string | null;
  title?: string;
  refreshKey?: number;
  variant?: "block" | "toolbar";
  onRefresh?: () => void;
  refreshing?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [sessions, setSessions] = useState<AgentBridgeSession[]>([]);
  const [error, setError] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

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
  }, [botId, channelId, refreshKey, scopeId, scopeType]);

  useEffect(() => {
    if (variant !== "toolbar" || !open) return;
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open, variant]);

  if (variant === "toolbar") {
    const summary = loading ? "…" : String(sessions.length);
    return (
      <div className={`an-session-control ${onRefresh ? "has-refresh" : ""}`} ref={wrapRef}>
        <button
          type="button"
          className={`an-topics-btn an-session-btn ${open ? "on" : ""}`}
          onClick={() => setOpen((v) => !v)}
          title={title}
          aria-label={`${title}，${loading ? "加载中" : `${sessions.length} 个 active session`}`}
          aria-expanded={open}
        >
          <AppIcon name="link" />
          <span className="hidden sm:inline">Session</span>
          <span className="an-tb-n">{summary}</span>
        </button>
        {onRefresh && (
          <button
            type="button"
            className="an-session-refresh-btn"
            onClick={onRefresh}
            disabled={refreshing}
            title="刷新 DM Session"
            aria-label="刷新 DM Session"
          >
            <AppIcon name="refresh" className={refreshing ? "animate-spin" : ""} />
          </button>
        )}
        {open && (
          <div className="an-topics-pop an-session-pop">
            <div className="an-hd">{title}</div>
            <div className="an-session-pop-body">
              {error ? (
                <div className="text-xs" style={{ color: "var(--red)" }}>{error}</div>
              ) : (
                <SessionList sessions={sessions} />
              )}
            </div>
          </div>
        )}
      </div>
    );
  }

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
  const [includeClosed, setIncludeClosed] = useState(true);
  const [refreshNonce, setRefreshNonce] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ include_closed: String(includeClosed) });
    apiFetch(`/bots/${botId}/sessions?${params.toString()}`, { token: authToken })
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
  }, [authToken, botId, includeClosed, refreshNonce]);

  const activeCount = sessions.filter((s) => s.status !== "closed").length;
  const closedCount = sessions.length - activeCount;

  return (
    <div
      style={{
        display: "grid",
        gap: 10,
        border: "1px solid var(--border)",
        borderRadius: 8,
        background: "var(--surface-soft)",
        padding: 12,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "start" }}>
        <div>
          <div className="an-rc-title">All Sessions</div>
          <div className="an-rc-sub">
            该 Bot 的 AgentNexus session、provider session key 与 scope binding
          </div>
        </div>
        <button
          type="button"
          onClick={() => setRefreshNonce((v) => v + 1)}
          disabled={loading}
          title="刷新 sessions"
          aria-label="刷新 sessions"
          style={{
            width: 30,
            height: 30,
            display: "inline-grid",
            placeItems: "center",
            border: "1px solid var(--border)",
            borderRadius: 6,
            background: "var(--bg-0)",
            color: "var(--fg-2)",
            cursor: loading ? "wait" : "pointer",
            opacity: loading ? 0.6 : 1,
          }}
        >
          <AppIcon name="refresh" style={{ width: 15, height: 15 }} />
        </button>
      </div>

      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div className="an-rc-sub" style={{ marginTop: 0 }}>
          {loading
            ? "加载中..."
            : `${sessions.length} 个 sessions · active:${activeCount} · closed:${closedCount}${sessions.length ? ` · ${sessionScopeCounts(sessions)}` : ""}`}
        </div>
        <label className="an-rc-sub" style={{ display: "inline-flex", alignItems: "center", gap: 6, marginTop: 0 }}>
          <input
            type="checkbox"
            checked={includeClosed}
            onChange={(e) => setIncludeClosed(e.target.checked)}
          />
          包含 closed
        </label>
      </div>

      {error ? (
        <div className="an-rc-sub" style={{ color: "var(--red)" }}>{error}</div>
      ) : (
        <SessionList sessions={sessions} />
      )}
    </div>
  );
}
