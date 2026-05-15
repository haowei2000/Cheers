import { useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import { apiFetch } from "../../../api";
import { AVATAR_ACCEPT, uploadAvatarImage } from "../../../lib/avatar";
import { BotAvatar } from "../../../components/BotAvatar";
import { BotSessionsPanel } from "../../../components/SessionScopePanel";
import {
  ModelBrandCard,
  ModelListSubPane,
  modelBrandName,
} from "../models/ModelListSubPane";
import { TemplateListSubPane } from "../templates/TemplateListSubPane";
import {
  BackBar,
  DangerButton,
  Field,
  PrimaryButton,
  inputCls,
} from "../shared/SettingsControls";

export type BotScope = "private" | "friend" | "everyone";

export type BotRow = {
  bot_id: string;
  username: string;
  display_name?: string | null;
  description?: string | null;
  avatar_url?: string | null;
  status?: string;
  binding_type?: "http" | "agent_bridge" | string;
  connection_status?: string;
  is_online?: boolean;
  control_connected?: boolean | null;
  data_connected?: boolean | null;
  model_id?: string | null;
  template_id?: string | null;
  model_name?: string | null;
  template_name?: string | null;
  is_builtin?: boolean;
  created_by?: string | null;
  scope?: BotScope;
  owner?: {
    user_id: string;
    username: string;
    display_name?: string | null;
  } | null;
  can_manage?: boolean;
};

const BOT_SCOPE_OPTIONS: { value: BotScope; label: string; hint: string }[] = [
  { value: "private", label: "Private", hint: "仅自己可发起私信或邀请" },
  { value: "friend", label: "Friend", hint: "自己和好友可发起私信或邀请" },
  { value: "everyone", label: "Everyone", hint: "所有用户可发起私信或邀请" },
];

function normalizeBotScope(scope?: string | null): BotScope {
  if (scope === "private" || scope === "friend" || scope === "everyone") return scope;
  return "friend";
}

function botScopeLabel(scope?: string | null) {
  const normalized = normalizeBotScope(scope);
  const found = BOT_SCOPE_OPTIONS.find((x) => x.value === normalized);
  return found?.label || "Friend";
}

function botOwnerLabel(bot: Pick<BotRow, "owner" | "created_by">) {
  return bot.owner?.display_name || bot.owner?.username || bot.created_by || "系统";
}

function BotScopeControl({
  value,
  onChange,
  disabled = false,
}: {
  value: BotScope;
  onChange: (scope: BotScope) => void;
  disabled?: boolean;
}) {
  const current = BOT_SCOPE_OPTIONS.find((opt) => opt.value === value) || BOT_SCOPE_OPTIONS[1];
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <div
        className="an-seg"
        role="radiogroup"
        aria-label="Bot 使用范围"
        style={{ display: "inline-flex", justifySelf: "start" }}
      >
        {BOT_SCOPE_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            className={value === opt.value ? "on" : ""}
            onClick={() => onChange(opt.value)}
            disabled={disabled}
            role="radio"
            aria-checked={value === opt.value}
          >
            {opt.label}
          </button>
        ))}
      </div>
      <div className="an-rc-sub" style={{ marginTop: 0 }}>
        {current.hint}
      </div>
    </div>
  );
}

type BotConnectionTestResult = {
  reachable: boolean;
  message?: string;
  checked_at?: string;
  duration_ms?: number;
};

function botOnlineMeta(bot: BotRow) {
  if (bot.is_builtin) {
    const online = bot.is_online !== false && bot.status !== "offline";
    return {
      label: online ? "内置已启用" : "已停用",
      color: online ? "var(--green)" : "var(--fg-3)",
      bg: online ? "var(--green-muted)" : "var(--surface-soft)",
      title: online ? "内置 Bot 使用专用 adapter，不依赖 Bot 的 LLM 绑定" : "Bot 状态为 offline",
    };
  }
  const isWs = (bot.binding_type || "http") === "agent_bridge";
  if (!isWs) {
    const online = bot.is_online !== false && bot.status !== "offline";
    return {
      label: online ? "HTTP 已启用" : "已停用",
      color: online ? "var(--green)" : "var(--fg-3)",
      bg: online ? "var(--green-muted)" : "var(--surface-soft)",
      title: online ? "HTTP Bot 无需长连接；可点击测试连通验证模型 API" : "Bot 状态为 offline",
    };
  }
  if (bot.connection_status === "online" && bot.is_online) {
    return {
      label: "Bridge 在线",
      color: "var(--green)",
      bg: "var(--green-muted)",
      title: "control/data 连接均在线",
    };
  }
  if (bot.connection_status === "partial") {
    return {
      label: "Bridge 部分连接",
      color: "var(--yellow)",
      bg: "rgba(251, 191, 36, 0.16)",
      title: `control: ${bot.control_connected ? "在线" : "离线"} · data: ${bot.data_connected ? "在线" : "离线"}`,
    };
  }
  return {
    label: "Bridge 离线",
    color: "var(--red)",
    bg: "var(--red-muted)",
    title: "Agent Bridge provider 未连接",
  };
}

function BotOnlineBadge({ bot }: { bot: BotRow }) {
  const meta = botOnlineMeta(bot);
  return (
    <span
      title={meta.title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "3px 7px",
        borderRadius: 999,
        background: meta.bg,
        color: meta.color,
        fontSize: 11,
        fontWeight: 650,
        whiteSpace: "nowrap",
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: 999,
          background: meta.color,
          flexShrink: 0,
        }}
      />
      {meta.label}
    </span>
  );
}

// ── Bot panes ─────────────────────────────────────────────────────────────

/** BotPane — top-level Bot view, segmented into three sub-tabs:
 *  Bot (list+CRUD) / 消息模板 / LLM 模型. Each sub-tab is a self-contained
 *  pane that keeps Bot, template, and model setup inside the modal settings
 *  flow. */
type BotSubTab = "bots" | "templates" | "models";

export function BotPane({
  bots,
  authToken,
  onChanged,
}: {
  bots: BotRow[];
  authToken: string | null;
  onChanged: () => void;
}) {
  const [tab, setTab] = useState<BotSubTab>("bots");

  return (
    <div className="an-pane">
      <div
        className="an-seg"
        style={{ marginBottom: 16, display: "inline-flex" }}
        role="tablist"
      >
        <button
          type="button"
          className={tab === "bots" ? "on" : ""}
          onClick={() => setTab("bots")}
          role="tab"
          aria-selected={tab === "bots"}
        >
          Bot
        </button>
        <button
          type="button"
          className={tab === "templates" ? "on" : ""}
          onClick={() => setTab("templates")}
          role="tab"
          aria-selected={tab === "templates"}
        >
          消息模板
        </button>
        <button
          type="button"
          className={tab === "models" ? "on" : ""}
          onClick={() => setTab("models")}
          role="tab"
          aria-selected={tab === "models"}
        >
          LLM 模型
        </button>
      </div>
      {tab === "bots" && (
        <BotListSubPane bots={bots} authToken={authToken} onChanged={onChanged} />
      )}
      {tab === "templates" && <TemplateListSubPane authToken={authToken} />}
      {tab === "models" && <ModelListSubPane authToken={authToken} />}
    </div>
  );
}

/** BotListSubPane — the original "Bot" content (list + drill-down to
 *  create/edit). Lifted out so BotPane can host the segmented switcher. */
function BotListSubPane({
  bots,
  authToken,
  onChanged,
}: {
  bots: BotRow[];
  authToken: string | null;
  onChanged: () => void;
}) {
  const [view, setView] = useState<"list" | "new" | { botId: string }>("list");

  if (view === "new") {
    return (
      <div className="an-pane">
        <BackBar label="返回 Bot 列表" onBack={() => setView("list")} />
        <BotNewPane
          authToken={authToken}
          onCreated={(b) => {
            onChanged();
            setView({ botId: b.bot_id });
          }}
        />
      </div>
    );
  }

  if (typeof view === "object") {
    const bot = bots.find((b) => b.bot_id === view.botId);
    if (!bot) {
      return (
        <div className="an-pane">
          <BackBar label="返回 Bot 列表" onBack={() => setView("list")} />
          <div className="an-row-card" style={{ color: "var(--fg-3)" }}>
            该 Bot 已不存在
          </div>
        </div>
      );
    }
    return (
      <div className="an-pane">
        <BackBar label="返回 Bot 列表" onBack={() => setView("list")} />
        <BotEditPane
          bot={bot}
          authToken={authToken}
          onUpdated={onChanged}
          onDeleted={() => {
            onChanged();
            setView("list");
          }}
        />
      </div>
    );
  }

  return (
    <div className="an-pane">
      <div className="an-pane-head">
        <div>
          <div className="an-pane-title">Bot</div>
          <div className="an-pane-sub">
            管理你的 Bot。点击卡片查看详情或编辑。
          </div>
        </div>
        <button
          type="button"
          onClick={onChanged}
          style={{
            border: "1px solid var(--border)",
            background: "var(--surface)",
            color: "var(--fg-2)",
            borderRadius: 6,
            padding: "6px 10px",
            fontSize: 12,
            fontFamily: "inherit",
            cursor: "pointer",
            whiteSpace: "nowrap",
          }}
        >
          刷新状态
        </button>
      </div>
      <div className="an-list-table">
        <button
          type="button"
          className="an-row-card"
          style={{ width: "100%", textAlign: "left", cursor: "pointer", fontFamily: "inherit" }}
          onClick={() => setView("new")}
        >
          <span
            style={{
              width: 32,
              height: 32,
              borderRadius: 6,
              background: "var(--surface-soft)",
              color: "var(--accent)",
              fontSize: 16,
              display: "inline-grid",
              placeItems: "center",
              flexShrink: 0,
            }}
          >
            ＋
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="an-rc-title">新建 Bot</div>
            <div className="an-rc-sub">创建一个新的频道 Bot</div>
          </div>
          <span style={{ color: "var(--fg-3)", fontSize: 12 }}>›</span>
        </button>
        {bots.length === 0 ? (
          <div className="an-row-card" style={{ justifyContent: "center", color: "var(--fg-3)" }}>
            暂无 Bot
          </div>
        ) : (
          bots.map((b) => (
            <button
              key={b.bot_id}
              type="button"
              className="an-row-card"
              style={{ width: "100%", textAlign: "left", cursor: "pointer", fontFamily: "inherit" }}
              onClick={() => setView({ botId: b.bot_id })}
            >
              <BotAvatar
                label={b.display_name || b.username || "Bot"}
                avatarUrl={b.avatar_url}
                brandName={b.model_name || b.display_name || b.username}
                size={32}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="an-rc-title">{b.display_name || b.username}</div>
                <div className="an-rc-sub">
                  @{b.username} · {(b.binding_type || "http") === "agent_bridge" ? "WebSocket" : "HTTP"}
                  {" · "}
                  {botScopeLabel(b.scope)}
                  {" · "}
                  Owner: {botOwnerLabel(b)}
                  {b.is_builtin ? " · 内置" : ""}
                </div>
              </div>
              <BotOnlineBadge bot={b} />
              <span style={{ color: "var(--fg-3)", fontSize: 12 }}>›</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

type BindingType = "http" | "agent_bridge";

type ModelItem = { model_id: string; name: string; model_name?: string; provider?: string; is_enabled?: boolean };
type TemplateItem = { template_id: string; name: string };

/** BotNewPane — two-step wizard.
 *  Step 1: pick the binding type (HTTP / Agent Bridge).
 *  Step 2: render type-specific fields. HTTP needs a model; both types can
 *  pick a prompt template. */
function BotNewPane({
  authToken,
  onCreated,
}: {
  authToken: string | null;
  onCreated: (b: BotRow) => void;
}) {
  const [step, setStep] = useState<1 | 2>(1);
  const [bindingType, setBindingType] = useState<BindingType>("http");

  // Shared base fields
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [avatarUrl, setAvatarUrl] = useState("");
  const [scope, setScope] = useState<BotScope>("friend");

  // HTTP-only model binding + shared prompt template selection
  const [models, setModels] = useState<ModelItem[]>([]);
  const [templates, setTemplates] = useState<TemplateItem[]>([]);
  const [modelId, setModelId] = useState("");
  const [templateId, setTemplateId] = useState("");

  // Agent Bridge-only
  const [agentId, setAgentId] = useState("");

  const [creating, setCreating] = useState(false);

  // Set after a successful Agent Bridge bot creation: holds the one-shot
  // plaintext token returned by the backend so the user can copy it into
  // their provider config before we navigate away.
  const [issued, setIssued] = useState<{ token: string; bot: BotRow } | null>(null);
  const selectedModel = models.find((m) => m.model_id === modelId);

  // Lazy-load models/templates when entering step 2.
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
                style={{
                  flex: 1,
                  padding: "8px 10px",
                  background: "var(--bg-0)",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  fontSize: 12,
                  color: "var(--fg-1)",
                  userSelect: "all",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
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
                style={{
                  padding: "8px 12px",
                  background: "var(--surface-soft)",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  fontSize: 12,
                  color: "var(--fg-2)",
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
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
              style={{
                background: "transparent",
                border: 0,
                color: "var(--accent)",
                fontSize: 12,
                padding: 0,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              ← 重新选择类型
            </button>
          </div>
        </div>
      </div>
      <div className="an-list-table">
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

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
          <button
            type="button"
            onClick={() => setStep(1)}
            style={{
              padding: "8px 12px",
              background: "transparent",
              border: "1px solid var(--border)",
              borderRadius: 6,
              fontSize: 13,
              color: "var(--fg-2)",
              cursor: "pointer",
              fontFamily: "inherit",
            }}
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

function BotEditPane({
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

  // Reset form when switching between bots
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
      <div className="an-pane-head">
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
        <BotOnlineBadge bot={bot} />
      </div>
      <div className="an-list-table">
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
              style={{
                border: "1px solid var(--border)",
                borderRadius: 6,
                padding: "8px 10px",
                background: connectionTest.reachable ? "var(--green-muted)" : "var(--red-muted)",
                color: connectionTest.reachable ? "var(--green)" : "var(--red)",
                fontSize: 12,
                lineHeight: 1.5,
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
                style={{
                  padding: "8px 10px",
                  background: "var(--surface-soft)",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  fontSize: 12,
                  color: "var(--fg-2)",
                  cursor: avatarUploading ? "not-allowed" : "pointer",
                  opacity: avatarUploading ? 0.6 : 1,
                  fontFamily: "inherit",
                  whiteSpace: "nowrap",
                }}
              >
                {avatarUploading ? "上传中…" : "上传"}
              </button>
              {avatarUrl && (
                <button
                  type="button"
                  onClick={() => setAvatarUrl("")}
                  style={{
                    padding: "8px 10px",
                    background: "var(--surface-soft)",
                    border: "1px solid var(--border)",
                    borderRadius: 6,
                    fontSize: 12,
                    color: "var(--fg-2)",
                    cursor: "pointer",
                    fontFamily: "inherit",
                    whiteSpace: "nowrap",
                  }}
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
        <div className="an-row-card" style={{ color: "var(--fg-3)", fontSize: 12 }}>
          高级配置已收敛到设置弹窗；HTTP Bot 可在此切换模型与模板，Agent Bridge Bot 可切换任务模板。
        </div>
      </div>
    </div>
  );
}
