import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { apiFetch } from "../../../api";
import { BotAvatar } from "../../../components/BotAvatar";
import {
  ModelBrandCard,
  modelBrandName,
} from "../models/ModelListSubPane";
import {
  Field,
  PrimaryButton,
  inputCls,
} from "../shared/SettingsControls";
import { BotScopeControl } from "./BotShared";
import type { BindingType, BotRow, BotScope, ModelItem, TemplateItem } from "./types";

type BotNewConfigTab = "profile" | "runtime";

export function BotNewPane({
  authToken,
  onCreated,
}: {
  authToken: string | null;
  onCreated: (b: BotRow) => void;
}) {
  const [step, setStep] = useState<1 | 2>(1);
  const [bindingType, setBindingType] = useState<BindingType>("http");

  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [avatarUrl, setAvatarUrl] = useState("");
  const [scope, setScope] = useState<BotScope>("friend");

  const [models, setModels] = useState<ModelItem[]>([]);
  const [templates, setTemplates] = useState<TemplateItem[]>([]);
  const [modelId, setModelId] = useState("");
  const [templateId, setTemplateId] = useState("");

  const [agentId, setAgentId] = useState("");
  const [creating, setCreating] = useState(false);
  const [issued, setIssued] = useState<{ token: string; bot: BotRow } | null>(null);
  const selectedModel = models.find((m) => m.model_id === modelId);
  const [configTab, setConfigTab] = useState<BotNewConfigTab>("profile");

  useEffect(() => {
    if (step !== 2) return;
    if (bindingType === "http") {
      apiFetch("/admin/models?include_disabled=false", { token: authToken })
        .then((r) => r.json())
        .then((d) => {
          const list: ModelItem[] = Array.isArray(d?.data) ? d.data : [];
          setModels(list);
          if (!modelId && list.length > 0) setModelId(list[0].model_id);
        })
        .catch(() => setModels([]));
    } else {
      setModels([]);
    }
    apiFetch("/templates", { token: authToken })
      .then((r) => r.json())
      .then((d) => {
        const list: TemplateItem[] = Array.isArray(d?.data) ? d.data : [];
        setTemplates(list);
        if (!templateId && list.length > 0) setTemplateId(list[0].template_id);
      })
      .catch(() => setTemplates([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, bindingType, authToken]);

  const create = async () => {
    if (!username.trim()) {
      toast.error("用户名必填");
      return;
    }
    if (bindingType === "http" && (!modelId || !templateId)) {
      toast.error("HTTP Bot 必须选择模型和模板");
      return;
    }
    const body: Record<string, unknown> = {
      username: username.trim(),
      display_name: displayName.trim() || username.trim(),
      description: description.trim() || null,
      avatar_url: avatarUrl.trim() || null,
      binding_type: bindingType,
      status: "online",
      scope,
    };
    if (bindingType === "http") {
      body.model_id = modelId;
      body.template_id = templateId;
    } else {
      if (templateId) body.template_id = templateId;
      const cfg: Record<string, string> = {};
      if (agentId.trim()) cfg.agent_id = agentId.trim();
      body.binding_config = Object.keys(cfg).length > 0 ? cfg : null;
    }
    setCreating(true);
    try {
      const res = await apiFetch("/bots", {
        method: "POST",
        token: authToken,
        body,
      });
      const data = await res.json();
      if (data?.status === "success") {
        toast.success("Bot 创建成功");
        const created = data.data as BotRow & { bot_token?: string | null };
        if (bindingType === "agent_bridge" && created?.bot_token) {
          setIssued({ token: created.bot_token, bot: created });
        } else {
          onCreated(created);
        }
      } else {
        toast.error(data?.message || data?.detail || "创建失败");
      }
    } catch (e: unknown) {
      toast.error((e as Error).message || "创建失败");
    } finally {
      setCreating(false);
    }
  };

  if (issued) {
    return (
      <div className="an-pane">
        <div className="an-pane-head">
          <div>
            <div className="an-pane-title">Bot 已创建 · 保存 Agent Bridge Token</div>
            <div className="an-pane-sub">
              这是一次性明文 token，关闭此页面后将无法再查看。请立即复制并填入
              Agent Bridge provider 配置；之后只能通过"轮换 token"重新生成。
            </div>
          </div>
        </div>
        <div className="an-list-table">
          <div className="an-row-card" style={{ flexDirection: "column", alignItems: "stretch", gap: 10 }}>
            <div className="an-rc-title">Bot Token</div>
            <div style={{ display: "flex", gap: 6 }}>
              <code
                className="an-code-pill"
                style={{
                  flex: 1,
                }}
              >
                {issued.token}
              </code>
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard.writeText(issued.token);
                  toast.success("Token 已复制");
                }}
                className="an-btn an-btn-sm"
              >
                复制
              </button>
            </div>
            <div className="an-rc-sub" style={{ marginTop: 0 }}>
              在 plugin 端用
              <code style={{ background: "var(--surface-soft)", padding: "0 4px", borderRadius: 3, margin: "0 2px" }}>
                Authorization: Bearer {"<token>"}
              </code>
              连接
              <code style={{ background: "var(--surface-soft)", padding: "0 4px", borderRadius: 3, margin: "0 2px" }}>
                /ws/agent-bridge/control
              </code>
              和
              <code style={{ background: "var(--surface-soft)", padding: "0 4px", borderRadius: 3, margin: "0 2px" }}>
                /ws/agent-bridge/data
              </code>
              即可接管该 Bot。
            </div>
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <PrimaryButton onClick={() => onCreated(issued.bot)}>完成</PrimaryButton>
          </div>
        </div>
      </div>
    );
  }

  if (step === 1) {
    return (
      <div className="an-pane">
        <div className="an-pane-head">
          <div>
            <div className="an-pane-title">新建 Bot · 选择类型</div>
            <div className="an-pane-sub">不同类型的 Bot 需要不同的配置项。</div>
          </div>
        </div>
        <div className="an-list-table">
          <BindingTypeCard
            id="http"
            active={bindingType === "http"}
            title="HTTP Bot"
            sub="由后端调用 LLM provider，需要绑定 AI 模型与 Prompt 模板。"
            onClick={() => setBindingType("http")}
          />
          <BindingTypeCard
            id="agent_bridge"
            active={bindingType === "agent_bridge"}
            title="Agent Bridge Bot"
            sub="由外部 provider 反向连接并异步回推，可绑定 Prompt 模板。"
            onClick={() => setBindingType("agent_bridge")}
          />
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <PrimaryButton onClick={() => setStep(2)}>下一步 →</PrimaryButton>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="an-pane">
      <div className="an-pane-head">
        <div>
          <div className="an-pane-title">
            新建 Bot · {bindingType === "http" ? "HTTP" : "Agent Bridge"} 配置
          </div>
          <div className="an-pane-sub">
            <button
            type="button"
            onClick={() => setStep(1)}
            className="an-back"
          >
              ← 重新选择类型
            </button>
          </div>
        </div>
        <div className="an-seg" role="tablist" aria-label="新建 Bot 配置视图">
          <button
            type="button"
            className={configTab === "profile" ? "on" : ""}
            onClick={() => setConfigTab("profile")}
            role="tab"
            aria-selected={configTab === "profile"}
          >
            资料
          </button>
          <button
            type="button"
            className={configTab === "runtime" ? "on" : ""}
            onClick={() => setConfigTab("runtime")}
            role="tab"
            aria-selected={configTab === "runtime"}
          >
            配置
          </button>
        </div>
      </div>
      <div className="an-list-table">
        {configTab === "profile" && (
        <div className="an-row-card" style={{ flexDirection: "column", alignItems: "stretch", gap: 10 }}>
          <div className="an-rc-title">基本信息</div>
          <Field label="用户名（@后跟的标识）">
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className={inputCls}
              placeholder="如 helper"
            />
          </Field>
          <Field label="显示名称">
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className={inputCls}
              placeholder="如 频道助手"
            />
          </Field>
          <Field label="头像 URL">
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <BotAvatar
                label={displayName || username || "Bot"}
                avatarUrl={avatarUrl}
                brandName={modelBrandName(selectedModel) || displayName || username}
                size={36}
              />
              <input
                value={avatarUrl}
                onChange={(e) => setAvatarUrl(e.target.value)}
                className={inputCls}
                placeholder="https://example.com/bot.png"
                style={{ flex: 1 }}
              />
            </div>
          </Field>
          <Field label="描述（可选）">
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className={`${inputCls} resize-none`}
            />
          </Field>
          <Field label="使用范围">
            <BotScopeControl value={scope} onChange={setScope} disabled={creating} />
          </Field>
        </div>
        )}

        {configTab === "runtime" && (
          <>
        {bindingType === "http" && (
          <div className="an-row-card" style={{ flexDirection: "column", alignItems: "stretch", gap: 10 }}>
            <div className="an-rc-title">LLM 模型</div>
            <ModelBrandCard model={selectedModel} />
            <Field label="AI 模型">
              <select
                value={modelId}
                onChange={(e) => setModelId(e.target.value)}
                className={inputCls}
              >
                {models.length === 0 ? (
                  <option value="">（无可用模型，请先在设置的 LLM 模型中创建）</option>
                ) : (
                  models.map((m) => (
                    <option key={m.model_id} value={m.model_id}>
                      {m.name}
                    </option>
                  ))
                )}
              </select>
            </Field>
          </div>
        )}

        <div className="an-row-card" style={{ flexDirection: "column", alignItems: "stretch", gap: 10 }}>
          <div className="an-rc-title">Prompt 模板</div>
          <Field label={bindingType === "agent_bridge" ? "发送给 plugin 的任务模板" : "Prompt 模板"}>
            <select
              value={templateId}
              onChange={(e) => setTemplateId(e.target.value)}
              className={inputCls}
            >
              {templates.length === 0 ? (
                <option value="">（无可用模板，请先在设置的消息模板中创建）</option>
              ) : (
                templates.map((t) => (
                  <option key={t.template_id} value={t.template_id}>
                    {t.name}
                  </option>
                ))
              )}
            </select>
          </Field>
          {bindingType === "agent_bridge" && (
            <div className="an-rc-sub" style={{ marginTop: 0 }}>
              模板会在后端渲染成最终任务文本，再通过 Agent Bridge 下发给 provider。
            </div>
          )}
        </div>

        {bindingType === "agent_bridge" && (
          <div className="an-row-card" style={{ flexDirection: "column", alignItems: "stretch", gap: 10 }}>
            <div className="an-rc-title">Agent Bridge 绑定</div>
            <div className="an-rc-sub" style={{ marginTop: 0 }}>
              创建后将得到一次性的 bot token，把它填到 plugin 配置里，plugin 连
              <code style={{ background: "var(--surface-soft)", padding: "0 4px", borderRadius: 3, margin: "0 2px" }}>
                /ws/agent-bridge/control
              </code>
              和
              <code style={{ background: "var(--surface-soft)", padding: "0 4px", borderRadius: 3, margin: "0 2px" }}>
                /ws/agent-bridge/data
              </code>
              即可接管该 Bot。
            </div>
            <Field label="Provider agent id（可选）">
              <input
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
                className={inputCls}
                placeholder="如 agent-codereview"
              />
            </Field>
          </div>
        )}
          </>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
          <button
            type="button"
            onClick={() => setStep(1)}
            className="an-btn"
          >
            上一步
          </button>
          <PrimaryButton onClick={create} disabled={creating || !username.trim()}>
            {creating ? "创建中…" : "创建"}
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}

function BindingTypeCard({
  id,
  active,
  title,
  sub,
  onClick,
}: {
  id: string;
  active: boolean;
  title: string;
  sub: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="an-row-card"
      style={{
        width: "100%",
        textAlign: "left",
        cursor: "pointer",
        fontFamily: "inherit",
        borderColor: active ? "var(--accent)" : "var(--border)",
        background: active ? "var(--accent-muted)" : "var(--bg-0)",
      }}
      onClick={onClick}
      aria-pressed={active}
      data-id={id}
    >
      <span
        style={{
          width: 16,
          height: 16,
          borderRadius: "50%",
          border: `2px solid ${active ? "var(--accent)" : "var(--border-strong)"}`,
          background: active ? "var(--accent)" : "transparent",
          flexShrink: 0,
          marginTop: 2,
        }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="an-rc-title">{title}</div>
        <div className="an-rc-sub">{sub}</div>
      </div>
    </button>
  );
}
