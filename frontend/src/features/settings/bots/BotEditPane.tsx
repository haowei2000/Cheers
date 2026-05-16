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
      toast.error("HTTP Bot 必须选择模型和模板");
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
        if (!opts?.silent) toast.success("已保存");
        setConnectionTest(null);
        onUpdated();
        return true;
      } else {
        toast.error(data?.message || data?.detail || "保存失败");
        return false;
      }
    } catch (e: unknown) {
      toast.error((e as Error).message || "保存失败");
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
      toast.success("Bot 头像已上传");
      onUpdated();
    } catch (e: unknown) {
      toast.error((e as Error).message || "头像上传失败");
    } finally {
      setAvatarUploading(false);
      if (avatarInputRef.current) avatarInputRef.current.value = "";
    }
  };

  const remove = async () => {
    if (!confirm(`确定删除 @${bot.username}？此操作无法撤销。`)) return;
    setDeleting(true);
    try {
      const res = await apiFetch(`/bots/${bot.bot_id}`, {
        method: "DELETE",
        token: authToken,
      });
      const data = await res.json();
      if (data?.status === "success") {
        toast.success("已删除");
        onDeleted();
      } else {
        toast.error(data?.message || data?.detail || "删除失败");
      }
    } catch (e: unknown) {
      toast.error((e as Error).message || "删除失败");
    } finally {
      setDeleting(false);
    }
  };

  const testConnection = async () => {
    if (isHttpBot && (!bot.model_id || !bot.template_id)) {
      toast.error("HTTP Bot 尚未保存模型和模板配置，请先保存后测试");
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
        throw new Error(data?.message || data?.detail || "连通测试失败");
      }
      const result = data.data as BotConnectionTestResult;
      setConnectionTest(result);
      if (result.reachable) {
        toast.success(result.message || "Bot 连通正常");
      } else {
        toast.error(result.message || "Bot 未连通");
      }
      onUpdated();
    } catch (e: unknown) {
      const message = (e as Error).message || "连通测试失败";
      setConnectionTest({ reachable: false, message });
      toast.error(message);
    } finally {
      setTestingConnection(false);
    }
  };

  const modelOptions = modelId && !models.some((m) => m.model_id === modelId)
    ? [{ model_id: modelId, name: bot.model_name || "当前模型" }, ...models]
    : models;
  const templateOptions = templateId && !templates.some((t) => t.template_id === templateId)
    ? [{ template_id: templateId, name: bot.template_name || "当前模板" }, ...templates]
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
              {bot.is_builtin ? " · 内置" : ""}
            </div>
            <div className="an-pane-sub">
              Owner: {botOwnerLabel(bot)} · {botScopeLabel(scope)}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
          <BotOnlineBadge bot={bot} />
          <div className="an-seg" role="tablist" aria-label="Bot 设置视图">
            <button
              type="button"
              className={botTab === "profile" ? "on" : ""}
              onClick={() => setBotTab("profile")}
              role="tab"
              aria-selected={botTab === "profile"}
            >
              资料
            </button>
            <button
              type="button"
              className={botTab === "runtime" ? "on" : ""}
              onClick={() => setBotTab("runtime")}
              role="tab"
              aria-selected={botTab === "runtime"}
            >
              配置
            </button>
            <button
              type="button"
              className={botTab === "status" ? "on" : ""}
              onClick={() => setBotTab("status")}
              role="tab"
              aria-selected={botTab === "status"}
            >
              状态
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
              <div className="an-rc-title">在线检测</div>
              <div className="an-rc-sub">实时连通测试</div>
            </div>
            <PrimaryButton onClick={testConnection} disabled={testingConnection || saving}>
              {testingConnection ? "测试中…" : "测试连通"}
            </PrimaryButton>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 }}>
            <div className="an-rc-sub">类型：{(bot.binding_type || "http") === "agent_bridge" ? "Agent Bridge" : "HTTP"}</div>
            <div className="an-rc-sub">状态：{bot.status || "online"}</div>
            {(bot.binding_type || "http") === "agent_bridge" && (
              <>
                <div className="an-rc-sub">Control：{bot.control_connected ? "在线" : "离线"}</div>
                <div className="an-rc-sub">Data：{bot.data_connected ? "在线" : "离线"}</div>
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
                {connectionTest.reachable ? "连通正常" : "未连通"}
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
            <div className="an-rc-title">LLM 模型</div>
            <ModelBrandCard model={selectedModel} />
            {bot.is_builtin && (
              <div className="an-rc-sub">
                内置 Bot 私聊使用专用 adapter；连通测试不会读取这里的模型绑定。
              </div>
            )}
            <Field label="AI 模型">
              <select
                value={modelId}
                onChange={(e) => {
                  setModelId(e.target.value);
                  setConnectionTest(null);
                }}
                className={inputCls}
              >
                {modelOptions.length === 0 ? (
                  <option value="">（无可用模型）</option>
                ) : (
                  <>
                    <option value="">（未配置模型，请选择后保存）</option>
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
          <div className="an-rc-title">Prompt 模板</div>
          <Field label={isHttpBot ? "Prompt 模板" : "发送给 plugin 的任务模板"}>
            <select
              value={templateId}
              onChange={(e) => {
                setTemplateId(e.target.value);
                setConnectionTest(null);
              }}
              className={inputCls}
            >
              {templateOptions.length === 0 ? (
                <option value="">（无可用模板）</option>
              ) : (
                <>
                  {isHttpBot && <option value="">（未配置模板，请选择后保存）</option>}
                  {!isHttpBot && <option value="">（使用系统默认模板）</option>}
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
              模板会在后端渲染成最终任务文本，再通过 Agent Bridge 下发给 provider。
            </div>
          )}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <PrimaryButton onClick={() => void save()} disabled={saving}>
            {saving ? "保存中…" : "保存配置"}
          </PrimaryButton>
        </div>
          </>
        )}
        {botTab === "profile" && (
          <>
        <div className="an-row-card" style={{ flexDirection: "column", alignItems: "stretch", gap: 10 }}>
          <div className="an-rc-title">基本信息</div>
          <Field label="显示名称">
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field label="头像">
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
                {avatarUploading ? "上传中…" : "上传"}
              </button>
              {avatarUrl && (
                <button
                  type="button"
                  onClick={() => setAvatarUrl("")}
                  className="an-btn an-btn-sm"
                >
                  清除
                </button>
              )}
            </div>
          </Field>
          <Field label="描述">
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className={`${inputCls} resize-none`}
            />
          </Field>
          <Field label="使用范围">
            <BotScopeControl value={scope} onChange={setScope} disabled={saving} />
          </Field>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            {bot.is_builtin ? (
              <span className="an-rc-sub" style={{ alignSelf: "center" }}>
                内置 Bot 不可删除
              </span>
            ) : (
              <DangerButton onClick={remove} disabled={deleting}>
                {deleting ? "删除中…" : "删除 Bot"}
              </DangerButton>
            )}
            <PrimaryButton onClick={() => void save()} disabled={saving}>
              {saving ? "保存中…" : "保存"}
            </PrimaryButton>
          </div>
        </div>
        <div className="an-row-card an-type-meta">
          高级配置已收敛到设置弹窗；HTTP Bot 可在此切换模型与模板，Agent Bridge Bot 可切换任务模板。
        </div>
          </>
        )}
      </div>
    </div>
  );
}
