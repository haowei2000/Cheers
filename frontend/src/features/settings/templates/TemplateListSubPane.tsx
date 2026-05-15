import { useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import { apiFetch } from "../../../api";
import {
  BackBar,
  DangerButton,
  Field,
  PrimaryButton,
  inputCls,
} from "../shared/SettingsControls";

type TemplateRow = {
  template_id: string;
  name: string;
  description?: string | null;
  system_prompt: string;
  user_template: string;
  variables?: string[];
  is_builtin?: boolean;
};

const TEMPLATE_VARS: { name: string; desc: string }[] = [
  { name: "memory", desc: "频道记忆上下文" },
  { name: "message", desc: "用户消息" },
  { name: "sender_name", desc: "发送者名称" },
  { name: "bot_name", desc: "当前 Bot 名称" },
  { name: "channel_name", desc: "频道名称" },
  { name: "channel_id", desc: "频道 ID" },
  { name: "timestamp", desc: "消息时间" },
];

const DEFAULT_USER_TEMPLATE = "{{memory}}\n\n{{message}}";

function extractTemplateVars(tpl: string): string[] {
  const re = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
  const out = new Set<string>();
  for (const m of tpl.matchAll(re)) out.add(m[1]);
  return out.size === 0 ? ["memory", "message"] : Array.from(out);
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
        <BackBar label="返回模板列表" onBack={() => setView("list")} />
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
          <BackBar label="返回模板列表" onBack={() => setView("list")} />
          <div className="an-row-card" style={{ color: "var(--fg-3)" }}>该模板已不存在</div>
        </div>
      );
    }
    return (
      <div className="an-pane">
        <BackBar label="返回模板列表" onBack={() => setView("list")} />
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
          <div className="an-pane-title">消息模板</div>
          <div className="an-pane-sub">系统提示词与用户模板的复用集合。</div>
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
            <div className="an-rc-title">新建模板</div>
            <div className="an-rc-sub">为某类对话创建可复用的提示词组合</div>
          </div>
          <span style={{ color: "var(--fg-3)", fontSize: 12 }}>›</span>
        </button>
        {loading ? (
          <div className="an-row-card" style={{ justifyContent: "center", color: "var(--fg-3)" }}>加载中…</div>
        ) : items.length === 0 ? (
          <div className="an-row-card" style={{ justifyContent: "center", color: "var(--fg-3)" }}>暂无模板</div>
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
                    <span style={{
                      fontSize: 9, fontWeight: 700, letterSpacing: "0.5px",
                      padding: "1px 5px", borderRadius: 3,
                      background: "var(--surface-soft)", color: "var(--fg-3)",
                      border: "1px solid var(--border)",
                    }}>BUILTIN</span>
                  )}
                </div>
                {t.description && <div className="an-rc-sub">{t.description}</div>}
              </div>
              <span style={{ color: "var(--fg-3)", fontSize: 12 }}>›</span>
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
  const [userTemplate, setUserTemplate] = useState(existing?.user_template || DEFAULT_USER_TEMPLATE);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const isEdit = !!existing;
  const isBuiltin = !!existing?.is_builtin;
  const preservedSystemPrompt = existing?.system_prompt || "";
  const preservedDescription = existing?.description || "";
  const userTplRef = useRef<HTMLTextAreaElement | null>(null);
  const [varDropdownOpen, setVarDropdownOpen] = useState(false);
  const [varFilter, setVarFilter] = useState("");
  const [varDropdownStart, setVarDropdownStart] = useState(0);

  const save = async () => {
    if (!name.trim()) return toast.error("模板名称必填");
    setSaving(true);
    try {
      const tpl = userTemplate.trim() || DEFAULT_USER_TEMPLATE;
      const body = {
        name: name.trim(),
        description: preservedDescription || null,
        system_prompt: preservedSystemPrompt.trim() || "You are a helpful assistant.",
        user_template: tpl,
        variables: extractTemplateVars(tpl),
      };
      const res = await apiFetch(
        isEdit ? `/templates/${existing!.template_id}` : "/templates",
        {
          method: isEdit ? "PUT" : "POST",
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
      const res = await apiFetch(`/templates/${existing.template_id}`, {
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
          <div className="an-pane-title">{isEdit ? existing!.name : "新建模板"}</div>
          {isBuiltin && <div className="an-pane-sub">系统内置模板（只读）</div>}
        </div>
      </div>
      <div className="an-list-table">
        <div className="an-row-card" style={{ flexDirection: "column", alignItems: "stretch", gap: 10 }}>
          <Field label="名称">
            <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} disabled={isBuiltin} />
          </Field>
          <Field label="User Template（输入 {{ 弹出可用变量）">
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
                disabled={isBuiltin}
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
                          fontSize: 12,
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
    </div>
  );
}
