import { useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import type { CurrentUser } from "../../../types";
import { apiFetch } from "../../../api";
import { AVATAR_ACCEPT, uploadAvatarImage } from "../../../lib/avatar";
import { DangerButton, Field, PrimaryButton, inputCls } from "../shared/SettingsControls";

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

export function KeychainPane({ authToken }: { authToken: string }) {
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

/** AccountPane — bundles 编辑资料 + 退出登录 as cards on a single pane.
 *  Profile editing is inline; logout is a separate destructive card at
 *  the bottom. */
export function AccountPane({
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
