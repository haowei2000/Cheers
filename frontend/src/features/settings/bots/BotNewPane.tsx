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
import {
  BOT_MENTION_ID_HINT,
  BotScopeControl,
  isValidBotMentionId,
  normalizeBotMentionId,
} from "./BotShared";
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
    const mentionId = normalizeBotMentionId(username);
    if (!mentionId) {
      toast.error("Bot @ ID is required");
      return;
    }
    if (!isValidBotMentionId(mentionId)) {
      toast.error(BOT_MENTION_ID_HINT);
      return;
    }
    if (bindingType === "http" && (!modelId || !templateId)) {
      toast.error("HTTP bots require a model and template");
      return;
    }
    const body: Record<string, unknown> = {
      username: mentionId,
      display_name: displayName.trim() || mentionId,
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
        toast.success("Bot created successfully");
        const created = data.data as BotRow & { bot_token?: string | null };
        if (bindingType === "agent_bridge" && created?.bot_token) {
          setIssued({ token: created.bot_token, bot: created });
        } else {
          onCreated(created);
        }
      } else {
        toast.error(data?.message || data?.detail || "Create failed");
      }
    } catch (e: unknown) {
      toast.error((e as Error).message || "Create failed");
    } finally {
      setCreating(false);
    }
  };

  if (issued) {
    return (
      <div className="an-pane">
        <div className="an-pane-head">
          <div>
            <div className="an-pane-title">Bot created · Save Agent Bridge Token</div>
            <div className="an-pane-sub">
              This plain-text token is shown only once. After closing this page, it cannot be viewed again. Copy it now and put it in
              the Agent Bridge provider configuration. After that, you can only regenerate it by rotating the token.
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
                  toast.success("Token copied");
                }}
                className="an-btn an-btn-sm"
              >
                Copy
              </button>
            </div>
            <div className="an-rc-sub" style={{ marginTop: 0 }}>
              In the plugin, use
              <code style={{ background: "var(--surface-soft)", padding: "0 4px", borderRadius: 3, margin: "0 2px" }}>
                Authorization: Bearer {"<token>"}
              </code>
              Connect
              <code style={{ background: "var(--surface-soft)", padding: "0 4px", borderRadius: 3, margin: "0 2px" }}>
                /ws/agent-bridge/control
              </code>
              and
              <code style={{ background: "var(--surface-soft)", padding: "0 4px", borderRadius: 3, margin: "0 2px" }}>
                /ws/agent-bridge/data
              </code>
              to take over this bot.
            </div>
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <PrimaryButton onClick={() => onCreated(issued.bot)}>Done</PrimaryButton>
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
            <div className="an-pane-title">New bot · choose type</div>
            <div className="an-pane-sub">Different bot types require different settings.</div>
          </div>
        </div>
        <div className="an-list-table">
          <BindingTypeCard
            id="http"
            active={bindingType === "http"}
            title="HTTP Bot"
            sub="The backend calls an LLM provider and requires an AI model plus a prompt template."
            onClick={() => setBindingType("http")}
          />
          <BindingTypeCard
            id="agent_bridge"
            active={bindingType === "agent_bridge"}
            title="Agent Bridge Bot"
            sub="An external provider connects back and pushes results asynchronously. A prompt template can be bound."
            onClick={() => setBindingType("agent_bridge")}
          />
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <PrimaryButton onClick={() => setStep(2)}>Next →</PrimaryButton>
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
            New bot · {bindingType === "http" ? "HTTP" : "Agent Bridge"} Configuration
          </div>
          <div className="an-pane-sub">
            <button
            type="button"
            onClick={() => setStep(1)}
            className="an-back"
          >
              ← Choose type again
            </button>
          </div>
        </div>
        <div className="an-seg" role="tablist" aria-label="New bot configuration view">
          <button
            type="button"
            className={configTab === "profile" ? "on" : ""}
            onClick={() => setConfigTab("profile")}
            role="tab"
            aria-selected={configTab === "profile"}
          >
            Profile
          </button>
          <button
            type="button"
            className={configTab === "runtime" ? "on" : ""}
            onClick={() => setConfigTab("runtime")}
            role="tab"
            aria-selected={configTab === "runtime"}
          >
            Configuration
          </button>
        </div>
      </div>
      <div className="an-list-table">
        {configTab === "profile" && (
        <div className="an-row-card" style={{ flexDirection: "column", alignItems: "stretch", gap: 10 }}>
          <div className="an-rc-title">Basic information</div>
          <Field label="Username (the @ handle)">
            <input
              value={username}
              onChange={(e) => setUsername(normalizeBotMentionId(e.target.value))}
              className={inputCls}
              placeholder="e.g. helper"
            />
            <div className="an-rc-sub" style={{ marginTop: 4 }}>
              {BOT_MENTION_ID_HINT}
            </div>
          </Field>
          <Field label="Display name">
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className={inputCls}
              placeholder="e.g. channel-helper"
            />
          </Field>
          <Field label="Avatar URL">
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
          <Field label="Description (optional)">
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className={`${inputCls} resize-none`}
            />
          </Field>
          <Field label="Scope">
            <BotScopeControl value={scope} onChange={setScope} disabled={creating} />
          </Field>
        </div>
        )}

        {configTab === "runtime" && (
          <>
        {bindingType === "http" && (
          <div className="an-row-card" style={{ flexDirection: "column", alignItems: "stretch", gap: 10 }}>
            <div className="an-rc-title">LLM models</div>
            <ModelBrandCard model={selectedModel} />
            <Field label="AI model">
              <select
                value={modelId}
                onChange={(e) => setModelId(e.target.value)}
                className={inputCls}
              >
                {models.length === 0 ? (
                  <option value="">(No models available. Create one in Settings &gt; LLM models first.)</option>
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
          <div className="an-rc-title">Prompt template</div>
          <Field label={bindingType === "agent_bridge" ? "Task template sent to the plugin" : "Prompt template"}>
            <select
              value={templateId}
              onChange={(e) => setTemplateId(e.target.value)}
              className={inputCls}
            >
              {templates.length === 0 ? (
                <option value="">(No templates available. Create one in Settings &gt; Message templates first.)</option>
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
              The backend renders the template into final task text, then sends it to the provider through Agent Bridge.
            </div>
          )}
        </div>

        {bindingType === "agent_bridge" && (
          <div className="an-row-card" style={{ flexDirection: "column", alignItems: "stretch", gap: 10 }}>
            <div className="an-rc-title">Agent Bridge binding</div>
            <div className="an-rc-sub" style={{ marginTop: 0 }}>
              After creation, you will receive a one-time bot token. Put it in the plugin config and connect the plugin to
              <code style={{ background: "var(--surface-soft)", padding: "0 4px", borderRadius: 3, margin: "0 2px" }}>
                /ws/agent-bridge/control
              </code>
              and
              <code style={{ background: "var(--surface-soft)", padding: "0 4px", borderRadius: 3, margin: "0 2px" }}>
                /ws/agent-bridge/data
              </code>
              to take over this bot.
            </div>
            <Field label="Provider agent ID (optional)">
              <input
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
                className={inputCls}
                placeholder="e.g. agent-codereview"
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
            Back
          </button>
          <PrimaryButton onClick={create} disabled={creating || !normalizeBotMentionId(username)}>
            {creating ? "Creating..." : "Create"}
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
