import { useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import { apiFetch } from "../../../api";
import { AppIcon } from "../../../components/icons";
import {
  BackBar,
  DangerButton,
  Field,
  PrimaryButton,
  inputCls,
} from "../shared/SettingsControls";
import { botScopeLabel, normalizeBotScope } from "../bots/BotShared";
import type { BotScope } from "../bots/types";

type TemplateRow = {
  template_id: string;
  name: string;
  description?: string | null;
  system_prompt: string;
  user_template: string;
  variables?: string[];
  is_builtin?: boolean;
  scope?: BotScope;
  created_by?: string | null;
  owner?: {
    user_id: string;
    username: string;
    display_name?: string | null;
  } | null;
  can_manage?: boolean;
};

type TemplateSettingsTab = "identity" | "template";

const TEMPLATE_VARS: { name: string; desc: string }[] = [
  { name: "memory", desc: "Channel memory context" },
  { name: "message", desc: "User message" },
  { name: "sender_name", desc: "Sender name" },
  { name: "bot_name", desc: "Current bot name" },
  { name: "channel_name", desc: "Channel name" },
  { name: "channel_id", desc: "Channel ID" },
  { name: "timestamp", desc: "Message time" },
];

const DEFAULT_USER_TEMPLATE = "{{memory}}\n\n{{message}}";

const TEMPLATE_SCOPE_OPTIONS: { value: BotScope; label: string; hint: string }[] = [
  { value: "private", label: "Private", hint: "Only you can use this template" },
  { value: "friend", label: "Friend", hint: "You and friends can use this template" },
  { value: "everyone", label: "Everyone", hint: "All users can use this template" },
];

function extractTemplateVars(tpl: string): string[] {
  const re = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
  const out = new Set<string>();
  for (const m of tpl.matchAll(re)) out.add(m[1]);
  return out.size === 0 ? ["memory", "message"] : Array.from(out);
}

function templateOwnerLabel(tpl: Pick<TemplateRow, "owner" | "created_by">) {
  return tpl.owner?.display_name || tpl.owner?.username || tpl.created_by || "System";
}

function TemplateScopeControl({
  value,
  onChange,
  disabled = false,
}: {
  value: BotScope;
  onChange: (scope: BotScope) => void;
  disabled?: boolean;
}) {
  const current = TEMPLATE_SCOPE_OPTIONS.find((opt) => opt.value === value) || TEMPLATE_SCOPE_OPTIONS[1];
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <div
        className="an-seg"
        role="radiogroup"
        aria-label="Template Scope"
        style={{ display: "inline-flex", justifySelf: "start" }}
      >
        {TEMPLATE_SCOPE_OPTIONS.map((opt) => (
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

export function TemplateListSubPane({ authToken }: { authToken: string | null }) {
  const [items, setItems] = useState<TemplateRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<"list" | "new" | { id: string }>("list");

  const reload = () => {
    setLoading(true);
    apiFetch("/templates", { token: authToken })
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
        <BackBar label="Back to template list" onBack={() => setView("list")} />
        <TemplateForm
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
    const tpl = items.find((t) => t.template_id === view.id);
    if (!tpl) {
      return (
        <div className="an-pane">
          <BackBar label="Back to template list" onBack={() => setView("list")} />
          <div className="an-row-card" style={{ color: "var(--fg-3)" }}>This template no longer exists</div>
        </div>
      );
    }
    return (
      <div className="an-pane">
        <BackBar label="Back to template list" onBack={() => setView("list")} />
        <TemplateForm
          authToken={authToken}
          existing={tpl}
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
          <div className="an-pane-title">Message templates</div>
          <div className="an-pane-sub">Reusable system prompts and user templates.</div>
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
            <div className="an-rc-title">New template</div>
            <div className="an-rc-sub">Create a reusable prompt set for a conversation type</div>
          </div>
          <AppIcon name="chevronRight" className="an-rc-chev" />
        </button>
        {loading ? (
          <div className="an-row-card" style={{ justifyContent: "center", color: "var(--fg-3)" }}>Loading...</div>
        ) : items.length === 0 ? (
          <div className="an-row-card" style={{ justifyContent: "center", color: "var(--fg-3)" }}>No templates</div>
        ) : (
          items.map((t) => (
            <button
              key={t.template_id}
              type="button"
              className="an-row-card"
              style={{ width: "100%", textAlign: "left", cursor: "pointer", fontFamily: "inherit" }}
              onClick={() => setView({ id: t.template_id })}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="an-rc-title">
                  {t.name}
                  {t.is_builtin && (
                    <span className="an-chip off">BUILTIN</span>
                  )}
                  {!t.is_builtin && (
                    <span className="an-chip off">{botScopeLabel(t.scope)}</span>
                  )}
                  {t.can_manage === false && (
                    <span className="an-chip off">READ ONLY</span>
                  )}
                </div>
                <div className="an-rc-sub">
                  {t.description || "No description"}
                  {" · Owner: "}
                  {templateOwnerLabel(t)}
                </div>
              </div>
              <AppIcon name="chevronRight" className="an-rc-chev" />
            </button>
          ))
        )}
      </div>
    </div>
  );
}

function TemplateForm({
  authToken,
  existing,
  onSaved,
  onDeleted,
}: {
  authToken: string | null;
  existing?: TemplateRow;
  onSaved: () => void;
  onDeleted?: () => void;
}) {
  const [name, setName] = useState(existing?.name || "");
  const [description, setDescription] = useState(existing?.description || "");
  const [systemPrompt, setSystemPrompt] = useState(existing?.system_prompt || "You are a helpful assistant.");
  const [userTemplate, setUserTemplate] = useState(existing?.user_template || DEFAULT_USER_TEMPLATE);
  const [scope, setScope] = useState<BotScope>(normalizeBotScope(existing?.scope));
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const isEdit = !!existing;
  const isBuiltin = !!existing?.is_builtin;
  const isReadOnly = isBuiltin || (isEdit && existing?.can_manage === false);
  const userTplRef = useRef<HTMLTextAreaElement | null>(null);
  const [varDropdownOpen, setVarDropdownOpen] = useState(false);
  const [varFilter, setVarFilter] = useState("");
  const [varDropdownStart, setVarDropdownStart] = useState(0);
  const [settingsTab, setSettingsTab] = useState<TemplateSettingsTab>("identity");

  const save = async () => {
    if (isReadOnly) return;
    if (!name.trim()) return toast.error("Template name is required");
    setSaving(true);
    try {
      const tpl = userTemplate.trim() || DEFAULT_USER_TEMPLATE;
      const body = {
        name: name.trim(),
        description: description.trim() || null,
        system_prompt: systemPrompt.trim() || "You are a helpful assistant.",
        user_template: tpl,
        variables: extractTemplateVars(tpl),
        scope,
      };
      const res = await apiFetch(
        isEdit ? `/templates/${existing!.template_id}` : "/templates",
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
      const res = await apiFetch(`/templates/${existing.template_id}`, {
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
          <div className="an-pane-title">{isEdit ? existing!.name : "New template"}</div>
          {isBuiltin && <div className="an-pane-sub">System built-in template (read-only)</div>}
          {!isBuiltin && isReadOnly && (
            <div className="an-pane-sub">Shared template (read-only)</div>
          )}
        </div>
        <div className="an-seg" role="tablist" aria-label="Template settings view">
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
            className={settingsTab === "template" ? "on" : ""}
            onClick={() => setSettingsTab("template")}
            role="tab"
            aria-selected={settingsTab === "template"}
          >
            Template
          </button>
        </div>
      </div>
      <div className="an-list-table">
        {settingsTab === "identity" && (
          <div className="an-row-card" style={{ flexDirection: "column", alignItems: "stretch", gap: 10 }}>
            <Field label="Name">
              <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} disabled={isReadOnly} />
            </Field>
            <Field label="Description">
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                className={`${inputCls} resize-none`}
                disabled={isReadOnly}
              />
            </Field>
            <Field label="Visibility">
              <TemplateScopeControl value={scope} onChange={setScope} disabled={isReadOnly || saving} />
            </Field>
            {isEdit && (
              <div className="an-rc-sub">
                Owner: {templateOwnerLabel(existing!)}
              </div>
            )}
          </div>
        )}

        {settingsTab === "template" && (
          <div className="an-row-card" style={{ flexDirection: "column", alignItems: "stretch", gap: 10 }}>
            <Field label="System prompt">
              <textarea
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                rows={8}
                className={`${inputCls} resize-none`}
                disabled={isReadOnly}
                style={{ fontFamily: "var(--font-mono, ui-monospace, monospace)" }}
              />
            </Field>
            <Field label="User template (type {{ to show variables)">
              <div style={{ position: "relative" }}>
                <textarea
                  ref={userTplRef}
                  value={userTemplate}
                  onChange={(e) => {
                    const v = e.target.value;
                    const pos = e.target.selectionStart ?? v.length;
                    setUserTemplate(v);
                    const lastBraces = v.lastIndexOf("{{", pos - 1);
                    const between = lastBraces !== -1 ? v.slice(lastBraces + 2, pos) : "";
                    if (
                      lastBraces !== -1 &&
                      !between.includes("}}") &&
                      !between.includes("\n") &&
                      !between.includes(" ")
                    ) {
                      setVarFilter(between);
                      setVarDropdownStart(lastBraces);
                      setVarDropdownOpen(true);
                    } else {
                      setVarDropdownOpen(false);
                    }
                  }}
                  onBlur={() => setTimeout(() => setVarDropdownOpen(false), 150)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape" && varDropdownOpen) {
                      setVarDropdownOpen(false);
                      e.stopPropagation();
                    }
                  }}
                  rows={4}
                  className={`${inputCls} resize-none`}
                  disabled={isReadOnly}
                  style={{ fontFamily: "var(--font-mono, ui-monospace, monospace)" }}
                />
                {varDropdownOpen && (() => {
                  const matched = TEMPLATE_VARS.filter((v) =>
                    v.name.toLowerCase().includes(varFilter.toLowerCase()),
                  );
                  if (matched.length === 0) return null;
                  return (
                    <div
                      style={{
                        position: "absolute",
                        top: "100%",
                        left: 0,
                        right: 0,
                        marginTop: 4,
                        maxHeight: 240,
                        overflowY: "auto",
                        zIndex: 50,
                        background: "var(--bg-1)",
                        border: "1px solid var(--border)",
                        borderRadius: 8,
                        boxShadow: "0 8px 24px var(--shadow)",
                      }}
                    >
                      {matched.map((v) => (
                        <button
                          key={v.name}
                          type="button"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => {
                            const cur = userTemplate;
                            const el = userTplRef.current;
                            const pos = el?.selectionStart ?? cur.length;
                            const insert = `{{${v.name}}}`;
                            const next = cur.slice(0, varDropdownStart) + insert + cur.slice(pos);
                            setUserTemplate(next);
                            setVarDropdownOpen(false);
                            requestAnimationFrame(() => {
                              el?.focus();
                              const cursor = varDropdownStart + insert.length;
                              el?.setSelectionRange(cursor, cursor);
                            });
                          }}
                          style={{
                            display: "flex",
                            width: "100%",
                            alignItems: "center",
                            gap: 12,
                            padding: "8px 12px",
                            textAlign: "left",
                            background: "transparent",
                            border: 0,
                            cursor: "pointer",
                          }}
                          onMouseEnter={(e) =>
                            (e.currentTarget.style.background = "var(--surface-soft)")
                          }
                          onMouseLeave={(e) =>
                            (e.currentTarget.style.background = "transparent")
                          }
                        >
                          <code style={{ color: "var(--accent)", fontFamily: "var(--font-mono, ui-monospace, monospace)" }}>{`{{${v.name}}}`}</code>
                          <span style={{ color: "var(--fg-3)" }}>{v.desc}</span>
                        </button>
                      ))}
                    </div>
                  );
                })()}
              </div>
            </Field>
          </div>
        )}

        {!isReadOnly && (
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
