import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../api";
import type { AgentBridgeSession } from "../types";
import { AppIcon, type AppIconName } from "./icons/AppIcon";

type ScopeType = "channel" | "dm" | "topic" | "task";
type ScopeTone = ScopeType | "unknown";

type ScopeMeta = {
  tone: ScopeTone;
  icon: AppIconName;
  label: string;
  detail: string;
};

function fmtTime(value?: string | null): string {
  if (!value) return "-";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function normalizeScope(type: string): ScopeTone {
  if (type === "channel" || type === "dm" || type === "topic" || type === "task") return type;
  return "unknown";
}

function scopeMeta(type: string): ScopeMeta {
  const tone = normalizeScope(type);
  if (tone === "channel") {
    return {
      tone,
      icon: "channel",
      label: "Main channel",
      detail: "Shared channel context",
    };
  }
  if (tone === "topic") {
    return {
      tone,
      icon: "messageCircle",
      label: "Topic",
      detail: "Thread-level context",
    };
  }
  if (tone === "task") {
    return {
      tone,
      icon: "task",
      label: "Task",
      detail: "Background task context",
    };
  }
  if (tone === "dm") {
    return {
      tone,
      icon: "message",
      label: "Bot DM",
      detail: "Direct bot conversation",
    };
  }
  return {
    tone,
    icon: "link",
    label: type || "Scope",
    detail: "Agent Bridge scope",
  };
}

function scopeMapLabel(type: string): string {
  const tone = normalizeScope(type);
  if (tone === "channel") return "Channel";
  if (tone === "topic") return "Topic";
  if (tone === "task") return "Task";
  if (tone === "dm") return "DM";
  return "Scope";
}

function shortId(value: string): string {
  if (!value) return "-";
  if (value.length <= 18) return value;
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

function shortKey(value: string): string {
  if (!value) return "-";
  if (value.length <= 34) return value;
  return `${value.slice(0, 18)}...${value.slice(-12)}`;
}

function statusLabel(status: string): string {
  if (status === "task_owned") return "Task-owned";
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
  const counts = sessions.reduce<Record<ScopeTone, number>>((acc, s) => {
    const key = normalizeScope(s.current_scope_type || "unknown");
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {} as Record<ScopeTone, number>);
  const order: ScopeTone[] = ["channel", "topic", "task", "dm", "unknown"];
  return order
    .filter((key) => counts[key])
    .map((key) => `${scopeMeta(key).label}:${counts[key]}`)
    .join(" · ");
}

async function copyText(value: string): Promise<void> {
  if (!value || typeof navigator === "undefined" || !navigator.clipboard) return;
  await navigator.clipboard.writeText(value);
}

function SessionRefreshAction({
  canRefresh,
  onRefresh,
  refreshing,
}: {
  canRefresh: boolean;
  onRefresh?: () => void;
  refreshing: boolean;
}) {
  if (!onRefresh) return null;
  const disabled = refreshing || !canRefresh;
  return (
    <button
      type="button"
      className="an-sp-refresh"
      onClick={onRefresh}
      disabled={disabled}
      title={canRefresh ? "Refresh this session scope" : "Only administrators can refresh sessions"}
      aria-label={canRefresh ? "Refresh this session scope" : "Only administrators can refresh sessions"}
    >
      <AppIcon name={canRefresh ? "refresh" : "shieldCheck"} className={refreshing ? "animate-spin" : ""} />
      <span>{canRefresh ? "Refresh" : "Admin only"}</span>
    </button>
  );
}

function SessionPanelHeader({
  title,
  scopeType,
  sessions,
  loading,
  canRefresh,
  onRefresh,
  refreshing,
}: {
  title: string;
  scopeType: ScopeType;
  sessions: AgentBridgeSession[];
  loading: boolean;
  canRefresh: boolean;
  onRefresh?: () => void;
  refreshing: boolean;
}) {
  const countLabel = loading ? "..." : String(sessions.length);

  return (
    <div className="an-sp-head">
      <div className="an-sp-head-main">
        <span className="an-sp-head-icon" data-scope={scopeType}>
          <AppIcon name={scopeMeta(scopeType).icon} />
        </span>
        <div className="an-sp-head-copy">
          <div className="an-sp-title">{title}</div>
        </div>
        <span className="an-sp-count" title={loading ? "Loading sessions" : `${sessions.length} active sessions`}>
          {countLabel}
        </span>
      </div>
      <SessionRefreshAction canRefresh={canRefresh} onRefresh={onRefresh} refreshing={refreshing} />
    </div>
  );
}

function SessionCard({ session }: { session: AgentBridgeSession }) {
  const [expanded, setExpanded] = useState(false);
  const tone = statusTone(session.status);
  const bindings = session.bindings || [];
  const visibleBindings = expanded ? bindings : bindings.slice(0, 5);
  const meta = scopeMeta(session.current_scope_type);

  return (
    <article className="an-sp-card">
      <div className="an-sp-card-top">
        <div className="an-sp-scope" data-scope={meta.tone}>
          <span className="an-sp-scope-icon">
            <AppIcon name={meta.icon} />
          </span>
          <div className="an-sp-scope-copy">
            <div className="an-sp-scope-label">{meta.label}</div>
            <div className="an-sp-scope-detail">
              <span>{meta.detail}</span>
              <span className="an-sp-dot" />
              <span title={session.current_scope_id}>{shortId(session.current_scope_id)}</span>
            </div>
          </div>
        </div>
        <span
          className="an-sp-status"
          style={{ background: tone.background, color: tone.color }}
        >
          {statusLabel(session.status)}
        </span>
      </div>

      <div className="an-sp-card-body">
        <div className="an-sp-key-row">
          <div className="an-sp-key" title={session.provider_session_key}>
            <span>Provider key</span>
            {expanded ? session.provider_session_key : shortKey(session.provider_session_key)}
          </div>
          <button
            type="button"
            onClick={() => void copyText(session.provider_session_key)}
            title="Copy provider session key"
            aria-label="Copy provider session key"
            className="an-sp-copy"
          >
            <AppIcon name="copy" />
          </button>
        </div>

        <dl className="an-sp-meta-grid">
          <div>
            <dt>Session</dt>
            <dd title={session.session_id}>{shortId(session.session_id)}</dd>
          </div>
          <div>
            <dt>Provider</dt>
            <dd title={`${session.provider} / ${session.provider_agent_id}`}>
              {session.provider} / {shortId(session.provider_agent_id)}
            </dd>
          </div>
          <div>
            <dt>Created</dt>
            <dd>{fmtTime(session.created_at)}</dd>
          </div>
          <div>
            <dt>Last used</dt>
            <dd>{fmtTime(session.last_used_at)}</dd>
          </div>
        </dl>

        {bindings.length > 0 && (
          <div className="an-sp-bindings">
            <div className="an-sp-section-label">
              Scope bindings · {bindings.length}
            </div>
            <div className="an-sp-binding-list">
              {visibleBindings.map((b) => (
                <span
                  key={b.binding_id}
                  className="an-sp-binding"
                  data-scope={normalizeScope(b.scope_type)}
                  data-detached={b.detached_at ? "1" : "0"}
                  title={`${b.role} · ${b.scope_type} · ${b.scope_id}`}
                >
                  <AppIcon name={scopeMeta(b.scope_type).icon} />
                  <span>{scopeMeta(b.scope_type).label}</span>
                  <span className="an-sp-binding-id">{shortId(b.scope_id)}</span>
                </span>
              ))}
              {!expanded && bindings.length > visibleBindings.length && (
                <span className="an-sp-binding an-sp-binding-more">
                  +{bindings.length - visibleBindings.length}
                </span>
              )}
            </div>
          </div>
        )}

        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="an-sp-details"
        >
          {expanded ? "Collapse details" : "Expand details"}
        </button>
      </div>
    </article>
  );
}

type RelationScope = {
  key: string;
  scopeType: string;
  scopeId: string;
  role: string;
  detached: boolean;
};

function sessionScopes(session: AgentBridgeSession): RelationScope[] {
  const seen = new Set<string>();
  const bindings = (session.bindings || [])
    .filter((binding) => !binding.detached_at)
    .map((binding) => ({
      key: `${binding.scope_type}:${binding.scope_id}:${binding.role}`,
      scopeType: binding.scope_type,
      scopeId: binding.scope_id,
      role: binding.role,
      detached: false,
    }));
  const source = bindings.length > 0
    ? bindings
    : [{
        key: `${session.current_scope_type}:${session.current_scope_id}:primary`,
        scopeType: session.current_scope_type,
        scopeId: session.current_scope_id,
        role: "primary",
        detached: false,
      }];
  const order: Record<string, number> = { channel: 0, topic: 1, task: 2, dm: 3 };
  return source
    .filter((scope) => {
      const key = `${scope.scopeType}:${scope.scopeId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => {
      const typeDelta = (order[a.scopeType] ?? 99) - (order[b.scopeType] ?? 99);
      if (typeDelta !== 0) return typeDelta;
      return a.scopeId.localeCompare(b.scopeId);
    });
}

function statusKey(status: string): string {
  if (status === "active" || status === "closed" || status === "task_owned") return status;
  return "unknown";
}

function SessionRelationMap({ sessions }: { sessions: AgentBridgeSession[] }) {
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const selectedSession = sessions.find((session) => session.session_id === selectedSessionId) || null;

  useEffect(() => {
    if (selectedSessionId && !selectedSession) {
      setSelectedSessionId(null);
    }
  }, [selectedSession, selectedSessionId]);

  return (
    <div className="an-sp-map">
      <div className="an-sp-map-canvas" aria-label="Session scope relation map">
        {sessions.map((session, index) => {
          const scopes = sessionScopes(session);
          const selected = selectedSessionId === session.session_id;
          return (
            <button
              key={session.session_id}
              type="button"
              className={`an-sp-map-row ${selected ? "is-selected" : ""}`}
              onClick={() => setSelectedSessionId((value) => (value === session.session_id ? null : session.session_id))}
              aria-expanded={selected}
              title="Show session details"
            >
              <span className="an-sp-map-scopes">
                {scopes.map((scope) => {
                  const meta = scopeMeta(scope.scopeType);
                  return (
                    <span
                      key={scope.key}
                      className="an-sp-map-scope"
                      data-scope={meta.tone}
                      title={`${scopeMapLabel(scope.scopeType)} · ${scope.scopeId}`}
                    >
                      <AppIcon name={meta.icon} />
                      <span>{scopeMapLabel(scope.scopeType)}</span>
                    </span>
                  );
                })}
              </span>
              <span className="an-sp-map-link" aria-hidden="true" />
              <span className="an-sp-map-session" data-status={statusKey(session.status)}>
                <span className="an-sp-session-dot" />
                <span>S{index + 1}</span>
              </span>
            </button>
          );
        })}
      </div>

      {selectedSession && (
        <div className="an-sp-map-details">
          <SessionCard session={selectedSession} />
        </div>
      )}
    </div>
  );
}

export function SessionList({
  sessions,
  view = "cards",
}: {
  sessions: AgentBridgeSession[];
  view?: "cards" | "map";
}) {
  if (sessions.length === 0) {
    return <div className="an-sp-empty">No Agent Bridge sessions.</div>;
  }
  if (view === "map") {
    return <SessionRelationMap sessions={sessions} />;
  }
  return (
    <div className="an-sp-list">
      {sessions.map((s) => <SessionCard key={s.session_id} session={s} />)}
    </div>
  );
}

function SessionPanelContent({
  title,
  scopeType,
  sessions,
  loading,
  error,
  canRefresh,
  onRefresh,
  refreshing,
}: {
  title: string;
  scopeType: ScopeType;
  sessions: AgentBridgeSession[];
  loading: boolean;
  error: string | null;
  canRefresh: boolean;
  onRefresh?: () => void;
  refreshing: boolean;
}) {
  return (
    <div className="an-session-panel">
      <SessionPanelHeader
        title={title}
        scopeType={scopeType}
        sessions={sessions}
        loading={loading}
        canRefresh={canRefresh}
        onRefresh={onRefresh}
        refreshing={refreshing}
      />
      <div className="an-session-panel-body">
        {error ? (
          <div className="an-sp-error">{error}</div>
        ) : (
          <SessionList sessions={sessions} view="map" />
        )}
      </div>
    </div>
  );
}

export function SessionScopePanel({
  scopeType,
  scopeId,
  channelId,
  botId,
  title = "Related sessions",
  refreshKey = 0,
  variant = "block",
  onRefresh,
  refreshing = false,
  canRefresh = false,
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
  canRefresh?: boolean;
}) {
  const [open, setOpen] = useState(variant === "block");
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
        setError((e as Error).message || "Failed to load sessions");
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
    const summary = loading ? "..." : String(sessions.length);
    return (
      <div className="an-session-control" ref={wrapRef}>
        <button
          type="button"
          className={`an-topics-btn an-session-btn ${open ? "on" : ""}`}
          onClick={() => setOpen((v) => !v)}
          title={title}
          aria-label={`${title},${loading ? "Loading" : `${sessions.length} active sessions`}`}
          aria-expanded={open}
        >
          <AppIcon name="link" />
          <span className="hidden sm:inline">Session</span>
          <span className="an-tb-n">{summary}</span>
        </button>
        {open && (
          <div className="an-topics-pop an-session-pop">
            <SessionPanelContent
              title={title}
              scopeType={scopeType}
              sessions={sessions}
              loading={loading}
              error={error}
              canRefresh={canRefresh}
              onRefresh={onRefresh}
              refreshing={refreshing}
            />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="an-session-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="an-session-block-toggle"
      >
        <span>
          {title}
        </span>
        <span>
          {loading ? "Loading" : `${sessions.length} active sessions`} · {open ? "Collapse" : "Expand"}
        </span>
      </button>
      {open && (
        <SessionPanelContent
          title={title}
          scopeType={scopeType}
          sessions={sessions}
          loading={loading}
          error={error}
          canRefresh={canRefresh}
          onRefresh={onRefresh}
          refreshing={refreshing}
        />
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
        setError((e as Error).message || "Failed to load sessions");
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
            AgentNexus sessions, provider session keys, and scope bindings for this bot
          </div>
        </div>
        <button
          type="button"
          onClick={() => setRefreshNonce((v) => v + 1)}
          disabled={loading}
          title="Refresh sessions"
          aria-label="Refresh sessions"
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
            ? "Loading..."
            : `${sessions.length} sessions · active:${activeCount} · closed:${closedCount}${sessions.length ? ` · ${sessionScopeCounts(sessions)}` : ""}`}
        </div>
        <label className="an-rc-sub" style={{ display: "inline-flex", alignItems: "center", gap: 6, marginTop: 0 }}>
          <input
            type="checkbox"
            checked={includeClosed}
            onChange={(e) => setIncludeClosed(e.target.checked)}
          />
          Include closed
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
