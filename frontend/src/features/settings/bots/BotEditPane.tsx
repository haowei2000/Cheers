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
import type { BotConnectionTestResult, BotRow, BotScope, ModelItem, TemplateItem } from "./types";

type BotSettingsTab = "profile" | "runtime" | "status";

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

  useEffect(() => {
    setDisplayName(bot.display_name || "");
    setDescription(bot.description || "");
    setAvatarUrl(bot.avatar_url || "");
    setScope(normalizeBotScope(bot.scope));
    setModelId(bot.model_id || "");
    setTemplateId(bot.template_id || "");
    setConnectionTest(null);
  }, [bot.avatar_url, bot.bot_id, bot.description, bot.display_name, bot.model_id, bot.scope, bot.template_id]);

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
