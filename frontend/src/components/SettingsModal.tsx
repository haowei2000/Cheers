import { useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import type { CurrentUser, Friend, UserSearchResult } from "../types";
import { apiFetch } from "../api";

type Density = "comfy" | "compact";
type AccentId = "indigo" | "teal" | "amber" | "rose" | "blue";

const ACCENTS: { id: AccentId; c: string; label: string }[] = [
  { id: "indigo", c: "#7c6cf5", label: "Indigo" },
  { id: "teal", c: "#3ecf8e", label: "Teal" },
  { id: "amber", c: "#f5a623", label: "Amber" },
  { id: "rose", c: "#f05478", label: "Rose" },
  { id: "blue", c: "#56a7ff", label: "Blue" },
];

const DENSITY_KEY = "agentnexus-density";
const ACCENT_KEY = "agentnexus-accent";

export function getStoredDensity(): Density {
  if (typeof window === "undefined") return "comfy";
  const v = localStorage.getItem(DENSITY_KEY);
  return v === "compact" ? "compact" : "comfy";
}

export function getStoredAccent(): AccentId {
  if (typeof window === "undefined") return "indigo";
  const v = localStorage.getItem(ACCENT_KEY) as AccentId | null;
  return ACCENTS.some((a) => a.id === v) ? (v as AccentId) : "indigo";
}

export function applyAccent(id: AccentId) {
  const hit = ACCENTS.find((a) => a.id === id) || ACCENTS[0];
  const root = document.documentElement.style;
  root.setProperty("--accent", hit.c);
  root.setProperty("--accent-hover", hit.c);
  root.setProperty("--accent-muted", hit.c + "24");
  root.setProperty("--accent-ring", hit.c + "66");
  root.setProperty("--border-focus", hit.c + "99");
}

export function applyDensity(d: Density) {
  document.documentElement.setAttribute("data-density", d);
}

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  isDark: boolean;
  setTheme: (t: "light" | "dark") => void;
  authToken: string | null;
  currentUser: CurrentUser;
  onProfileUpdated: (data: { display_name: string; bio?: string }) => void;
  onLogout: () => void;
}

type BotRow = {
  bot_id: string;
  username: string;
  display_name?: string | null;
  description?: string | null;
};

/** One pane per top-level category. Drill-down within a category (e.g.
 *  selecting a specific bot inside the Bot pane) is local state on that
 *  pane, not a separate sidebar entry. */
type Pane = "bot" | "account" | "friends" | "appearance" | "bulletin" | "other";

export function SettingsModal({
  open,
  onClose,
  isDark,
  setTheme,
  authToken,
  currentUser,
  onProfileUpdated,
  onLogout,
}: SettingsModalProps) {
  const [pane, setPane] = useState<Pane>("bot");
  const [density, setDensityState] = useState<Density>(() => getStoredDensity());
  const [accent, setAccentState] = useState<AccentId>(() => getStoredAccent());
  const [bots, setBots] = useState<BotRow[]>([]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const reloadBots = () => {
    apiFetch("/bots", { token: authToken })
      .then((r) => r.json())
      .then((d) => setBots(Array.isArray(d?.data) ? d.data : []))
      .catch(() => setBots([]));
  };

  useEffect(() => {
    if (!open) return;
    reloadBots();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, authToken]);

  const changeDensity = (d: Density) => {
    setDensityState(d);
    localStorage.setItem(DENSITY_KEY, d);
    applyDensity(d);
  };

  const changeAccent = (id: AccentId) => {
    setAccentState(id);
    localStorage.setItem(ACCENT_KEY, id);
    applyAccent(id);
  };

  if (!open) return null;

  const NAV_ITEMS: { id: Pane; ico: string; label: string }[] = [
    { id: "bot", ico: "◉", label: "Bot" },
    { id: "account", ico: "◉", label: "账户" },
    { id: "friends", ico: "◎", label: "好友" },
    { id: "appearance", ico: "◐", label: "外观" },
    { id: "bulletin", ico: "💬", label: "留言板" },
    { id: "other", ico: "⌘", label: "其他" },
  ];

  return (
    <div className="an-modal-overlay" onClick={onClose}>
      <div className="an-modal" onClick={(e) => e.stopPropagation()}>
        <div className="an-modal-head">
          <div className="an-modal-title">设置 · Settings</div>
          <button
            type="button"
            className="an-modal-close"
            onClick={onClose}
            aria-label="关闭"
          >
            ✕
          </button>
        </div>
        <div className="an-modal-body">
          <nav className="an-settings-nav">
            {NAV_ITEMS.map((it) => (
              <button
                key={it.id}
                type="button"
                className={`an-sn-item ${pane === it.id ? "on" : ""}`}
                onClick={() => setPane(it.id)}
              >
                <span className="an-sn-ico">{it.ico}</span> {it.label}
              </button>
            ))}
          </nav>
          <div className="an-settings-pane">
            {pane === "bot" && (
              <BotPane
                bots={bots}
                authToken={authToken}
                onChanged={reloadBots}
              />
            )}
            {pane === "account" && (
              <AccountPane
                currentUser={currentUser}
                authToken={authToken}
                onProfileUpdated={onProfileUpdated}
                onLogout={() => {
                  onClose();
                  onLogout();
                }}
              />
            )}
            {pane === "friends" && (
              <FriendsPane
                currentUserId={currentUser?.user_id || ""}
                authToken={authToken}
              />
            )}
            {pane === "appearance" && (
              <AppearancePane
                isDark={isDark}
                setTheme={setTheme}
                density={density}
                setDensity={changeDensity}
                accent={accent}
                setAccent={changeAccent}
              />
            )}
            {pane === "bulletin" && (
              <BulletinPane
                authToken={authToken}
                currentUserId={currentUser?.user_id || ""}
                userRole={currentUser?.role || ""}
              />
            )}
            {pane === "other" && authToken && (
              <KeychainPane authToken={authToken} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Shared field helpers ──────────────────────────────────────────────────

const inputCls =
  "w-full px-3 py-2 border border-[var(--border)] rounded-lg text-sm bg-[var(--bg-0)] text-[var(--fg-1)] focus:outline-none focus:border-[var(--accent)]";

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label
        style={{
          display: "block",
          fontSize: 11,
          fontWeight: 600,
          color: "var(--fg-2)",
          marginBottom: 4,
        }}
      >
        {label}
      </label>
      {children}
    </div>
  );
}

function PrimaryButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "8px 16px",
        background: "var(--accent)",
        color: "#fff",
        border: 0,
        borderRadius: 6,
        fontSize: 13,
        fontWeight: 500,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        fontFamily: "inherit",
      }}
    >
      {children}
    </button>
  );
}

function DangerButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "6px 12px",
        background: "transparent",
        color: "var(--red)",
        border: "1px solid var(--red)",
        borderRadius: 6,
        fontSize: 12,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        fontFamily: "inherit",
      }}
    >
      {children}
    </button>
  );
}

// ── Appearance pane ───────────────────────────────────────────────────────

function AppearancePane({
  isDark,
  setTheme,
  density,
  setDensity,
  accent,
  setAccent,
}: {
  isDark: boolean;
  setTheme: (t: "light" | "dark") => void;
  density: Density;
  setDensity: (d: Density) => void;
  accent: AccentId;
  setAccent: (id: AccentId) => void;
}) {
  return (
    <div>
      <div className="an-pane-head">
        <div>
          <div className="an-pane-title">外观</div>
          <div className="an-pane-sub">主题、密度与主色。</div>
        </div>
      </div>
      <div className="an-list-table">
        <div className="an-row-card" style={{ justifyContent: "space-between" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="an-rc-title">主题</div>
            <div className="an-rc-sub">整体亮度。</div>
          </div>
          <div className="an-seg">
            <button
              type="button"
              className={isDark ? "on" : ""}
              onClick={() => setTheme("dark")}
            >
              深色
            </button>
            <button
              type="button"
              className={!isDark ? "on" : ""}
              onClick={() => setTheme("light")}
            >
              浅色
            </button>
          </div>
        </div>
        <div className="an-row-card" style={{ justifyContent: "space-between" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="an-rc-title">密度</div>
            <div className="an-rc-sub">消息间距。</div>
          </div>
          <div className="an-seg">
            <button
              type="button"
              className={density === "comfy" ? "on" : ""}
              onClick={() => setDensity("comfy")}
            >
              舒适
            </button>
            <button
              type="button"
              className={density === "compact" ? "on" : ""}
              onClick={() => setDensity("compact")}
            >
              紧凑
            </button>
          </div>
        </div>
        <div className="an-row-card" style={{ justifyContent: "space-between" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="an-rc-title">主色</div>
            <div className="an-rc-sub">按钮、高亮与链接的主色。</div>
          </div>
          <div className="an-swatch-row">
            {ACCENTS.map((a) => (
              <button
                key={a.id}
                type="button"
                className={`an-sw ${accent === a.id ? "on" : ""}`}
                style={{ background: a.c }}
                onClick={() => setAccent(a.id)}
                aria-label={a.label}
                title={a.label}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Profile pane (display name + bio + password) ──────────────────────────

function ProfilePane({
  currentUser,
  authToken,
  onProfileUpdated,
}: {
  currentUser: NonNullable<CurrentUser>;
  authToken: string | null;
  onProfileUpdated: (data: { display_name: string; bio?: string }) => void;
}) {
  const [displayName, setDisplayName] = useState(currentUser.display_name || "");
  const [bio, setBio] = useState("");
  const [email, setEmail] = useState("");
  const [saving, setSaving] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pwSaving, setPwSaving] = useState(false);
  const [pwMode, setPwMode] = useState<"password" | "email">("password");
  const [emailCode, setEmailCode] = useState("");
  const [emailCodeSent, setEmailCodeSent] = useState(false);
  const [emailCodeLoading, setEmailCodeLoading] = useState(false);

  useEffect(() => {
    if (!authToken) return;
    apiFetch("/auth/users/me", { token: authToken })
      .then((r) => r.json())
      .then((d) => {
        if (typeof d?.display_name === "string") setDisplayName(d.display_name || "");
        if (typeof d?.bio === "string") setBio(d.bio || "");
        if (typeof d?.email === "string") setEmail(d.email || "");
      })
      .catch(() => {});
  }, [authToken]);

  const saveProfile = async () => {
    setSaving(true);
    try {
      const res = await apiFetch("/auth/users/me", {
        method: "PUT",
        token: authToken,
        body: { display_name: displayName, bio },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.detail || "保存失败");
      onProfileUpdated({
        display_name: data.display_name || displayName,
        bio: data.bio,
      });
      toast.success("个人资料已更新");
    } catch (e: unknown) {
      toast.error((e as Error).message || "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const sendEmailCode = async () => {
    if (!email) {
      toast.error("账号未绑定邮箱");
      return;
    }
    setEmailCodeLoading(true);
    try {
      const res = await apiFetch("/auth/send-code", {
        method: "POST",
        token: authToken,
        body: { email, purpose: "change_password" },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.detail || "发送失败");
      setEmailCodeSent(true);
      toast.success(`验证码已发送至 ${email}`);
    } catch (e: unknown) {
      toast.error((e as Error).message || "发送失败");
    } finally {
      setEmailCodeLoading(false);
    }
  };

  const changePassword = async () => {
    if (!newPassword || newPassword !== confirmPassword) {
      toast.error("两次输入的新密码不一致");
      return;
    }
    if (pwMode === "password" && !currentPassword) return;
    if (pwMode === "email" && !emailCode) return;
    setPwSaving(true);
    try {
      const body: Record<string, string> = { new_password: newPassword };
      if (pwMode === "password") body.current_password = currentPassword;
      else body.email_code = emailCode;
      const res = await apiFetch("/auth/users/me/password", {
        method: "PUT",
        token: authToken,
        body,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.detail || "密码修改失败");
      toast.success("密码已更新");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setEmailCode("");
      setEmailCodeSent(false);
    } catch (e: unknown) {
      toast.error((e as Error).message || "密码修改失败");
    } finally {
      setPwSaving(false);
    }
  };

  const initial = (displayName || currentUser.username || "?").slice(0, 1).toUpperCase();

  return (
    <div>
      <div className="an-pane-head">
        <div>
          <div className="an-pane-title">编辑资料</div>
          <div className="an-pane-sub">显示名称、个人简介与密码。</div>
        </div>
      </div>
      <div className="an-list-table">
        <div className="an-row-card" style={{ alignItems: "flex-start", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, width: "100%" }}>
            <span
              style={{
                width: 44,
                height: 44,
                borderRadius: 8,
                background: "var(--accent)",
                color: "#fff",
                fontWeight: 700,
                fontSize: 18,
                display: "inline-grid",
                placeItems: "center",
                flexShrink: 0,
              }}
            >
              {initial}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="an-rc-title">{displayName || currentUser.username}</div>
              <div className="an-rc-sub">@{currentUser.username} · {currentUser.role}</div>
            </div>
          </div>
          <div style={{ width: "100%" }}>
            <Field label="UUID（可分享给好友添加）">
              <div style={{ display: "flex", gap: 6 }}>
                <code
                  style={{
                    flex: 1,
                    padding: "6px 10px",
                    background: "var(--bg-0)",
                    border: "1px solid var(--border)",
                    borderRadius: 6,
                    fontSize: 11,
                    color: "var(--fg-2)",
                    userSelect: "all",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {currentUser.user_id}
                </code>
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard.writeText(currentUser.user_id);
                    toast.success("UUID 已复制");
                  }}
                  style={{
                    padding: "6px 10px",
                    background: "var(--surface-soft)",
                    border: "1px solid var(--border)",
                    borderRadius: 6,
                    fontSize: 11,
                    color: "var(--fg-2)",
                    cursor: "pointer",
                    fontFamily: "inherit",
                  }}
                >
                  复制
                </button>
              </div>
            </Field>
          </div>
        </div>

        <div className="an-row-card" style={{ flexDirection: "column", alignItems: "stretch", gap: 12 }}>
          <div className="an-rc-title">基本信息</div>
          <Field label="显示名称">
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field label="个人简介">
            <textarea
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              rows={3}
              className={`${inputCls} resize-none`}
            />
          </Field>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <PrimaryButton onClick={saveProfile} disabled={saving}>
              {saving ? "保存中…" : "保存资料"}
            </PrimaryButton>
          </div>
        </div>

        <div className="an-row-card" style={{ flexDirection: "column", alignItems: "stretch", gap: 12 }}>
          <div className="an-rc-title">修改密码</div>
          <div className="an-seg" style={{ alignSelf: "flex-start" }}>
            <button
              type="button"
              className={pwMode === "password" ? "on" : ""}
              onClick={() => setPwMode("password")}
            >
              密码验证
            </button>
            <button
              type="button"
              className={pwMode === "email" ? "on" : ""}
              onClick={() => setPwMode("email")}
            >
              邮箱验证
            </button>
          </div>
          {pwMode === "password" ? (
            <Field label="当前密码">
              <input
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                className={inputCls}
                autoComplete="current-password"
              />
            </Field>
          ) : (
            <Field label={`邮箱验证码${email ? `（发送至 ${email}）` : "（账号未绑定邮箱）"}`}>
              {email ? (
                <div style={{ display: "flex", gap: 6 }}>
                  <input
                    value={emailCode}
                    onChange={(e) => setEmailCode(e.target.value)}
                    className={inputCls}
                    style={{ flex: 1 }}
                  />
                  <button
                    type="button"
                    disabled={emailCodeLoading}
                    onClick={sendEmailCode}
                    style={{
                      padding: "8px 12px",
                      background: "var(--surface-soft)",
                      border: "1px solid var(--border)",
                      borderRadius: 6,
                      fontSize: 12,
                      cursor: emailCodeLoading ? "not-allowed" : "pointer",
                      whiteSpace: "nowrap",
                      fontFamily: "inherit",
                    }}
                  >
                    {emailCodeLoading ? "发送中…" : emailCodeSent ? "重新发送" : "获取验证码"}
                  </button>
                </div>
              ) : (
                <div style={{ fontSize: 12, color: "var(--red)" }}>账号未绑定邮箱，无法使用邮箱验证</div>
              )}
            </Field>
          )}
          <Field label="新密码">
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className={inputCls}
              autoComplete="new-password"
            />
          </Field>
          <Field label="确认新密码">
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className={inputCls}
              autoComplete="new-password"
            />
          </Field>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <PrimaryButton
              onClick={changePassword}
              disabled={
                pwSaving ||
                !newPassword ||
                !confirmPassword ||
                (pwMode === "password" && !currentPassword) ||
                (pwMode === "email" && !emailCode)
              }
            >
              {pwSaving ? "更新中…" : "更新密码"}
            </PrimaryButton>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Keychain pane ─────────────────────────────────────────────────────────

type KeychainItem = {
  key_id: string;
  name: string;
  description?: string;
  value_masked: string;
};

function KeychainPane({ authToken }: { authToken: string }) {
  const [items, setItems] = useState<KeychainItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState("");
  const [newValue, setNewValue] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [showValue, setShowValue] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    apiFetch("/keychain/", { token: authToken })
      .then((r) => r.json())
      .then((d) => setItems(Array.isArray(d) ? d : []))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, [authToken]);

  const create = async () => {
    if (!newName.trim() || !newValue.trim()) return;
    setSaving(true);
    try {
      const res = await apiFetch("/keychain/", {
        method: "POST",
        token: authToken,
        body: {
          name: newName.trim(),
          value: newValue,
          description: newDesc.trim() || undefined,
        },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.detail || "创建失败");
      setItems((prev) => [...prev, data]);
      setNewName("");
      setNewValue("");
      setNewDesc("");
      setShowValue(false);
      toast.success("密钥已保存");
    } catch (e: unknown) {
      toast.error((e as Error).message || "创建失败");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (keyId: string) => {
    setDeletingId(keyId);
    try {
      const res = await apiFetch(`/keychain/${keyId}`, {
        method: "DELETE",
        token: authToken,
      });
      if (!res.ok) throw new Error("删除失败");
      setItems((prev) => prev.filter((k) => k.key_id !== keyId));
      toast.success("密钥已删除");
    } catch (e: unknown) {
      toast.error((e as Error).message || "删除失败");
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div>
      <div className="an-pane-head">
        <div>
          <div className="an-pane-title">钥匙链</div>
          <div className="an-pane-sub">
            在频道消息中使用 <code>$secret&#123;名称&#125;</code> 引用密钥，Bot 会自动获取真实值。
          </div>
        </div>
      </div>
      <div className="an-list-table">
        {loading ? (
          <div className="an-row-card" style={{ justifyContent: "center", color: "var(--fg-3)" }}>
            加载中…
          </div>
        ) : items.length === 0 ? (
          <div className="an-row-card" style={{ justifyContent: "center", color: "var(--fg-3)" }}>
            暂无密钥
          </div>
        ) : (
          items.map((it) => (
            <div key={it.key_id} className="an-row-card">
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="an-rc-title">
                  <span style={{ fontFamily: "ui-monospace, monospace" }}>{it.name}</span>
                  <span
                    style={{
                      fontSize: 11,
                      color: "var(--fg-3)",
                      background: "var(--surface-soft)",
                      padding: "2px 6px",
                      borderRadius: 4,
                      fontFamily: "ui-monospace, monospace",
                    }}
                  >
                    {it.value_masked}
                  </span>
                </div>
                {it.description && <div className="an-rc-sub">{it.description}</div>}
              </div>
              <DangerButton onClick={() => remove(it.key_id)} disabled={deletingId === it.key_id}>
                {deletingId === it.key_id ? "删除中…" : "删除"}
              </DangerButton>
            </div>
          ))
        )}

        <div className="an-row-card" style={{ flexDirection: "column", alignItems: "stretch", gap: 10 }}>
          <div className="an-rc-title">添加新密钥</div>
          <Field label="名称">
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="如 openai-key"
              className={inputCls}
            />
          </Field>
          <Field label="密钥值">
            <div style={{ position: "relative" }}>
              <input
                type={showValue ? "text" : "password"}
                value={newValue}
                onChange={(e) => setNewValue(e.target.value)}
                className={inputCls}
                style={{ paddingRight: 60 }}
              />
              <button
                type="button"
                onClick={() => setShowValue((v) => !v)}
                style={{
                  position: "absolute",
                  right: 8,
                  top: "50%",
                  transform: "translateY(-50%)",
                  background: "transparent",
                  border: 0,
                  fontSize: 11,
                  color: "var(--fg-3)",
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
                tabIndex={-1}
              >
                {showValue ? "隐藏" : "显示"}
              </button>
            </div>
          </Field>
          <Field label="描述（可选）">
            <input
              type="text"
              value={newDesc}
              onChange={(e) => setNewDesc(e.target.value)}
              className={inputCls}
            />
          </Field>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <PrimaryButton onClick={create} disabled={saving || !newName.trim() || !newValue.trim()}>
              {saving ? "保存中…" : "保存密钥"}
            </PrimaryButton>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Friends pane ──────────────────────────────────────────────────────────

function FriendsPane({
  currentUserId,
  authToken,
}: {
  currentUserId: string;
  authToken: string | null;
}) {
  const [friends, setFriends] = useState<Friend[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<UserSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [directId, setDirectId] = useState("");

  const loadFriends = async () => {
    if (!currentUserId) return;
    setLoading(true);
    try {
      const res = await apiFetch(`/friends/${currentUserId}`, { token: authToken });
      const data = await res.json();
      if (data?.status === "success") setFriends(data.data || []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadFriends();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUserId]);

  useEffect(() => {
    const t = setTimeout(() => {
      if (searchQuery.trim()) {
        setSearching(true);
        apiFetch(
          `/friends/search?query=${encodeURIComponent(searchQuery)}&current_user_id=${encodeURIComponent(currentUserId)}`,
          { token: authToken },
        )
          .then((r) => r.json())
          .then((d) => setSearchResults(d?.data || []))
          .catch(() => {})
          .finally(() => setSearching(false));
      } else {
        setSearchResults([]);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [searchQuery, currentUserId, authToken]);

  const addByIdentifier = async (id: string) => {
    if (!id || !currentUserId) return;
    try {
      const res = await apiFetch("/friends", {
        method: "POST",
        token: authToken,
        body: { user_id: currentUserId, friend_identifier: id },
      });
      const data = await res.json();
      if (data?.status === "success") {
        toast.success(data.message || "添加成功");
        loadFriends();
        setDirectId("");
        setSearchQuery("");
        setSearchResults([]);
      } else {
        toast.error(data?.detail || "添加失败");
      }
    } catch {
      toast.error("添加失败");
    }
  };

  const removeFriend = async (friendId: string) => {
    if (!confirm("确定删除这个好友？")) return;
    try {
      const res = await apiFetch("/friends", {
        method: "DELETE",
        token: authToken,
        body: { user_id: currentUserId, friend_id: friendId },
      });
      const data = await res.json();
      if (data?.status === "success") {
        toast.success("已删除");
        loadFriends();
      } else {
        toast.error(data?.detail || "删除失败");
      }
    } catch {
      toast.error("删除失败");
    }
  };

  return (
    <div>
      <div className="an-pane-head">
        <div>
          <div className="an-pane-title">好友</div>
          <div className="an-pane-sub">
            {friends.length > 0 ? `共 ${friends.length} 位好友` : "暂无好友"}
          </div>
        </div>
      </div>
      <div className="an-list-table">
        <div className="an-row-card" style={{ flexDirection: "column", alignItems: "stretch", gap: 10 }}>
          <div className="an-rc-title">添加好友</div>
          <Field label="通过 UUID">
            <div style={{ display: "flex", gap: 6 }}>
              <input
                type="text"
                value={directId}
                onChange={(e) => setDirectId(e.target.value)}
                placeholder="粘贴好友 UUID"
                className={inputCls}
                style={{ flex: 1, fontFamily: "ui-monospace, monospace" }}
                onKeyDown={(e) => e.key === "Enter" && addByIdentifier(directId.trim())}
              />
              <PrimaryButton onClick={() => addByIdentifier(directId.trim())} disabled={!directId.trim()}>
                添加
              </PrimaryButton>
            </div>
          </Field>
          <Field label="或通过用户名搜索">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="输入用户名"
              className={inputCls}
            />
          </Field>
          {searching && (
            <div style={{ fontSize: 11, color: "var(--fg-3)" }}>搜索中…</div>
          )}
          {searchResults.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {searchResults.map((u) => (
                <div
                  key={u.user_id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "6px 8px",
                    background: "var(--surface-soft)",
                    borderRadius: 6,
                  }}
                >
                  <span
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: 6,
                      background: "var(--green)",
                      color: "#fff",
                      fontWeight: 700,
                      display: "inline-grid",
                      placeItems: "center",
                      fontSize: 12,
                    }}
                  >
                    {(u.display_name || u.username || "?").slice(0, 1).toUpperCase()}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, color: "var(--fg-1)" }}>{u.display_name || u.username}</div>
                    <div style={{ fontSize: 10, color: "var(--fg-3)" }}>@{u.username}</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => addByIdentifier(u.user_id)}
                    style={{
                      padding: "4px 10px",
                      fontSize: 11,
                      background: "var(--accent)",
                      color: "#fff",
                      border: 0,
                      borderRadius: 5,
                      cursor: "pointer",
                      fontFamily: "inherit",
                    }}
                  >
                    添加
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {loading ? (
          <div className="an-row-card" style={{ justifyContent: "center", color: "var(--fg-3)" }}>
            加载中…
          </div>
        ) : (
          friends.map((f) => (
            <div key={f.user_id} className="an-row-card">
              <span
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 6,
                  background: "var(--accent)",
                  color: "#fff",
                  fontWeight: 700,
                  display: "inline-grid",
                  placeItems: "center",
                  fontSize: 13,
                  flexShrink: 0,
                }}
              >
                {(f.display_name || f.username || "?").slice(0, 1).toUpperCase()}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="an-rc-title">{f.display_name || f.username}</div>
                <div className="an-rc-sub">@{f.username}</div>
              </div>
              <DangerButton onClick={() => removeFriend(f.user_id)}>移除</DangerButton>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ── Bulletin pane ─────────────────────────────────────────────────────────

type Issue = {
  issue_id: string;
  title: string;
  content: string | null;
  status: "open" | "closed" | "resolved";
  priority: "low" | "medium" | "high";
  tags: string[];
  creator_id: string | null;
  creator_name: string | null;
  created_at: string;
};

const PRIORITY_LABEL: Record<string, string> = { low: "低", medium: "中", high: "高" };

function BulletinPane({
  authToken,
  currentUserId,
  userRole,
}: {
  authToken: string | null;
  currentUserId: string;
  userRole: string;
}) {
  const [issues, setIssues] = useState<Issue[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newContent, setNewContent] = useState("");
  const [newPriority, setNewPriority] = useState<"low" | "medium" | "high">("medium");
  const [creating, setCreating] = useState(false);
  const isAdmin = userRole === "system_admin" || userRole === "space_admin";

  const reload = async () => {
    setLoading(true);
    try {
      const res = await apiFetch("/bulletin/issues", { token: authToken });
      const data = await res.json();
      if (data?.status === "success") setIssues(data.data || []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const create = async () => {
    if (!newTitle.trim()) return;
    setCreating(true);
    try {
      const res = await apiFetch("/bulletin/issues", {
        method: "POST",
        token: authToken,
        body: {
          title: newTitle.trim(),
          content: newContent || null,
          priority: newPriority,
          tags: [],
        },
      });
      if (res.ok) {
        setShowCreate(false);
        setNewTitle("");
        setNewContent("");
        setNewPriority("medium");
        reload();
        toast.success("已发布");
      } else {
        const d = await res.json();
        toast.error(d?.detail || "创建失败");
      }
    } finally {
      setCreating(false);
    }
  };

  const toggleStatus = async (issue: Issue) => {
    const next = issue.status === "open" ? "closed" : "open";
    const res = await apiFetch(`/bulletin/issues/${issue.issue_id}`, {
      method: "PATCH",
      token: authToken,
      body: { status: next },
    });
    if (res.ok) reload();
  };

  const remove = async (issue: Issue) => {
    if (!confirm(`确定删除「${issue.title}」？`)) return;
    const res = await apiFetch(`/bulletin/issues/${issue.issue_id}`, {
      method: "DELETE",
      token: authToken,
    });
    if (res.ok) reload();
  };

  const canManage = (issue: Issue) =>
    !!authToken && (issue.creator_id === currentUserId || isAdmin);

  return (
    <div>
      <div className="an-pane-head" style={{ justifyContent: "space-between" }}>
        <div>
          <div className="an-pane-title">留言板</div>
          <div className="an-pane-sub">公共反馈与变更记录。</div>
        </div>
        {authToken && (
          <PrimaryButton onClick={() => setShowCreate((v) => !v)}>
            {showCreate ? "取消" : "+ 新建"}
          </PrimaryButton>
        )}
      </div>
      <div className="an-list-table">
        {showCreate && (
          <div className="an-row-card" style={{ flexDirection: "column", alignItems: "stretch", gap: 10 }}>
            <div className="an-rc-title">新建 Issue</div>
            <Field label="标题">
              <input
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                className={inputCls}
                autoFocus
              />
            </Field>
            <Field label="详细描述（可选）">
              <textarea
                value={newContent}
                onChange={(e) => setNewContent(e.target.value)}
                rows={3}
                className={`${inputCls} resize-none`}
              />
            </Field>
            <Field label="优先级">
              <div className="an-seg">
                {(["low", "medium", "high"] as const).map((p) => (
                  <button
                    key={p}
                    type="button"
                    className={newPriority === p ? "on" : ""}
                    onClick={() => setNewPriority(p)}
                  >
                    {PRIORITY_LABEL[p]}
                  </button>
                ))}
              </div>
            </Field>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <PrimaryButton onClick={create} disabled={creating || !newTitle.trim()}>
                {creating ? "提交中…" : "提交"}
              </PrimaryButton>
            </div>
          </div>
        )}

        {loading ? (
          <div className="an-row-card" style={{ justifyContent: "center", color: "var(--fg-3)" }}>
            加载中…
          </div>
        ) : issues.length === 0 ? (
          <div className="an-row-card" style={{ justifyContent: "center", color: "var(--fg-3)" }}>
            暂无 Issue
          </div>
        ) : (
          issues.map((it) => (
            <div key={it.issue_id} className="an-row-card" style={{ alignItems: "flex-start" }}>
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  marginTop: 6,
                  background:
                    it.status === "open"
                      ? "var(--green)"
                      : it.status === "resolved"
                        ? "var(--accent)"
                        : "var(--fg-3)",
                  flexShrink: 0,
                }}
                title={it.status}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="an-rc-title">{it.title}</div>
                {it.content && (
                  <div
                    className="an-rc-sub"
                    style={{
                      whiteSpace: "pre-wrap",
                      maxHeight: 60,
                      overflow: "hidden",
                    }}
                  >
                    {it.content}
                  </div>
                )}
                <div className="an-rc-sub" style={{ marginTop: 4 }}>
                  {it.creator_name || "匿名"} · {PRIORITY_LABEL[it.priority]}优先级
                </div>
              </div>
              {canManage(it) && (
                <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                  <button
                    type="button"
                    onClick={() => toggleStatus(it)}
                    style={{
                      padding: "4px 8px",
                      fontSize: 11,
                      border: "1px solid var(--border)",
                      borderRadius: 5,
                      background: "transparent",
                      color: "var(--fg-2)",
                      cursor: "pointer",
                      fontFamily: "inherit",
                    }}
                  >
                    {it.status === "open" ? "关闭" : "开放"}
                  </button>
                  <DangerButton onClick={() => remove(it)}>删除</DangerButton>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ── Bot panes ─────────────────────────────────────────────────────────────

/** BotPane — top-level Bot view. Default state: a list of cards (one per
 *  bot, plus a "New Bot" card at the top). Selecting a card drills into
 *  the per-bot edit form (or the create form), with a back button that
 *  returns here. All drill state is local — the sidebar only sees "Bot". */
function BotPane({
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
      <div>
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
      // Bot disappeared (e.g. deleted in another window) — fall back to list.
      return (
        <div>
          <BackBar label="返回 Bot 列表" onBack={() => setView("list")} />
          <div className="an-row-card" style={{ color: "var(--fg-3)" }}>
            该 Bot 已不存在
          </div>
        </div>
      );
    }
    return (
      <div>
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
    <div>
      <div className="an-pane-head">
        <div>
          <div className="an-pane-title">Bot</div>
          <div className="an-pane-sub">
            管理你的 Bot。点击卡片查看详情或编辑。
          </div>
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
              <span
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 6,
                  background: "var(--accent)",
                  color: "#fff",
                  fontSize: 13,
                  fontWeight: 700,
                  display: "inline-grid",
                  placeItems: "center",
                  flexShrink: 0,
                }}
              >
                {(b.display_name || b.username || "?").slice(0, 1).toUpperCase()}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="an-rc-title">{b.display_name || b.username}</div>
                <div className="an-rc-sub">@{b.username}</div>
              </div>
              <span style={{ color: "var(--fg-3)", fontSize: 12 }}>›</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

function BackBar({ label, onBack }: { label: string; onBack: () => void }) {
  return (
    <button
      type="button"
      onClick={onBack}
      style={{
        background: "transparent",
        border: 0,
        color: "var(--fg-3)",
        fontSize: 12,
        padding: "4px 0",
        marginBottom: 8,
        cursor: "pointer",
        fontFamily: "inherit",
      }}
    >
      ← {label}
    </button>
  );
}

/** AccountPane — bundles 编辑资料 + 退出登录 as cards on a single pane.
 *  Profile editing is inline; logout is a separate destructive card at
 *  the bottom. */
function AccountPane({
  currentUser,
  authToken,
  onProfileUpdated,
  onLogout,
}: {
  currentUser: CurrentUser;
  authToken: string | null;
  onProfileUpdated: (data: { display_name: string; bio?: string }) => void;
  onLogout: () => void;
}) {
  if (!currentUser) {
    return (
      <div>
        <div className="an-pane-head">
          <div>
            <div className="an-pane-title">账户</div>
            <div className="an-pane-sub">尚未登录</div>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div>
      <ProfilePane
        currentUser={currentUser}
        authToken={authToken}
        onProfileUpdated={onProfileUpdated}
      />
      <div className="an-list-table" style={{ marginTop: 12 }}>
        <div className="an-row-card" style={{ justifyContent: "space-between" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="an-rc-title" style={{ color: "var(--red)" }}>退出登录</div>
            <div className="an-rc-sub">清除本地令牌并返回登录界面。</div>
          </div>
          <DangerButton onClick={onLogout}>退出登录</DangerButton>
        </div>
      </div>
    </div>
  );
}

type BindingType = "http" | "websocket";

type ModelItem = { model_id: string; name: string };
type TemplateItem = { template_id: string; name: string };

/** BotNewPane — two-step wizard.
 *  Step 1: pick the binding type (HTTP / WebSocket).
 *  Step 2: render type-specific fields. HTTP needs a model + template
 *  (fetched lazily when step 2 mounts); WebSocket only needs an optional
 *  agent_id which gets shipped as binding_config. */
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

  // HTTP-only
  const [models, setModels] = useState<ModelItem[]>([]);
  const [templates, setTemplates] = useState<TemplateItem[]>([]);
  const [modelId, setModelId] = useState("");
  const [templateId, setTemplateId] = useState("");

  // WebSocket-only
  const [agentId, setAgentId] = useState("");

  const [creating, setCreating] = useState(false);

  // Lazy-load models/templates when entering step 2 with HTTP selected.
  useEffect(() => {
    if (step !== 2 || bindingType !== "http") return;
    apiFetch("/admin/models?include_disabled=false", { token: authToken })
      .then((r) => r.json())
      .then((d) => {
        const list: ModelItem[] = Array.isArray(d?.data) ? d.data : [];
        setModels(list);
        if (!modelId && list.length > 0) setModelId(list[0].model_id);
      })
      .catch(() => setModels([]));
    apiFetch("/admin/templates", { token: authToken })
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
      binding_type: bindingType,
      status: "online",
      is_public: true,
    };
    if (bindingType === "http") {
      body.model_id = modelId;
      body.template_id = templateId;
    } else {
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
        onCreated(data.data);
      } else {
        toast.error(data?.message || data?.detail || "创建失败");
      }
    } catch (e: unknown) {
      toast.error((e as Error).message || "创建失败");
    } finally {
      setCreating(false);
    }
  };

  if (step === 1) {
    return (
      <div>
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
            id="websocket"
            active={bindingType === "websocket"}
            title="WebSocket Bot"
            sub="由 OpenClaw plugin 反向连接，能力由 plugin 提供，无需绑定模型。"
            onClick={() => setBindingType("websocket")}
          />
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <PrimaryButton onClick={() => setStep(2)}>下一步 →</PrimaryButton>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="an-pane-head">
        <div>
          <div className="an-pane-title">
            新建 Bot · {bindingType === "http" ? "HTTP" : "WebSocket"} 配置
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
          <Field label="描述（可选）">
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className={`${inputCls} resize-none`}
            />
          </Field>
        </div>

        {bindingType === "http" && (
          <div className="an-row-card" style={{ flexDirection: "column", alignItems: "stretch", gap: 10 }}>
            <div className="an-rc-title">LLM 绑定</div>
            <Field label="AI 模型">
              <select
                value={modelId}
                onChange={(e) => setModelId(e.target.value)}
                className={inputCls}
              >
                {models.length === 0 ? (
                  <option value="">（无可用模型，请先到管理后台创建）</option>
                ) : (
                  models.map((m) => (
                    <option key={m.model_id} value={m.model_id}>
                      {m.name}
                    </option>
                  ))
                )}
              </select>
            </Field>
            <Field label="Prompt 模板">
              <select
                value={templateId}
                onChange={(e) => setTemplateId(e.target.value)}
                className={inputCls}
              >
                {templates.length === 0 ? (
                  <option value="">（无可用模板，请先到管理后台创建）</option>
                ) : (
                  templates.map((t) => (
                    <option key={t.template_id} value={t.template_id}>
                      {t.name}
                    </option>
                  ))
                )}
              </select>
            </Field>
          </div>
        )}

        {bindingType === "websocket" && (
          <div className="an-row-card" style={{ flexDirection: "column", alignItems: "stretch", gap: 10 }}>
            <div className="an-rc-title">OpenClaw 绑定</div>
            <div className="an-rc-sub" style={{ marginTop: 0 }}>
              创建后将得到一次性的 bot token，把它填到 plugin 配置里，plugin 连
              <code style={{ background: "var(--surface-soft)", padding: "0 4px", borderRadius: 3, margin: "0 2px" }}>
                /ws/openclaw/control
              </code>
              和
              <code style={{ background: "var(--surface-soft)", padding: "0 4px", borderRadius: 3, margin: "0 2px" }}>
                /ws/openclaw/data
              </code>
              即可接管该 Bot。
            </div>
            <Field label="OpenClaw agent id（可选）">
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
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Reset form when switching between bots
  useMemo(() => {
    setDisplayName(bot.display_name || "");
    setDescription(bot.description || "");
  }, [bot.bot_id]);

  const save = async () => {
    setSaving(true);
    try {
      const res = await apiFetch(`/bots/${bot.bot_id}`, {
        method: "PUT",
        token: authToken,
        body: {
          display_name: displayName.trim() || bot.username,
          description: description.trim() || null,
        },
      });
      const data = await res.json();
      if (data?.status === "success") {
        toast.success("已保存");
        onUpdated();
      } else {
        toast.error(data?.message || data?.detail || "保存失败");
      }
    } catch (e: unknown) {
      toast.error((e as Error).message || "保存失败");
    } finally {
      setSaving(false);
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

  return (
    <div>
      <div className="an-pane-head">
        <div>
          <div className="an-pane-title">{bot.display_name || bot.username}</div>
          <div className="an-pane-sub">@{bot.username} · {bot.bot_id}</div>
        </div>
      </div>
      <div className="an-list-table">
        <div className="an-row-card" style={{ flexDirection: "column", alignItems: "stretch", gap: 10 }}>
          <div className="an-rc-title">基本信息</div>
          <Field label="显示名称">
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field label="描述">
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className={`${inputCls} resize-none`}
            />
          </Field>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <DangerButton onClick={remove} disabled={deleting}>
              {deleting ? "删除中…" : "删除 Bot"}
            </DangerButton>
            <PrimaryButton onClick={save} disabled={saving}>
              {saving ? "保存中…" : "保存"}
            </PrimaryButton>
          </div>
        </div>
        <div className="an-row-card" style={{ color: "var(--fg-3)", fontSize: 12 }}>
          高级配置（模型、提示词、Token）请在管理后台调整。
        </div>
      </div>
    </div>
  );
}
