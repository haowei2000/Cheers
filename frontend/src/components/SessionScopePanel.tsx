import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../api";
import type { AgentBridgeSession } from "../types";
import { AppIcon, type AppIconName } from "./icons/AppIcon";

type ScopeType = "channel" | "dm" | "topic" | "task";
type ScopeTone = ScopeType | "unknown";

export type SessionScopeTarget = {
  scopeType: string;
  scopeId: string;
};

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
          <div className="an-sp-key" title={shortKey(session.provider_session_key)}>
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
            <dt>Provider session</dt>
            <dd title={session.provider_session_id || ""}>
              {session.provider_session_id ? shortId(session.provider_session_id) : "-"}
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
  scopeType: string;
  scopeId: string;
};

function activeSessionScope(session: AgentBridgeSession): RelationScope {
  const scopeType = session.current_scope_type || "unknown";
  const scopeId = session.current_scope_id || "";
  return {
    scopeType,
    scopeId,
  };
}

function statusKey(status: string): string {
  if (status === "active" || status === "closed" || status === "task_owned") return status;
  return "unknown";
}

function SessionRelationMap({
  sessions,
  onOpenScope,
}: {
  sessions: AgentBridgeSession[];
  onOpenScope?: (target: SessionScopeTarget) => void;
}) {
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
          const scope = activeSessionScope(session);
          const meta = scopeMeta(scope.scopeType);
          const selected = selectedSessionId === session.session_id;
          const canOpenTarget = Boolean(onOpenScope && scope.scopeId);
          return (
            <div
              key={session.session_id}
              className={`an-sp-map-row ${selected ? "is-selected" : ""}`}
            >
              <button
                type="button"
                className="an-sp-session-node"
                data-status={statusKey(session.status)}
                onClick={() => setSelectedSessionId((value) => (value === session.session_id ? null : session.session_id))}
                aria-expanded={selected}
                title="Show session details"
              >
                <span className="an-sp-session-dot" />
                <span>S{index + 1}</span>
              </button>
              <span className="an-sp-map-link" aria-hidden="true" />
              <button
                type="button"
                className="an-sp-object-node"
                data-scope={meta.tone}
                disabled={!canOpenTarget}
                onClick={() => onOpenScope?.({ scopeType: scope.scopeType, scopeId: scope.scopeId })}
                title={canOpenTarget ? `Open ${scopeMapLabel(scope.scopeType)} · ${scope.scopeId}` : `${scopeMapLabel(scope.scopeType)} · ${scope.scopeId}`}
              >
                <AppIcon name={meta.icon} />
                <span>{scopeMapLabel(scope.scopeType)}</span>
                {scope.scopeId && <span className="an-sp-object-id">{shortId(scope.scopeId)}</span>}
              </button>
            </div>
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
  onOpenScope,
}: {
  sessions: AgentBridgeSession[];
  view?: "cards" | "map";
  onOpenScope?: (target: SessionScopeTarget) => void;
}) {
  if (sessions.length === 0) {
    return <div className="an-sp-empty">No Agent Bridge sessions.</div>;
  }
  if (view === "map") {
    return <SessionRelationMap sessions={sessions} onOpenScope={onOpenScope} />;
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
  onOpenScope,
}: {
  title: string;
  scopeType: ScopeType;
  sessions: AgentBridgeSession[];
  loading: boolean;
  error: string | null;
  canRefresh: boolean;
  onRefresh?: () => void;
  refreshing: boolean;
  onOpenScope?: (target: SessionScopeTarget) => void;
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
          <SessionList sessions={sessions} view="map" onOpenScope={onOpenScope} />
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
  onOpenScope,
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
  onOpenScope?: (target: SessionScopeTarget) => void;
}) {
  const [open, setOpen] = useState(variant === "block");
  const [loading, setLoading] = useState(false);
  const [sessions, setSessions] = useState<AgentBridgeSession[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loadedScopeKey, setLoadedScopeKey] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const sessionScopeKey = `${scopeType}:${scopeId}:${channelId}:${botId ?? ""}`;
  const shouldLoadSessions = variant === "block" || open;
  const isCurrentScopeLoaded = loadedScopeKey === sessionScopeKey;
  const visibleSessions = isCurrentScopeLoaded ? sessions : [];
  const visibleLoading =
    loading || (shouldLoadSessions && !isCurrentScopeLoaded && !error);

  useEffect(() => {
    let active = true;
    if (!scopeId || !channelId) {
      setSessions([]);
      setLoadedScopeKey(null);
      setLoading(false);
      return;
    }
    if (!shouldLoadSessions) {
      setLoading(false);
      setError(null);
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
    setSessions([]);
    setLoadedScopeKey(null);
    apiFetch(`/agent-bridge/sessions/scope?${params.toString()}`)
      .then((r) => r.json())
      .then((d) => {
        if (!active) return;
        setSessions(Array.isArray(d?.data) ? d.data : []);
        setLoadedScopeKey(sessionScopeKey);
      })
      .catch((e: unknown) => {
        if (!active) return;
        setError((e as Error).message || "Failed to load sessions");
        setSessions([]);
        setLoadedScopeKey(sessionScopeKey);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [botId, channelId, refreshKey, scopeId, scopeType, sessionScopeKey, shouldLoadSessions]);

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

  const handleOpenScope = (target: SessionScopeTarget) => {
    onOpenScope?.(target);
    if (variant === "toolbar") setOpen(false);
  };

  if (variant === "toolbar") {
    const summary = visibleLoading
      ? "..."
      : isCurrentScopeLoaded
        ? String(visibleSessions.length)
        : "-";
    return (
      <div className="an-session-control" ref={wrapRef}>
        <button
          type="button"
          className={`an-topics-btn an-session-btn ${open ? "on" : ""}`}
          onClick={() => setOpen((v) => !v)}
          title={title}
          aria-label={`${title},${visibleLoading ? "Loading" : isCurrentScopeLoaded ? `${visibleSessions.length} active sessions` : "not loaded"}`}
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
              sessions={visibleSessions}
              loading={visibleLoading}
              error={error}
              canRefresh={canRefresh}
              onRefresh={onRefresh}
              refreshing={refreshing}
              onOpenScope={handleOpenScope}
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
          {visibleLoading ? "Loading" : `${visibleSessions.length} active sessions`} · {open ? "Collapse" : "Expand"}
        </span>
      </button>
      {open && (
        <SessionPanelContent
          title={title}
          scopeType={scopeType}
          sessions={visibleSessions}
          loading={visibleLoading}
          error={error}
          canRefresh={canRefresh}
          onRefresh={onRefresh}
          refreshing={refreshing}
          onOpenScope={handleOpenScope}
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
