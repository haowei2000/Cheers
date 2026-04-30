import { useEffect, useRef, useState, type ReactNode } from "react";
import toast from "react-hot-toast";
import { ChatBubbleLeftIcon } from "@heroicons/react/24/solid";
import type { CurrentUser, Friend } from "../types";
import { apiFetch } from "../api";
import { AVATAR_ACCEPT, uploadAvatarImage } from "../lib/avatar";
import { BotAvatar } from "./BotAvatar";
import { Modal } from "./Modal";
import { SearchPicker } from "./SearchPicker";

type Density = "comfy" | "compact";
type BotScope = "private" | "friend" | "everyone";

const DENSITY_KEY = "agentnexus-density";

export function getStoredDensity(): Density {
  if (typeof window === "undefined") return "comfy";
  const v = localStorage.getItem(DENSITY_KEY);
  return v === "compact" ? "compact" : "comfy";
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
  onProfileUpdated: (data: { display_name: string; bio?: string | null; avatar_url?: string | null }) => void;
  onOpenDM?: (memberId: string, memberType: "user" | "bot") => void;
  onLogout: () => void;
}

type BotRow = {
  bot_id: string;
  username: string;
  display_name?: string | null;
  description?: string | null;
  avatar_url?: string | null;
  status?: string;
  binding_type?: "http" | "websocket" | string;
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
  const isWs = (bot.binding_type || "http") === "websocket";
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
      label: "WS 在线",
      color: "var(--green)",
      bg: "var(--green-muted)",
      title: "control/data 连接均在线",
    };
  }
  if (bot.connection_status === "partial") {
    return {
      label: "WS 部分连接",
      color: "var(--yellow)",
      bg: "rgba(251, 191, 36, 0.16)",
      title: `control: ${bot.control_connected ? "在线" : "离线"} · data: ${bot.data_connected ? "在线" : "离线"}`,
    };
  }
  return {
    label: "WS 离线",
    color: "var(--red)",
    bg: "var(--red-muted)",
    title: "OpenClaw channel plugin 未连接",
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
  onOpenDM,
  onLogout,
}: SettingsModalProps) {
  const [pane, setPane] = useState<Pane>("bot");
  const [density, setDensityState] = useState<Density>(() => getStoredDensity());
  const [bots, setBots] = useState<BotRow[]>([]);
  const canManageBuiltinBots = currentUser?.role === "system_admin";
  const visibleBots = bots.filter(
    (b) =>
      b.can_manage ||
      b.created_by === currentUser?.user_id ||
      (canManageBuiltinBots && b.is_builtin),
  );

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

  const NAV_ITEMS: { id: Pane; ico: ReactNode; label: string }[] = [
    { id: "bot", ico: "◉", label: "Bot" },
    { id: "account", ico: "◉", label: "账户" },
    { id: "friends", ico: "◎", label: "好友" },
    { id: "appearance", ico: "◐", label: "外观" },
    {
      id: "bulletin",
      ico: <ChatBubbleLeftIcon className="inline-block w-3.5 h-3.5 align-text-bottom" />,
      label: "留言板",
    },
    { id: "other", ico: "⌘", label: "其他" },
  ];

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="设置 · Settings"
      maxWidth="max-w-3xl"
      panelClassName="overflow-hidden"
    >
      <div className="an-modal-body -mx-5 -my-4">
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
                bots={visibleBots}
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
                onOpenDM={onOpenDM}
              />
            )}
            {pane === "appearance" && (
              <AppearancePane
                isDark={isDark}
                setTheme={setTheme}
                density={density}
                setDensity={changeDensity}
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
    </Modal>
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

function AvatarPreview({
  label,
  avatarUrl,
  fallback,
  size = 44,
}: {
  label: string;
  avatarUrl?: string | null;
  fallback: string;
  size?: number;
}) {
  if (avatarUrl) {
    return (
      <img
        src={avatarUrl}
        alt={label}
        title={label}
        style={{
          width: size,
          height: size,
          borderRadius: 8,
          objectFit: "cover",
          flexShrink: 0,
          border: "1px solid var(--border)",
          background: "var(--surface-soft)",
        }}
      />
    );
  }
  return (
    <span
      title={label}
      style={{
        width: size,
        height: size,
        borderRadius: 8,
        background: "var(--accent)",
        color: "#fff",
        fontWeight: 700,
        fontSize: Math.max(12, Math.round(size * 0.42)),
        display: "inline-grid",
        placeItems: "center",
        flexShrink: 0,
      }}
    >
      {fallback}
    </span>
  );
}

// ── Appearance pane ───────────────────────────────────────────────────────

function AppearancePane({
  isDark,
  setTheme,
  density,
  setDensity,
}: {
  isDark: boolean;
  setTheme: (t: "light" | "dark") => void;
  density: Density;
  setDensity: (d: Density) => void;
}) {
  return (
    <div className="an-pane">
      <div className="an-pane-head">
        <div>
          <div className="an-pane-title">外观</div>
          <div className="an-pane-sub">主题与密度。</div>
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
  onProfileUpdated: (data: { display_name: string; bio?: string | null; avatar_url?: string | null }) => void;
}) {
  const [displayName, setDisplayName] = useState(currentUser.display_name || "");
  const [bio, setBio] = useState("");
  const [email, setEmail] = useState("");
  const [avatarUrl, setAvatarUrl] = useState(currentUser.avatar_url || "");
  const avatarInputRef = useRef<HTMLInputElement | null>(null);
  const [avatarUploading, setAvatarUploading] = useState(false);
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
        const user = d?.data || d;
        if (typeof user?.display_name === "string") setDisplayName(user.display_name || "");
        if (typeof user?.bio === "string") setBio(user.bio || "");
        if (typeof user?.email === "string") setEmail(user.email || "");
        if (user && "avatar_url" in user) setAvatarUrl(user.avatar_url || "");
      })
      .catch(() => {});
  }, [authToken]);

  const saveProfile = async () => {
    setSaving(true);
    try {
      const res = await apiFetch("/auth/users/me", {
        method: "PUT",
        token: authToken,
        body: {
          display_name: displayName,
          bio,
          avatar_url: avatarUrl.trim() || null,
        },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.detail || "保存失败");
      const user = data?.data || data;
      onProfileUpdated({
        display_name: user?.display_name || displayName,
        bio: user?.bio ?? bio,
        avatar_url: user?.avatar_url ?? (avatarUrl.trim() || null),
      });
      setAvatarUrl(user?.avatar_url || avatarUrl.trim());
      toast.success("个人资料已更新");
    } catch (e: unknown) {
      toast.error((e as Error).message || "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const uploadProfileAvatar = async (file: File | null | undefined) => {
    if (!file) return;
    setAvatarUploading(true);
    try {
      const uploaded = await uploadAvatarImage("/avatars/users/me", file, authToken);
      setAvatarUrl(uploaded.avatar_url);
      onProfileUpdated({
        display_name: displayName || currentUser.display_name,
        bio,
        avatar_url: uploaded.avatar_url,
      });
      toast.success("头像已上传");
    } catch (e: unknown) {
      toast.error((e as Error).message || "头像上传失败");
    } finally {
      setAvatarUploading(false);
      if (avatarInputRef.current) avatarInputRef.current.value = "";
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
    <div className="an-pane">
      <div className="an-pane-head">
        <div>
          <div className="an-pane-title">编辑资料</div>
          <div className="an-pane-sub">显示名称、个人简介与密码。</div>
        </div>
      </div>
      <div className="an-list-table">
        <div className="an-row-card" style={{ alignItems: "flex-start", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, width: "100%" }}>
            <AvatarPreview
              label={displayName || currentUser.username}
              avatarUrl={avatarUrl}
              fallback={initial}
            />
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
          <Field label="头像">
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                type="url"
                value={avatarUrl}
                onChange={(e) => setAvatarUrl(e.target.value)}
                placeholder="https://example.com/avatar.png"
                className={inputCls}
                style={{ flex: 1 }}
              />
              <input
                ref={avatarInputRef}
                type="file"
                accept={AVATAR_ACCEPT}
                onChange={(e) => uploadProfileAvatar(e.target.files?.[0])}
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
    <div className="an-pane">
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
  onOpenDM,
}: {
  currentUserId: string;
  authToken: string | null;
  onOpenDM?: (memberId: string, memberType: "user" | "bot") => void;
}) {
  type FriendTab = "friends" | "incoming" | "outgoing" | "blocked";
  const [friends, setFriends] = useState<Friend[]>([]);
  const [incoming, setIncoming] = useState<Friend[]>([]);
  const [outgoing, setOutgoing] = useState<Friend[]>([]);
  const [blocked, setBlocked] = useState<Friend[]>([]);
  const [loading, setLoading] = useState(false);
  const [directId, setDirectId] = useState("");
  const [tab, setTab] = useState<FriendTab>("friends");

  const loadAll = async () => {
    if (!currentUserId) return;
    setLoading(true);
    try {
      const [friendsRes, incomingRes, outgoingRes, blockedRes] = await Promise.all([
        apiFetch("/friends", { token: authToken }),
        apiFetch("/friends/requests?box=incoming", { token: authToken }),
        apiFetch("/friends/requests?box=outgoing", { token: authToken }),
        apiFetch("/friends/blocked/list", { token: authToken }),
      ]);
      const [friendsData, incomingData, outgoingData, blockedData] = await Promise.all([
        friendsRes.json(),
        incomingRes.json(),
        outgoingRes.json(),
        blockedRes.json(),
      ]);
      if (friendsData?.status === "success") setFriends(friendsData.data || []);
      if (incomingData?.status === "success") setIncoming(incomingData.data || []);
      if (outgoingData?.status === "success") setOutgoing(outgoingData.data || []);
      if (blockedData?.status === "success") setBlocked(blockedData.data || []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUserId]);

  const addByIdentifier = async (id: string) => {
    if (!id || !currentUserId) return;
    try {
      const res = await apiFetch("/friends/requests", {
        method: "POST",
        token: authToken,
        body: { friend_identifier: id },
      });
      const data = await res.json();
      if (data?.status === "success") {
        toast.success(data.message || "好友申请已发送");
        loadAll();
        setDirectId("");
      } else {
        toast.error(data?.detail || data?.message || "添加失败");
      }
    } catch {
      toast.error("添加失败");
    }
  };

  const resolveRequest = async (friendshipId: string, action: "accept" | "reject") => {
    try {
      const res = await apiFetch(`/friends/requests/${friendshipId}/${action}`, {
        method: "POST",
        token: authToken,
      });
      const data = await res.json();
      if (data?.status === "success") {
        toast.success(action === "accept" ? "已同意好友申请" : "已拒绝好友申请");
        loadAll();
      } else {
        toast.error(data?.detail || data?.message || "操作失败");
      }
    } catch {
      toast.error("操作失败");
    }
  };

  const cancelRequest = async (friendshipId: string) => {
    try {
      const res = await apiFetch(`/friends/requests/${friendshipId}`, {
        method: "DELETE",
        token: authToken,
      });
      const data = await res.json();
      if (data?.status === "success") {
        toast.success("已撤回好友申请");
        loadAll();
      } else {
        toast.error(data?.detail || data?.message || "撤回失败");
      }
    } catch {
      toast.error("撤回失败");
    }
  };

  const removeFriend = async (friendId: string) => {
    if (!confirm("确定删除这个好友？")) return;
    try {
      const res = await apiFetch(`/friends/${friendId}`, {
        method: "DELETE",
        token: authToken,
      });
      const data = await res.json();
      if (data?.status === "success") {
        toast.success("已删除");
        loadAll();
      } else {
        toast.error(data?.detail || data?.message || "删除失败");
      }
    } catch {
      toast.error("删除失败");
    }
  };

  const blockFriend = async (friendId: string) => {
    if (!confirm("确定拉黑这个用户？")) return;
    try {
      const res = await apiFetch("/friends/blocked", {
        method: "POST",
        token: authToken,
        body: { friend_identifier: friendId },
      });
      const data = await res.json();
      if (data?.status === "success") {
        toast.success("已拉黑");
        loadAll();
      } else {
        toast.error(data?.detail || data?.message || "拉黑失败");
      }
    } catch {
      toast.error("拉黑失败");
    }
  };

  const unblockFriend = async (friendId: string) => {
    try {
      const res = await apiFetch(`/friends/blocked/${friendId}`, {
        method: "DELETE",
        token: authToken,
      });
      const data = await res.json();
      if (data?.status === "success") {
        toast.success("已解除拉黑");
        loadAll();
      } else {
        toast.error(data?.detail || data?.message || "解除失败");
      }
    } catch {
      toast.error("解除失败");
    }
  };

  const rowAvatar = (u: Pick<Friend, "display_name" | "username">, bg = "var(--accent)") => (
    <span
      style={{
        width: 32,
        height: 32,
        borderRadius: 6,
        background: bg,
        color: "#fff",
        fontWeight: 700,
        display: "inline-grid",
        placeItems: "center",
        fontSize: 13,
        flexShrink: 0,
      }}
    >
      {(u.display_name || u.username || "?").slice(0, 1).toUpperCase()}
    </span>
  );

  const smallButton = (label: string, onClick: () => void, danger = false, disabled = false) => (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "5px 9px",
        borderRadius: 6,
        border: danger ? "1px solid var(--red)" : "1px solid var(--border)",
        background: "transparent",
        color: danger ? "var(--red)" : "var(--fg-2)",
        fontSize: 11,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        fontFamily: "inherit",
      }}
    >
      {label}
    </button>
  );

  const renderPersonRow = (f: Friend, mode: FriendTab) => (
    <div key={`${mode}-${f.friendship_id || f.user_id}`} className="an-row-card">
      {rowAvatar(f)}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="an-rc-title">{f.display_name || f.username}</div>
        <div className="an-rc-sub">@{f.username}</div>
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
        {mode === "friends" && (
          <>
            {smallButton("私信", () => onOpenDM?.(f.user_id, "user"))}
            {smallButton("拉黑", () => blockFriend(f.user_id), true)}
            <DangerButton onClick={() => removeFriend(f.user_id)}>移除</DangerButton>
          </>
        )}
        {mode === "incoming" && f.friendship_id && (
          <>
            {smallButton("拒绝", () => resolveRequest(f.friendship_id!, "reject"), true)}
            {smallButton("同意", () => resolveRequest(f.friendship_id!, "accept"))}
          </>
        )}
        {mode === "outgoing" && f.friendship_id && (
          <DangerButton onClick={() => cancelRequest(f.friendship_id!)}>撤回</DangerButton>
        )}
        {mode === "blocked" && (
          <PrimaryButton onClick={() => unblockFriend(f.user_id)}>解除</PrimaryButton>
        )}
      </div>
    </div>
  );

  const visibleRows =
    tab === "friends" ? friends : tab === "incoming" ? incoming : tab === "outgoing" ? outgoing : blocked;

  return (
    <div className="an-pane">
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
                发送申请
              </PrimaryButton>
            </div>
          </Field>
          <Field label="或通过用户名搜索">
            <SearchPicker
              context="add_friend"
              token={authToken}
              modal
              placeholder="输入用户名"
              actionLabel="添加"
              onSelect={(selection) => {
                if (selection.type === "user") addByIdentifier(selection.item.user_id);
              }}
            />
          </Field>
        </div>

        <div className="an-seg" style={{ alignSelf: "flex-start", margin: "2px 0" }}>
          {[
            ["friends", `好友 ${friends.length}`],
            ["incoming", `收到 ${incoming.length}`],
            ["outgoing", `已发送 ${outgoing.length}`],
            ["blocked", `黑名单 ${blocked.length}`],
          ].map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={tab === id ? "on" : ""}
              onClick={() => setTab(id as FriendTab)}
            >
              {label}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="an-row-card" style={{ justifyContent: "center", color: "var(--fg-3)" }}>
            加载中…
          </div>
        ) : visibleRows.length === 0 ? (
          <div className="an-row-card" style={{ justifyContent: "center", color: "var(--fg-3)" }}>
            暂无内容
          </div>
        ) : (
          visibleRows.map((f) => renderPersonRow(f, tab))
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
    <div className="an-pane">
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

/** BotPane — top-level Bot view, segmented into three sub-tabs:
 *  Bot (list+CRUD) / 消息模板 / LLM 模型. Each sub-tab is a self-contained
 *  pane that keeps Bot, template, and model setup inside the modal settings
 *  flow. */
type BotSubTab = "bots" | "templates" | "models";

function BotPane({
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
                size={32}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="an-rc-title">{b.display_name || b.username}</div>
                <div className="an-rc-sub">
                  @{b.username} · {(b.binding_type || "http") === "websocket" ? "WebSocket" : "HTTP"}
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

// ── Templates sub-pane ──────────────────────────────────────────────────

type TemplateRow = {
  template_id: string;
  name: string;
  description?: string | null;
  system_prompt: string;
  user_template: string;
  variables?: string[];
  is_builtin?: boolean;
};

function TemplateListSubPane({ authToken }: { authToken: string | null }) {
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
  // Preserve the original system_prompt/description on edit so we don't wipe
  // server-side data when the user can't see those fields anymore.
  const preservedSystemPrompt = existing?.system_prompt || "";
  const preservedDescription = existing?.description || "";
  // Variable autocomplete on userTemplate (triggered by `{{`)
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

// ── Models sub-pane ─────────────────────────────────────────────────────

type ModelRow = {
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

function ModelListSubPane({ authToken }: { authToken: string | null }) {
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

function BackBar({ label, onBack }: { label: string; onBack: () => void }) {
  return (
    <button
      type="button"
      onClick={onBack}
      className="an-back"
      style={{
        background: "transparent",
        border: 0,
        color: "var(--fg-3)",
        fontSize: 12,
        padding: "4px 0",
        marginBottom: 8,
        cursor: "pointer",
        fontFamily: "inherit",
        flexShrink: 0,
        textAlign: "left",
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
  onProfileUpdated: (data: { display_name: string; bio?: string | null; avatar_url?: string | null }) => void;
  onLogout: () => void;
}) {
  if (!currentUser) {
    return (
      <div className="an-pane">
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
    <div className="an-pane">
      <ProfilePane
        currentUser={currentUser}
        authToken={authToken}
        onProfileUpdated={onProfileUpdated}
      />
      <div
        className="an-row-card"
        style={{ justifyContent: "space-between", marginTop: 12, flexShrink: 0 }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="an-rc-title" style={{ color: "var(--red)" }}>退出登录</div>
          <div className="an-rc-sub">清除本地令牌并返回登录界面。</div>
        </div>
        <DangerButton onClick={onLogout}>退出登录</DangerButton>
      </div>
    </div>
  );
}

type BindingType = "http" | "websocket";

type ModelItem = { model_id: string; name: string; model_name?: string; provider?: string; is_enabled?: boolean };
type TemplateItem = { template_id: string; name: string };

/** BotNewPane — two-step wizard.
 *  Step 1: pick the binding type (HTTP / WebSocket).
 *  Step 2: render type-specific fields. HTTP needs a model; both HTTP and
 *  WebSocket can pick a prompt template. */
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

  // WebSocket-only
  const [agentId, setAgentId] = useState("");

  const [creating, setCreating] = useState(false);

  // Set after a successful WebSocket bot creation: holds the one-shot
  // plaintext token returned by the backend so the user can copy it into
  // their OpenClaw plugin config before we navigate away.
  const [issued, setIssued] = useState<{ token: string; bot: BotRow } | null>(null);

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
        if (bindingType === "websocket" && created?.bot_token) {
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
            <div className="an-pane-title">Bot 已创建 · 保存 OpenClaw Token</div>
            <div className="an-pane-sub">
              这是一次性明文 token，关闭此页面后将无法再查看。请立即复制并填入
              OpenClaw plugin 配置；之后只能通过"轮换 token"重新生成。
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
                /ws/openclaw/control
              </code>
              和
              <code style={{ background: "var(--surface-soft)", padding: "0 4px", borderRadius: 3, margin: "0 2px" }}>
                /ws/openclaw/data
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
            id="websocket"
            active={bindingType === "websocket"}
            title="WebSocket Bot"
            sub="由 OpenClaw plugin 反向连接，能力由 plugin 提供，可绑定 Prompt 模板。"
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
    <div className="an-pane">
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
          <Field label="头像 URL">
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <BotAvatar
                label={displayName || username || "Bot"}
                avatarUrl={avatarUrl}
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
          <Field label={bindingType === "websocket" ? "发送给 plugin 的任务模板" : "Prompt 模板"}>
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
          {bindingType === "websocket" && (
            <div className="an-rc-sub" style={{ marginTop: 0 }}>
              模板会在后端渲染成最终任务文本，再通过 WebSocket 下发给 OpenClaw plugin。
            </div>
          )}
        </div>

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

  return (
    <div className="an-pane">
      <div className="an-pane-head">
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
          <BotAvatar
            label={displayName || bot.username}
            avatarUrl={avatarUrl}
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
            <div className="an-rc-sub">类型：{(bot.binding_type || "http") === "websocket" ? "WebSocket" : "HTTP"}</div>
            <div className="an-rc-sub">状态：{bot.status || "online"}</div>
            {(bot.binding_type || "http") === "websocket" && (
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
        {isHttpBot && (
          <div className="an-row-card" style={{ flexDirection: "column", alignItems: "stretch", gap: 10 }}>
            <div className="an-rc-title">LLM 模型</div>
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
              模板会在后端渲染成最终任务文本，再通过 WebSocket 下发给 OpenClaw plugin。
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
          高级配置已收敛到设置弹窗；HTTP Bot 可在此切换模型与模板，WebSocket Bot 可切换任务模板。
        </div>
      </div>
    </div>
  );
}
