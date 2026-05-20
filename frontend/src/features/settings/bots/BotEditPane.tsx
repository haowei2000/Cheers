import { useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import { apiFetch } from "../../../api";
import { AVATAR_ACCEPT, uploadAvatarImage } from "../../../lib/avatar";
import { BotAvatar } from "../../../components/BotAvatar";
import { BotSessionsPanel } from "../../../components/SessionScopePanel";
import {
  ModelBrandCard,
  modelBrandName,
} from "../models/ModelListSubPane";
import {
  DangerButton,
  Field,
  PrimaryButton,
  inputCls,
} from "../shared/SettingsControls";
import {
  BotOnlineBadge,
  BotScopeControl,
  botOwnerLabel,
  botScopeLabel,
  normalizeBotScope,
} from "./BotShared";
import type {
  BotConnectionTestResult,
  BotRow,
  BotScope,
  ConnectorPermissionMode,
  ModelItem,
  TemplateItem,
} from "./types";

type BotSettingsTab = "profile" | "runtime" | "status";

function normalizeConnectorPermissionMode(value: unknown): ConnectorPermissionMode {
  return value === "allow" || value === "cancel" || value === "reject" ? value : "reject";
}

function msToSeconds(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(5, Math.round(value / 1000))
    : fallback;
}

function secondsToMs(value: number): number {
  return Math.max(5, Math.round(value)) * 1000;
}

function safeConnectorText(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function connectorOptionTitle(option: { id?: string; name?: string }): string {
  const name = safeConnectorText(option.name, "");
  const id = safeConnectorText(option.id, "");
  if (name && id && name !== id) return `${name} (${id})`;
  return name || id || "Option";
}

function isManagedBotAvatarUrl(value: string): boolean {
  return value.startsWith("/api/v1/avatars/bots/") ||
    value.includes("/api/v1/avatars/bots/");
}

export function BotEditPane({
  bot,
  authToken,
  onUpdated,
  onDeleted,
}: {
  bot: BotRow;
  authToken: string | null;
  onUpdated: () => void;
  onDeleted: () => void;
}) {
  const [displayName, setDisplayName] = useState(bot.display_name || "");
  const [description, setDescription] = useState(bot.description || "");
  const [avatarUrl, setAvatarUrl] = useState(bot.avatar_url || "");
  const avatarInputRef = useRef<HTMLInputElement | null>(null);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [scope, setScope] = useState<BotScope>(normalizeBotScope(bot.scope));
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [testingConnection, setTestingConnection] = useState(false);
  const [connectionTest, setConnectionTest] = useState<BotConnectionTestResult | null>(null);
  const isHttpBot = (bot.binding_type || "http") === "http";
  const [models, setModels] = useState<ModelItem[]>([]);
  const [templates, setTemplates] = useState<TemplateItem[]>([]);
  const [modelId, setModelId] = useState(bot.model_id || "");
  const [templateId, setTemplateId] = useState(bot.template_id || "");
  const [botTab, setBotTab] = useState<BotSettingsTab>("profile");
  const connectorControl = bot.binding_config?.connector_control;
  const connectorSettings = connectorControl?.settings || {};
  const connectorOptions = connectorControl?.options || null;
  const discoveredModes = connectorOptions?.modes?.availableModes || [];
  const discoveredConfigOptions = connectorOptions?.configOptions || [];
  const discoveredModelOption = discoveredConfigOptions.find((option) => {
    const id = safeConnectorText(option.id, "").toLowerCase();
    const name = safeConnectorText(option.name, "").toLowerCase();
    return id === "model" || name.includes("model");
  });
  const discoveredModelValues = discoveredModelOption?.values || [];
  const connectorModelListId = `connector-model-options-${bot.bot_id}`;
  const [savingConnectorControl, setSavingConnectorControl] = useState(false);
  const [connectorPermissionMode, setConnectorPermissionMode] = useState<ConnectorPermissionMode>(
    normalizeConnectorPermissionMode(connectorSettings.permissionMode),
  );
  const [connectorPromptTimeoutSeconds, setConnectorPromptTimeoutSeconds] = useState(
    msToSeconds(connectorSettings.promptTimeoutMs, 900),
  );
  const [connectorRequestTimeoutSeconds, setConnectorRequestTimeoutSeconds] = useState(
    msToSeconds(connectorSettings.requestTimeoutMs, 120),
  );
  const [connectorCwd, setConnectorCwd] = useState(connectorSettings.cwd || "");
  const [connectorModel, setConnectorModel] = useState(connectorSettings.model || "");

  useEffect(() => {
    setDisplayName(bot.display_name || "");
    setDescription(bot.description || "");
    setAvatarUrl(bot.avatar_url || "");
    setScope(normalizeBotScope(bot.scope));
    setModelId(bot.model_id || "");
    setTemplateId(bot.template_id || "");
    const nextSettings = bot.binding_config?.connector_control?.settings || {};
    setConnectorPermissionMode(normalizeConnectorPermissionMode(nextSettings.permissionMode));
    setConnectorPromptTimeoutSeconds(msToSeconds(nextSettings.promptTimeoutMs, 900));
    setConnectorRequestTimeoutSeconds(msToSeconds(nextSettings.requestTimeoutMs, 120));
    setConnectorCwd(nextSettings.cwd || "");
    setConnectorModel(nextSettings.model || "");
    setConnectionTest(null);
  }, [
    bot.avatar_url,
    bot.binding_config,
    bot.bot_id,
    bot.description,
    bot.display_name,
    bot.model_id,
    bot.scope,
    bot.template_id,
  ]);

  useEffect(() => {
    let active = true;
    if (isHttpBot) {
      apiFetch("/admin/models?include_disabled=false", { token: authToken })
        .then((r) => r.json())
        .then((d) => {
          if (!active) return;
          const list: ModelItem[] = Array.isArray(d?.data) ? d.data : [];
          setModels(list);
        })
        .catch(() => {
          if (active) setModels([]);
        });
    } else {
      setModels([]);
    }
    apiFetch("/templates", { token: authToken })
      .then((r) => r.json())
      .then((d) => {
        if (!active) return;
        const list: TemplateItem[] = Array.isArray(d?.data) ? d.data : [];
        setTemplates(list);
      })
      .catch(() => {
        if (active) setTemplates([]);
      });
    return () => {
      active = false;
    };
  }, [authToken, bot.bot_id, bot.model_id, bot.template_id, isHttpBot]);

  const save = async (opts?: { silent?: boolean }) => {
    if (isHttpBot && (!modelId || !templateId)) {
      toast.error("HTTP bots require a model and template");
      return false;
    }
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        display_name: displayName.trim() || bot.username,
        description: description.trim() || null,
        avatar_url: avatarUrl.trim() || null,
        scope,
        template_id: templateId || null,
      };
      if (isHttpBot) {
        body.model_id = modelId;
      }
      const res = await apiFetch(`/bots/${bot.bot_id}`, {
        method: "PUT",
        token: authToken,
        body,
      });
      const data = await res.json();
      if (data?.status === "success") {
        if (!opts?.silent) toast.success("Saved");
        setConnectionTest(null);
        onUpdated();
        return true;
      } else {
        toast.error(data?.message || data?.detail || "Save failed");
        return false;
      }
    } catch (e: unknown) {
      toast.error((e as Error).message || "Save failed");
      return false;
    } finally {
      setSaving(false);
    }
  };

  const uploadBotAvatar = async (file: File | null | undefined) => {
    if (!file) return;
    setAvatarUploading(true);
    try {
      const uploaded = await uploadAvatarImage(`/avatars/bots/${bot.bot_id}`, file, authToken);
      setAvatarUrl(uploaded.avatar_url);
      toast.success("Bot Avatar uploaded");
      onUpdated();
    } catch (e: unknown) {
      toast.error((e as Error).message || "Avatar upload failed");
    } finally {
      setAvatarUploading(false);
      if (avatarInputRef.current) avatarInputRef.current.value = "";
    }
  };

  const clearBotAvatar = async () => {
    if (!avatarUrl) return;
    if (!isManagedBotAvatarUrl(avatarUrl)) {
      setAvatarUrl("");
      return;
    }
    try {
      const res = await apiFetch(`/avatars/bots/${bot.bot_id}`, {
        method: "DELETE",
        token: authToken,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.status === "error") {
        throw new Error(data?.message || data?.detail || "Avatar clear failed");
      }
      setAvatarUrl("");
      toast.success("Bot avatar cleared");
      onUpdated();
    } catch (e: unknown) {
      toast.error((e as Error).message || "Avatar clear failed");
    }
  };

  const remove = async () => {
    if (!confirm(`Delete @${bot.username}? This cannot be undone.`)) return;
    setDeleting(true);
    try {
      const res = await apiFetch(`/bots/${bot.bot_id}`, {
        method: "DELETE",
        token: authToken,
      });
      const data = await res.json();
      if (data?.status === "success") {
        toast.success("Deleted");
        onDeleted();
      } else {
        toast.error(data?.message || data?.detail || "Delete failed");
      }
    } catch (e: unknown) {
      toast.error((e as Error).message || "Delete failed");
    } finally {
      setDeleting(false);
    }
  };

  const testConnection = async () => {
    if (isHttpBot && (!bot.model_id || !bot.template_id)) {
      toast.error("Save the HTTP bot model and template before testing");
      return;
    }
    setTestingConnection(true);
    try {
      const res = await apiFetch(`/bots/${bot.bot_id}/connection-test`, {
        method: "POST",
        token: authToken,
      });
      const data = await res.json();
      if (data?.status !== "success") {
        throw new Error(data?.message || data?.detail || "Connection test failed");
      }
      const result = data.data as BotConnectionTestResult;
      setConnectionTest(result);
      if (result.reachable) {
        toast.success(result.message || "Bot connection is healthy");
      } else {
        toast.error(result.message || "Bot is not connected");
      }
      onUpdated();
    } catch (e: unknown) {
      const message = (e as Error).message || "Connection test failed";
      setConnectionTest({ reachable: false, message });
      toast.error(message);
    } finally {
      setTestingConnection(false);
    }
  };

  const saveConnectorControl = async () => {
    setSavingConnectorControl(true);
    try {
      const settings: Record<string, unknown> = {
        permissionMode: connectorPermissionMode,
        promptTimeoutMs: secondsToMs(connectorPromptTimeoutSeconds),
        requestTimeoutMs: secondsToMs(connectorRequestTimeoutSeconds),
      };
      if (connectorCwd.trim()) settings.cwd = connectorCwd.trim();
      if (connectorModel.trim()) settings.model = connectorModel.trim();
      const res = await apiFetch(`/bots/${bot.bot_id}/connector-control`, {
        method: "PUT",
        token: authToken,
        body: {
          settings,
        },
      });
      const data = await res.json();
      if (data?.status !== "success") {
        throw new Error(data?.message || data?.detail || "Save failed");
      }
      toast.success(data.data?.dispatched ? "Connector settings sent" : "Connector settings saved");
      onUpdated();
    } catch (e: unknown) {
      toast.error((e as Error).message || "Save failed");
    } finally {
      setSavingConnectorControl(false);
    }
  };

  const modelOptions = modelId && !models.some((m) => m.model_id === modelId)
    ? [{ model_id: modelId, name: bot.model_name || "Current model" }, ...models]
    : models;
  const templateOptions = templateId && !templates.some((t) => t.template_id === templateId)
    ? [{ template_id: templateId, name: bot.template_name || "Current template" }, ...templates]
    : templates;
  const selectedModel = modelOptions.find((m) => m.model_id === modelId);
  const botBrandName = modelBrandName(selectedModel) || bot.model_name || bot.display_name || bot.username;

  return (
    <div className="an-pane">
      <div
        className="an-pane-head"
        style={{ justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
          <BotAvatar
            label={displayName || bot.username}
            avatarUrl={avatarUrl}
            brandName={botBrandName}
            size={42}
          />
          <div style={{ minWidth: 0 }}>
            <div className="an-pane-title">{bot.display_name || bot.username}</div>
            <div className="an-pane-sub">
              @{bot.username} · {bot.bot_id}
              {bot.is_builtin ? " · Built-in" : ""}
            </div>
            <div className="an-pane-sub">
              Owner: {botOwnerLabel(bot)} · {botScopeLabel(scope)}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
          <BotOnlineBadge bot={bot} />
          <div className="an-seg" role="tablist" aria-label="Bot settings view">
            <button
              type="button"
              className={botTab === "profile" ? "on" : ""}
              onClick={() => setBotTab("profile")}
              role="tab"
              aria-selected={botTab === "profile"}
            >
              Profile
            </button>
            <button
              type="button"
              className={botTab === "runtime" ? "on" : ""}
              onClick={() => setBotTab("runtime")}
              role="tab"
              aria-selected={botTab === "runtime"}
            >
              Configuration
            </button>
            <button
              type="button"
              className={botTab === "status" ? "on" : ""}
              onClick={() => setBotTab("status")}
              role="tab"
              aria-selected={botTab === "status"}
            >
              Status
            </button>
          </div>
        </div>
      </div>
      <div className="an-list-table">
        {botTab === "status" && (
          <>
        <div className="an-row-card" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <div>
              <div className="an-rc-title">Online check</div>
              <div className="an-rc-sub">Live connectivity test</div>
            </div>
            <PrimaryButton onClick={testConnection} disabled={testingConnection || saving}>
              {testingConnection ? "Testing..." : "Test connection"}
            </PrimaryButton>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 }}>
            <div className="an-rc-sub">Type:{(bot.binding_type || "http") === "agent_bridge" ? "Agent Bridge" : "HTTP"}</div>
            <div className="an-rc-sub">Status:{bot.status || "online"}</div>
            {(bot.binding_type || "http") === "agent_bridge" && (
              <>
                <div className="an-rc-sub">Control:{bot.control_connected ? "Online" : "Offline"}</div>
                <div className="an-rc-sub">Data:{bot.data_connected ? "Online" : "Offline"}</div>
              </>
            )}
          </div>
          {connectionTest && (
            <div
              className="an-inline-status"
              style={{
                background: connectionTest.reachable ? "var(--green-muted)" : "var(--red-muted)",
                color: connectionTest.reachable ? "var(--green)" : "var(--red)",
              }}
            >
              <div style={{ fontWeight: 650 }}>
                {connectionTest.reachable ? "Connection healthy" : "Not connected"}
                {typeof connectionTest.duration_ms === "number" ? ` · ${connectionTest.duration_ms}ms` : ""}
              </div>
              {connectionTest.message && <div>{connectionTest.message}</div>}
            </div>
          )}
        </div>
        {(bot.binding_type || "http") === "agent_bridge" && (
          <BotSessionsPanel botId={bot.bot_id} authToken={authToken} />
        )}
          </>
        )}
        {botTab === "runtime" && (
          <>
        {isHttpBot && (
          <div className="an-row-card" style={{ flexDirection: "column", alignItems: "stretch", gap: 10 }}>
            <div className="an-rc-title">LLM models</div>
            <ModelBrandCard model={selectedModel} />
            {bot.is_builtin && (
              <div className="an-rc-sub">
                Built-in bot DMs use a dedicated adapter. Connection tests do not read this model binding.
              </div>
            )}
            <Field label="AI model">
              <select
                value={modelId}
                onChange={(e) => {
                  setModelId(e.target.value);
                  setConnectionTest(null);
                }}
                className={inputCls}
              >
                {modelOptions.length === 0 ? (
                  <option value="">(No models available)</option>
                ) : (
                  <>
                    <option value="">(No model configured. Select one, then save.)</option>
                    {modelOptions.map((m) => (
                      <option key={m.model_id} value={m.model_id}>
                        {m.name}
                      </option>
                    ))}
                  </>
                )}
              </select>
            </Field>
          </div>
        )}
        <div className="an-row-card" style={{ flexDirection: "column", alignItems: "stretch", gap: 10 }}>
          <div className="an-rc-title">Prompt template</div>
          <Field label={isHttpBot ? "Prompt template" : "Task template sent to the plugin"}>
            <select
              value={templateId}
              onChange={(e) => {
                setTemplateId(e.target.value);
                setConnectionTest(null);
              }}
              className={inputCls}
            >
              {templateOptions.length === 0 ? (
                <option value="">(No templates available)</option>
              ) : (
                <>
                  {isHttpBot && <option value="">(No template configured. Select one, then save.)</option>}
                  {!isHttpBot && <option value="">(Use the system default template)</option>}
                  {templateOptions.map((t) => (
                    <option key={t.template_id} value={t.template_id}>
                      {t.name}
                    </option>
                  ))}
                </>
              )}
            </select>
          </Field>
          {!isHttpBot && (
            <div className="an-rc-sub" style={{ marginTop: 0 }}>
              The backend renders the template into final task text, then sends it to the provider through Agent Bridge.
            </div>
          )}
        </div>
        {!isHttpBot && (
          <div className="an-row-card" style={{ flexDirection: "column", alignItems: "stretch", gap: 10 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <div>
                <div className="an-rc-title">Connector control</div>
                <div className="an-rc-sub">Revision {connectorControl?.revision ?? "not set"}</div>
              </div>
              {connectorControl?.last_status && (
                <span className={`an-chip ${connectorControl.last_status.ok ? "green" : "red"}`}>
                  {connectorControl.last_status.ok ? "Applied" : "Rejected"}
                </span>
              )}
            </div>
            <Field label="Permission mode">
              <select
                value={connectorPermissionMode}
                onChange={(e) => setConnectorPermissionMode(normalizeConnectorPermissionMode(e.target.value))}
                className={inputCls}
              >
                <option value="reject">Reject</option>
                <option value="allow">Allow</option>
                <option value="cancel">Cancel</option>
              </select>
            </Field>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 }}>
              <Field label="Working directory">
                <input
                  value={connectorCwd}
                  onChange={(e) => setConnectorCwd(e.target.value)}
                  className={inputCls}
                  placeholder="/tmp/agent-workspace"
                />
              </Field>
              <Field label="Codex model">
                <input
                  value={connectorModel}
                  onChange={(e) => setConnectorModel(e.target.value)}
                  className={inputCls}
                  list={discoveredModelValues.length ? connectorModelListId : undefined}
                  placeholder="gpt-5.5"
                />
                {discoveredModelValues.length > 0 && (
                  <datalist id={connectorModelListId}>
                    {discoveredModelValues.map((value) => {
                      const id = safeConnectorText(value.id, "");
                      const name = safeConnectorText(value.name, id || "Model");
                      return <option key={id || name} value={id || name} label={name} />;
                    })}
                  </datalist>
                )}
              </Field>
              <Field label="Prompt timeout (seconds)">
                <input
                  type="number"
                  min={5}
                  max={3600}
                  value={connectorPromptTimeoutSeconds}
                  onChange={(e) => setConnectorPromptTimeoutSeconds(Number(e.target.value || 0))}
                  className={inputCls}
                />
              </Field>
              <Field label="Request timeout (seconds)">
                <input
                  type="number"
                  min={5}
                  max={3600}
                  value={connectorRequestTimeoutSeconds}
                  onChange={(e) => setConnectorRequestTimeoutSeconds(Number(e.target.value || 0))}
                  className={inputCls}
                />
              </Field>
            </div>
            {connectorControl?.last_status?.rejected?.length ? (
              <div className="an-inline-status" style={{ background: "var(--red-muted)", color: "var(--red)" }}>
                {connectorControl.last_status.rejected.map((item) => `${item.field || "field"}: ${item.reason || "rejected"}`).join("; ")}
              </div>
            ) : null}
            {connectorOptions && (
              <div className="an-inline-status" style={{ background: "var(--surface-soft)", color: "var(--fg-1)" }}>
                <div style={{ fontWeight: 650 }}>
                  ACP discovered options
                  {connectorOptions.reported_at ? ` · ${new Date(connectorOptions.reported_at).toLocaleString()}` : ""}
                </div>
                {connectorOptions.agentInfo && (
                  <div>
                    Agent: {safeConnectorText(connectorOptions.agentInfo["name"], "unknown")}
                    {connectorOptions.agentInfo["version"] ? ` · ${String(connectorOptions.agentInfo["version"])}` : ""}
                  </div>
                )}
                {discoveredModes.length > 0 && (
                  <div>
                    Modes: {discoveredModes.map((mode) => {
                      const id = safeConnectorText(mode.id, "");
                      const name = safeConnectorText(mode.name, id || "Mode");
                      const current = id && id === connectorOptions.modes?.currentModeId;
                      return `${name}${current ? " (current)" : ""}`;
                    }).join(", ")}
                  </div>
                )}
                {discoveredConfigOptions.length > 0 && (
                  <div>
                    Options: {discoveredConfigOptions.slice(0, 6).map((option) => {
                      const current = safeConnectorText(option.currentValueId, "");
                      return current ? `${connectorOptionTitle(option)}=${current}` : connectorOptionTitle(option);
                    }).join(", ")}
                    {discoveredConfigOptions.length > 6 ? `, +${discoveredConfigOptions.length - 6}` : ""}
                  </div>
                )}
                {connectorOptions.truncated && <div>Options payload was too large and was truncated.</div>}
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <PrimaryButton onClick={() => void saveConnectorControl()} disabled={savingConnectorControl}>
                {savingConnectorControl ? "Saving..." : "Save connector control"}
              </PrimaryButton>
            </div>
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <PrimaryButton onClick={() => void save()} disabled={saving}>
            {saving ? "Saving..." : "Save configuration"}
          </PrimaryButton>
        </div>
          </>
        )}
        {botTab === "profile" && (
          <>
        <div className="an-row-card" style={{ flexDirection: "column", alignItems: "stretch", gap: 10 }}>
          <div className="an-rc-title">Basic information</div>
          <Field label="Display name">
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field label="Avatar">
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <BotAvatar
                label={displayName || bot.username}
                avatarUrl={avatarUrl}
                brandName={botBrandName}
                size={36}
              />
              <input
                value={avatarUrl}
                onChange={(e) => setAvatarUrl(e.target.value)}
                className={inputCls}
                placeholder="https://example.com/bot.png"
                style={{ flex: 1 }}
              />
              <input
                ref={avatarInputRef}
                type="file"
                accept={AVATAR_ACCEPT}
                onChange={(e) => uploadBotAvatar(e.target.files?.[0])}
                style={{ display: "none" }}
              />
              <button
                type="button"
                onClick={() => avatarInputRef.current?.click()}
                disabled={avatarUploading}
                className="an-btn an-btn-sm"
              >
                {avatarUploading ? "Uploading..." : "Upload"}
              </button>
              {avatarUrl && (
                <button
                  type="button"
                  onClick={() => void clearBotAvatar()}
                  className="an-btn an-btn-sm"
                >
                  Clear
                </button>
              )}
            </div>
          </Field>
          <Field label="Description">
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className={`${inputCls} resize-none`}
            />
          </Field>
          <Field label="Scope">
            <BotScopeControl value={scope} onChange={setScope} disabled={saving} />
          </Field>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            {bot.is_builtin ? (
              <span className="an-rc-sub" style={{ alignSelf: "center" }}>
                Built-in bots cannot be deleted
              </span>
            ) : (
              <DangerButton onClick={remove} disabled={deleting}>
                {deleting ? "Deleting..." : "Delete Bot"}
              </DangerButton>
            )}
            <PrimaryButton onClick={() => void save()} disabled={saving}>
              {saving ? "Saving..." : "Save"}
            </PrimaryButton>
          </div>
        </div>
        <div className="an-row-card an-type-meta">
          Advanced configuration now lives in Settings. HTTP bots can switch models and templates here; Agent Bridge bots can switch task templates.
        </div>
          </>
        )}
      </div>
    </div>
  );
}
