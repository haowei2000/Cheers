import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { apiFetch } from "../../../api";
import { AiBrandIcon } from "../../../components/icons";
import {
  BackBar,
  DangerButton,
  Field,
  PrimaryButton,
  inputCls,
} from "../shared/SettingsControls";

export type ModelRow = {
  model_id: string;
  name: string;
  provider: string;
  model_name: string;
  base_url: string;
  api_key_masked?: string;
  description?: string | null;
  is_enabled: boolean;
  is_builtin?: boolean;
  is_public?: boolean;
  config?: Record<string, unknown>;
};

export type ModelIdentity = {
  name?: string | null;
  provider?: string | null;
  model_name?: string | null;
};

export function modelBrandName(model?: ModelIdentity | null): string {
  if (!model) return "";
  return [model.provider, model.model_name, model.name].filter(Boolean).join(" ");
}

export function ModelBrandCard({ model }: { model?: ModelIdentity | null }) {
  if (!model) return null;

  return (
    <div
      style={{
        alignItems: "center",
        background: "var(--bg-0)",
        border: "1px solid var(--border)",
        borderRadius: 6,
        display: "flex",
        gap: 8,
        padding: "8px 10px",
      }}
    >
      <AiBrandIcon
        name={modelBrandName(model)}
        fallbackLabel={model.provider || model.name || "AI"}
        size={20}
      />
      <div style={{ minWidth: 0 }}>
        <div className="truncate" style={{ color: "var(--fg-1)", fontSize: 12, fontWeight: 650 }}>
          {model.name}
        </div>
        <div className="truncate" style={{ color: "var(--fg-3)", fontSize: 11 }}>
          {[model.provider, model.model_name].filter(Boolean).join(" · ")}
        </div>
      </div>
    </div>
  );
}

export function ModelListSubPane({ authToken }: { authToken: string | null }) {
  const [items, setItems] = useState<ModelRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<"list" | "new" | { id: string }>("list");

  const reload = () => {
    setLoading(true);
    apiFetch("/admin/models?include_disabled=true", { token: authToken })
      .then((r) => r.json())
      .then((d) => setItems(Array.isArray(d?.data) ? d.data : []))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authToken]);

  if (view === "new") {
    return (
      <div className="an-pane">
        <BackBar label="返回模型列表" onBack={() => setView("list")} />
        <ModelForm
          authToken={authToken}
          onSaved={() => {
            reload();
            setView("list");
          }}
        />
      </div>
    );
  }
  if (typeof view === "object") {
    const m = items.find((x) => x.model_id === view.id);
    if (!m) {
      return (
        <div className="an-pane">
          <BackBar label="返回模型列表" onBack={() => setView("list")} />
          <div className="an-row-card" style={{ color: "var(--fg-3)" }}>该模型已不存在</div>
        </div>
      );
    }
    return (
      <div className="an-pane">
        <BackBar label="返回模型列表" onBack={() => setView("list")} />
        <ModelForm
          authToken={authToken}
          existing={m}
          onSaved={() => {
            reload();
            setView("list");
          }}
          onDeleted={() => {
            reload();
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
          <div className="an-pane-title">LLM 模型</div>
          <div className="an-pane-sub">配置可供 Bot 绑定的 LLM Provider。</div>
        </div>
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
              width: 32, height: 32, borderRadius: 6,
              background: "var(--surface-soft)", color: "var(--accent)",
              fontSize: 16, display: "inline-grid", placeItems: "center", flexShrink: 0,
            }}
          >＋</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="an-rc-title">新建模型</div>
            <div className="an-rc-sub">添加一个 OpenAI 兼容的 LLM Provider</div>
          </div>
          <span style={{ color: "var(--fg-3)", fontSize: 12 }}>›</span>
        </button>
        {loading ? (
          <div className="an-row-card" style={{ justifyContent: "center", color: "var(--fg-3)" }}>加载中…</div>
        ) : items.length === 0 ? (
          <div className="an-row-card" style={{ justifyContent: "center", color: "var(--fg-3)" }}>暂无模型</div>
        ) : (
          items.map((m) => (
            <button
              key={m.model_id}
              type="button"
              className="an-row-card"
              style={{ width: "100%", textAlign: "left", cursor: "pointer", fontFamily: "inherit" }}
              onClick={() => setView({ id: m.model_id })}
            >
              <span
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 10,
                  background: "var(--bg-0)",
                  border: "1px solid var(--border)",
                  display: "inline-grid",
                  placeItems: "center",
                  flexShrink: 0,
                }}
              >
                <AiBrandIcon
                  name={modelBrandName(m)}
                  fallbackLabel={m.provider}
                  size={22}
                  title={`${m.provider} · ${m.model_name}`}
                />
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="an-rc-title">
                  {m.name}
                  <span style={{
                    fontSize: 9, fontWeight: 700, letterSpacing: "0.5px",
                    padding: "1px 5px", borderRadius: 3,
                    background: "var(--surface-soft)", color: "var(--fg-3)",
                    border: "1px solid var(--border)",
                  }}>{m.provider}</span>
                  {!m.is_enabled && (
                    <span style={{
                      fontSize: 9, fontWeight: 700, letterSpacing: "0.5px",
                      padding: "1px 5px", borderRadius: 3,
                      background: "var(--surface-soft)", color: "var(--red)",
                      border: "1px solid var(--red)",
                    }}>DISABLED</span>
                  )}
                </div>
                <div className="an-rc-sub">{m.model_name} · {m.base_url}</div>
              </div>
              <span style={{ color: "var(--fg-3)", fontSize: 12 }}>›</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

function ModelForm({
  authToken,
  existing,
  onSaved,
  onDeleted,
}: {
  authToken: string | null;
  existing?: ModelRow;
  onSaved: () => void;
  onDeleted?: () => void;
}) {
  const isEdit = !!existing;
  const isBuiltin = !!existing?.is_builtin;
  const cfg = (existing?.config || {}) as Record<string, unknown>;
  const [name, setName] = useState(existing?.name || "");
  const [provider, setProvider] = useState(existing?.provider || "ollama");
  const [modelName, setModelName] = useState(existing?.model_name || "");
  const [baseUrl, setBaseUrl] = useState(existing?.base_url || "");
  const [apiKey, setApiKey] = useState("");
  const [description, setDescription] = useState(existing?.description || "");
  const [isEnabled, setIsEnabled] = useState(existing?.is_enabled ?? true);
  const [isPublic, setIsPublic] = useState(existing?.is_public ?? true);
  const [supportsVision, setSupportsVision] = useState(!!cfg.supports_vision);
  const [temperature, setTemperature] = useState<number>(
    typeof cfg.temperature === "number" ? cfg.temperature : 0.7,
  );
  const [maxTokens, setMaxTokens] = useState<number>(
    typeof cfg.max_tokens === "number" ? cfg.max_tokens : 4096,
  );
  const [stream, setStream] = useState<boolean>(
    typeof cfg.stream === "boolean" ? cfg.stream : true,
  );
  const [extraHeaders, setExtraHeaders] = useState(
    cfg.extra_headers && typeof cfg.extra_headers === "object"
      ? JSON.stringify(cfg.extra_headers)
      : "",
  );
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const save = async () => {
    if (!name.trim() || !modelName.trim() || !baseUrl.trim()) {
      toast.error("请填写必填项（名称 / 模型名 / Base URL）");
      return;
    }
    let parsedHeaders: Record<string, string> | null = null;
    if (extraHeaders.trim()) {
      try {
        parsedHeaders = JSON.parse(extraHeaders);
      } catch {
        toast.error("额外 Headers 必须是合法 JSON 对象");
        return;
      }
    }
    const config: Record<string, unknown> = {
      temperature,
      max_tokens: maxTokens,
      stream,
    };
    if (parsedHeaders) config.extra_headers = parsedHeaders;
    if (supportsVision) config.supports_vision = true;
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        name: name.trim(),
        provider,
        model_name: modelName.trim(),
        base_url: baseUrl.trim(),
        description: description.trim(),
        is_enabled: isEnabled,
        is_public: isPublic,
        config,
      };
      if (apiKey.trim()) body.api_key = apiKey.trim();
      const res = await apiFetch(
        isEdit ? `/admin/models/${existing!.model_id}` : "/admin/models",
        {
          method: isEdit ? "PATCH" : "POST",
          token: authToken,
          body,
        },
      );
      const data = await res.json();
      if (data?.status === "success") {
        toast.success(isEdit ? "已更新" : "已创建");
        onSaved();
      } else {
        toast.error(data?.message || data?.detail || (isEdit ? "更新失败" : "创建失败"));
      }
    } catch (e: unknown) {
      toast.error((e as Error).message || "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!existing) return;
    if (!confirm(`确定删除「${existing.name}」？`)) return;
    setDeleting(true);
    try {
      const res = await apiFetch(`/admin/models/${existing.model_id}`, {
        method: "DELETE",
        token: authToken,
      });
      const data = await res.json();
      if (data?.status === "success") {
        toast.success("已删除");
        onDeleted?.();
      } else {
        toast.error(data?.message || data?.detail || "删除失败");
      }
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="an-pane">
      <div className="an-pane-head">
        <div>
          <div className="an-pane-title">{isEdit ? existing!.name : "新建模型"}</div>
          {isBuiltin && <div className="an-pane-sub">系统内置（只读）</div>}
        </div>
      </div>
      <div className="an-list-table">
        <div className="an-row-card" style={{ flexDirection: "column", alignItems: "stretch", gap: 10 }}>
          <div className="an-rc-title">基本信息</div>
          <Field label="名称">
            <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} disabled={isBuiltin} />
          </Field>
          <Field label="Provider">
            <select value={provider} onChange={(e) => setProvider(e.target.value)} className={inputCls} disabled={isBuiltin}>
              <option value="ollama">Ollama</option>
              <option value="openai">OpenAI 兼容</option>
              <option value="anthropic">Anthropic</option>
              <option value="azure">Azure OpenAI</option>
              <option value="custom">自定义</option>
            </select>
          </Field>
          <Field label="模型名（model_name，发给 provider）">
            <input value={modelName} onChange={(e) => setModelName(e.target.value)} className={inputCls} placeholder="如 llama3.2" disabled={isBuiltin} />
          </Field>
          <Field label="Base URL">
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} className={inputCls} placeholder="如 http://localhost:11434/v1" disabled={isBuiltin} />
          </Field>
          <Field label={isEdit ? "API Key（留空则不修改）" : "API Key"}>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className={inputCls}
              placeholder={existing?.api_key_masked || "可选"}
              disabled={isBuiltin}
            />
          </Field>
          <Field label="描述">
            <input value={description} onChange={(e) => setDescription(e.target.value)} className={inputCls} disabled={isBuiltin} />
          </Field>
        </div>

        <div className="an-row-card" style={{ flexDirection: "column", alignItems: "stretch", gap: 10 }}>
          <div className="an-rc-title">推理参数</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Field label={`Temperature (${temperature})`}>
              <input
                type="number" step="0.1" min={0} max={2}
                value={temperature}
                onChange={(e) => setTemperature(Number(e.target.value))}
                className={inputCls}
                disabled={isBuiltin}
              />
            </Field>
            <Field label="Max Tokens">
              <input
                type="number" min={64}
                value={maxTokens}
                onChange={(e) => setMaxTokens(Number(e.target.value))}
                className={inputCls}
                disabled={isBuiltin}
              />
            </Field>
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--fg-2)" }}>
            <input type="checkbox" checked={stream} onChange={(e) => setStream(e.target.checked)} disabled={isBuiltin} />
            启用流式响应（stream）
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--fg-2)" }}>
            <input type="checkbox" checked={supportsVision} onChange={(e) => setSupportsVision(e.target.checked)} disabled={isBuiltin} />
            支持视觉输入（supports_vision）
          </label>
          <Field label="额外 Headers（JSON 对象，可选）">
            <input
              value={extraHeaders}
              onChange={(e) => setExtraHeaders(e.target.value)}
              className={inputCls}
              placeholder='如 {"X-Custom":"value"}'
              disabled={isBuiltin}
            />
          </Field>
        </div>

        <div className="an-row-card" style={{ flexDirection: "column", alignItems: "stretch", gap: 10 }}>
          <div className="an-rc-title">可见性</div>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--fg-2)" }}>
            <input type="checkbox" checked={isEnabled} onChange={(e) => setIsEnabled(e.target.checked)} disabled={isBuiltin} />
            启用
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--fg-2)" }}>
            <input type="checkbox" checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} disabled={isBuiltin} />
            公开（所有用户可见）
          </label>
        </div>

        {!isBuiltin && (
          <div style={{ display: "flex", justifyContent: isEdit ? "space-between" : "flex-end" }}>
            {isEdit && (
              <DangerButton onClick={remove} disabled={deleting}>
                {deleting ? "删除中…" : "删除"}
              </DangerButton>
            )}
            <PrimaryButton onClick={save} disabled={saving}>
              {saving ? "保存中…" : isEdit ? "保存" : "创建"}
            </PrimaryButton>
          </div>
        )}
      </div>
    </div>
  );
}
