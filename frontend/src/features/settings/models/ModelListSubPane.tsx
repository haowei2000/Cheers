import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { apiFetch } from "../../../api";
import { AiBrandIcon, AppIcon } from "../../../components/icons";
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

type ModelSettingsTab = "identity" | "runtime" | "access";

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
        <div className="an-type-label an-truncate">
          {model.name}
        </div>
        <div className="an-type-meta an-truncate">
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
        <BackBar label="Back to model list" onBack={() => setView("list")} />
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
          <BackBar label="Back to model list" onBack={() => setView("list")} />
          <div className="an-row-card" style={{ color: "var(--fg-3)" }}>This model no longer exists</div>
        </div>
      );
    }
    return (
      <div className="an-pane">
        <BackBar label="Back to model list" onBack={() => setView("list")} />
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
          <div className="an-pane-title">LLM models</div>
          <div className="an-pane-sub">Configure LLM providers that bots can bind to.</div>
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
              display: "inline-grid", placeItems: "center", flexShrink: 0,
            }}
          >
            <AppIcon name="plus" className="h-4 w-4" />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="an-rc-title">New model</div>
            <div className="an-rc-sub">Add an OpenAI-compatible LLM provider</div>
          </div>
          <AppIcon name="chevronRight" className="an-rc-chev" />
        </button>
        {loading ? (
          <div className="an-row-card" style={{ justifyContent: "center", color: "var(--fg-3)" }}>Loading...</div>
        ) : items.length === 0 ? (
          <div className="an-row-card" style={{ justifyContent: "center", color: "var(--fg-3)" }}>No models</div>
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
                  <span className="an-chip off">{m.provider}</span>
                  {!m.is_enabled && (
                    <span className="an-chip red">DISABLED</span>
                  )}
                </div>
                <div className="an-rc-sub">{m.model_name} · {m.base_url}</div>
              </div>
              <AppIcon name="chevronRight" className="an-rc-chev" />
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
  const [settingsTab, setSettingsTab] = useState<ModelSettingsTab>("identity");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const save = async () => {
    if (!name.trim() || !modelName.trim() || !baseUrl.trim()) {
      toast.error("Fill required fields (name / model name / base URL)");
      return;
    }
    let parsedHeaders: Record<string, string> | null = null;
    if (extraHeaders.trim()) {
      try {
        parsedHeaders = JSON.parse(extraHeaders);
      } catch {
        toast.error("Extra headers must be a valid JSON object");
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
        toast.success(isEdit ? "Updated" : "Created");
        onSaved();
      } else {
        toast.error(data?.message || data?.detail || (isEdit ? "Update failed" : "Create failed"));
      }
    } catch (e: unknown) {
      toast.error((e as Error).message || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!existing) return;
    if (!confirm(`Delete "${existing.name}"?`)) return;
    setDeleting(true);
    try {
      const res = await apiFetch(`/admin/models/${existing.model_id}`, {
        method: "DELETE",
        token: authToken,
      });
      const data = await res.json();
      if (data?.status === "success") {
        toast.success("Deleted");
        onDeleted?.();
      } else {
        toast.error(data?.message || data?.detail || "Delete failed");
      }
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="an-pane">
      <div
        className="an-pane-head"
        style={{ justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}
      >
        <div>
          <div className="an-pane-title">{isEdit ? existing!.name : "New model"}</div>
          {isBuiltin && <div className="an-pane-sub">System built-in (read-only)</div>}
        </div>
        <div className="an-seg" role="tablist" aria-label="Model settings view">
          <button
            type="button"
            className={settingsTab === "identity" ? "on" : ""}
            onClick={() => setSettingsTab("identity")}
            role="tab"
            aria-selected={settingsTab === "identity"}
          >
            Basics
          </button>
          <button
            type="button"
            className={settingsTab === "runtime" ? "on" : ""}
            onClick={() => setSettingsTab("runtime")}
            role="tab"
            aria-selected={settingsTab === "runtime"}
          >
            Parameters
          </button>
          <button
            type="button"
            className={settingsTab === "access" ? "on" : ""}
            onClick={() => setSettingsTab("access")}
            role="tab"
            aria-selected={settingsTab === "access"}
          >
            Permissions
          </button>
        </div>
      </div>
      <div className="an-list-table">
        {settingsTab === "identity" && (
          <div className="an-row-card" style={{ flexDirection: "column", alignItems: "stretch", gap: 10 }}>
            <div className="an-rc-title">Basic information</div>
            <Field label="Name">
              <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} disabled={isBuiltin} />
            </Field>
            <Field label="Provider">
              <select value={provider} onChange={(e) => setProvider(e.target.value)} className={inputCls} disabled={isBuiltin}>
                <option value="ollama">Ollama</option>
                <option value="openai">OpenAI compatible</option>
                <option value="anthropic">Anthropic</option>
                <option value="azure">Azure OpenAI</option>
                <option value="custom">Custom</option>
              </select>
            </Field>
            <Field label="Model name (model_name sent to provider)">
              <input value={modelName} onChange={(e) => setModelName(e.target.value)} className={inputCls} placeholder="e.g. llama3.2" disabled={isBuiltin} />
            </Field>
            <Field label="Base URL">
              <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} className={inputCls} placeholder="e.g. http://localhost:11434/v1" disabled={isBuiltin} />
            </Field>
            <Field label={isEdit ? "API key (leave blank to keep unchanged)" : "API Key"}>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                className={inputCls}
                placeholder={existing?.api_key_masked || "Optional"}
                disabled={isBuiltin}
              />
            </Field>
            <Field label="Description">
              <input value={description} onChange={(e) => setDescription(e.target.value)} className={inputCls} disabled={isBuiltin} />
            </Field>
          </div>
        )}

        {settingsTab === "runtime" && (
          <div className="an-row-card" style={{ flexDirection: "column", alignItems: "stretch", gap: 10 }}>
            <div className="an-rc-title">Inference parameters</div>
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
            <label className="an-checkline">
              <input type="checkbox" checked={stream} onChange={(e) => setStream(e.target.checked)} disabled={isBuiltin} />
              Enable streaming responses (stream)
            </label>
            <label className="an-checkline">
              <input type="checkbox" checked={supportsVision} onChange={(e) => setSupportsVision(e.target.checked)} disabled={isBuiltin} />
              Supports vision input (supports_vision)
            </label>
            <Field label="Extra headers (optional JSON object)">
              <input
                value={extraHeaders}
                onChange={(e) => setExtraHeaders(e.target.value)}
                className={inputCls}
                placeholder='e.g. {"X-Custom":"value"}'
                disabled={isBuiltin}
              />
            </Field>
          </div>
        )}

        {settingsTab === "access" && (
          <div className="an-row-card" style={{ flexDirection: "column", alignItems: "stretch", gap: 10 }}>
            <div className="an-rc-title">Visibility</div>
            <label className="an-checkline">
              <input type="checkbox" checked={isEnabled} onChange={(e) => setIsEnabled(e.target.checked)} disabled={isBuiltin} />
              Enabled
            </label>
            <label className="an-checkline">
              <input type="checkbox" checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} disabled={isBuiltin} />
              Public (visible to all users)
            </label>
          </div>
        )}

        {!isBuiltin && (
          <div style={{ display: "flex", justifyContent: isEdit ? "space-between" : "flex-end" }}>
            {isEdit && (
              <DangerButton onClick={remove} disabled={deleting}>
                {deleting ? "Deleting..." : "Delete"}
              </DangerButton>
            )}
            <PrimaryButton onClick={save} disabled={saving}>
              {saving ? "Saving..." : isEdit ? "Save" : "Create"}
            </PrimaryButton>
          </div>
        )}
      </div>
    </div>
  );
}
