import { useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import type { CurrentUser } from "../../../types";
import { apiFetch } from "../../../api";
import { AVATAR_ACCEPT, uploadAvatarImage } from "../../../lib/avatar";
import { AvatarVisual } from "../../../components/AvatarVisual";
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
      <AvatarVisual
        avatarUrl={avatarUrl}
        label={label}
        fallback={fallback}
        radius={8}
        size={size}
        style={{
          border: "1px solid var(--border)",
          background: "var(--surface-soft)",
        }}
        title={label}
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

function isManagedAvatarUrl(value: string, kindPlural: "users" | "bots" | "workspaces"): boolean {
  return value.startsWith(`/api/v1/avatars/${kindPlural}/`) ||
    value.includes(`/api/v1/avatars/${kindPlural}/`);
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
  const [accountTab, setAccountTab] =
    useState<"profile" | "security">("profile");

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
      if (!res.ok) throw new Error(data?.detail || "Save failed");
      const user = data?.data || data;
      onProfileUpdated({
        display_name: user?.display_name || displayName,
        bio: user?.bio ?? bio,
        avatar_url: user?.avatar_url ?? (avatarUrl.trim() || null),
      });
      setAvatarUrl(user?.avatar_url || avatarUrl.trim());
      toast.success("Profile updated");
    } catch (e: unknown) {
      toast.error((e as Error).message || "Save failed");
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
      toast.success("Avatar uploaded");
    } catch (e: unknown) {
      toast.error((e as Error).message || "Avatar upload failed");
    } finally {
      setAvatarUploading(false);
      if (avatarInputRef.current) avatarInputRef.current.value = "";
    }
  };

  const clearProfileAvatar = async () => {
    if (!avatarUrl) return;
    if (!isManagedAvatarUrl(avatarUrl, "users")) {
      setAvatarUrl("");
      return;
    }
    try {
      const res = await apiFetch("/avatars/users/me", {
        method: "DELETE",
        token: authToken,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.status === "error") {
        throw new Error(data?.message || data?.detail || "Avatar clear failed");
      }
      setAvatarUrl("");
      onProfileUpdated({
        display_name: displayName || currentUser.display_name,
        bio,
        avatar_url: null,
      });
      toast.success("Avatar cleared");
    } catch (e: unknown) {
      toast.error((e as Error).message || "Avatar clear failed");
    }
  };

  const sendEmailCode = async () => {
    if (!email) {
      toast.error("Account has no email bound");
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
      if (!res.ok) throw new Error(data?.detail || "Send failed");
      setEmailCodeSent(true);
      toast.success(`Verification code sent to ${email}`);
    } catch (e: unknown) {
      toast.error((e as Error).message || "Send failed");
    } finally {
      setEmailCodeLoading(false);
    }
  };

  const changePassword = async () => {
    if (!newPassword || newPassword !== confirmPassword) {
      toast.error("The two new passwords do not match");
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
      if (!res.ok) throw new Error(data?.detail || "Password update failed");
      toast.success("Password updated");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setEmailCode("");
      setEmailCodeSent(false);
    } catch (e: unknown) {
      toast.error((e as Error).message || "Password update failed");
    } finally {
      setPwSaving(false);
    }
  };

  const initial = (displayName || currentUser.username || "?").slice(0, 1).toUpperCase();

  return (
    <div className="an-pane">
      <div
        className="an-pane-head"
        style={{ justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}
      >
        <div>
          <div className="an-pane-title">
            {accountTab === "profile" ? "Edit profile" : "Account security"}
          </div>
          <div className="an-pane-sub">
            {accountTab === "profile"
              ? "Display name, avatar, and bio."
              : "Account identity and password verification."}
          </div>
        </div>
        <div className="an-seg" role="tablist" aria-label="Account settings view">
          <button
            type="button"
            className={accountTab === "profile" ? "on" : ""}
            onClick={() => setAccountTab("profile")}
            role="tab"
            aria-selected={accountTab === "profile"}
          >
            Profile
          </button>
          <button
            type="button"
            className={accountTab === "security" ? "on" : ""}
            onClick={() => setAccountTab("security")}
            role="tab"
            aria-selected={accountTab === "security"}
          >
            Security
          </button>
        </div>
      </div>
      <div className="an-list-table">
        {accountTab === "profile" && (
          <>
            <div className="an-row-card" style={{ alignItems: "center", gap: 12 }}>
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

            <div className="an-row-card" style={{ flexDirection: "column", alignItems: "stretch", gap: 12 }}>
              <div className="an-rc-title">Basic information</div>
              <Field label="Display name">
                <input
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  className={inputCls}
                />
              </Field>
              <Field label="Avatar">
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
                    className="an-btn an-btn-sm"
                  >
                    {avatarUploading ? "Uploading..." : "Upload"}
                  </button>
                  {avatarUrl && (
                    <button
                      type="button"
                      onClick={() => void clearProfileAvatar()}
                      className="an-btn an-btn-sm"
                    >
                      Clear
                    </button>
                  )}
                </div>
              </Field>
              <Field label="Bio">
                <textarea
                  value={bio}
                  onChange={(e) => setBio(e.target.value)}
                  rows={3}
                  className={`${inputCls} resize-none`}
                />
              </Field>
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <PrimaryButton onClick={saveProfile} disabled={saving}>
                  {saving ? "Saving..." : "Save profile"}
                </PrimaryButton>
              </div>
            </div>
          </>
        )}

        {accountTab === "security" && (
          <>
            <div className="an-row-card" style={{ flexDirection: "column", alignItems: "stretch", gap: 12 }}>
              <div className="an-rc-title">Account identity</div>
              <Field label="UUID (shareable with friends)">
                <div style={{ display: "flex", gap: 6 }}>
                  <code className="an-code-pill" style={{ flex: 1 }}>
                    {currentUser.user_id}
                  </code>
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard.writeText(currentUser.user_id);
                      toast.success("UUID copied");
                    }}
                    className="an-btn an-btn-sm"
                  >
                    Copy
                  </button>
                </div>
              </Field>
            </div>

            <div className="an-row-card" style={{ flexDirection: "column", alignItems: "stretch", gap: 12 }}>
              <div className="an-rc-title">Change password</div>
              <div className="an-seg" style={{ alignSelf: "flex-start" }}>
                <button
                  type="button"
                  className={pwMode === "password" ? "on" : ""}
                  onClick={() => setPwMode("password")}
                >
                  Password verification
                </button>
                <button
                  type="button"
                  className={pwMode === "email" ? "on" : ""}
                  onClick={() => setPwMode("email")}
                >
                  Email verification
                </button>
              </div>
              {pwMode === "password" ? (
                <Field label="Current password">
                  <input
                    type="password"
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    className={inputCls}
                    autoComplete="current-password"
                  />
                </Field>
              ) : (
                <Field label={`Email verification code${email ? ` (sent to ${email})` : "(account has no email bound)"}`}>
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
                        className="an-btn an-btn-sm"
                      >
                        {emailCodeLoading ? "Sending..." : emailCodeSent ? "Resend" : "Get code"}
                      </button>
                    </div>
                  ) : (
                    <div className="an-text-danger">Account has no email bound,Email verification is unavailable</div>
                  )}
                </Field>
              )}
              <Field label="New password">
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className={inputCls}
                  autoComplete="new-password"
                />
              </Field>
              <Field label="Confirm new password">
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
                  {pwSaving ? "Updating..." : "Update password"}
                </PrimaryButton>
              </div>
            </div>
          </>
        )}
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
      if (!res.ok) throw new Error(data?.detail || "Create failed");
      setItems((prev) => [...prev, data]);
      setNewName("");
      setNewValue("");
      setNewDesc("");
      setShowValue(false);
      toast.success("Secret saved");
    } catch (e: unknown) {
      toast.error((e as Error).message || "Create failed");
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
      if (!res.ok) throw new Error("Delete failed");
      setItems((prev) => prev.filter((k) => k.key_id !== keyId));
      toast.success("Secret deleted");
    } catch (e: unknown) {
      toast.error((e as Error).message || "Delete failed");
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="an-pane">
      <div className="an-pane-head">
        <div>
          <div className="an-pane-title">Keychain</div>
          <div className="an-pane-sub">
            Use <code>$secret&#123;Name&#125;</code> in channel messages to reference a secret. Bots will automatically receive the real value.
          </div>
        </div>
      </div>
      <div className="an-list-table">
        {loading ? (
          <div className="an-row-card" style={{ justifyContent: "center", color: "var(--fg-3)" }}>
            Loading...
          </div>
        ) : items.length === 0 ? (
          <div className="an-row-card" style={{ justifyContent: "center", color: "var(--fg-3)" }}>
            No secrets
          </div>
        ) : (
          items.map((it) => (
            <div key={it.key_id} className="an-row-card">
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="an-rc-title">
                  <span style={{ fontFamily: "ui-monospace, monospace" }}>{it.name}</span>
                  <span className="an-chip off" style={{ fontFamily: "var(--font-mono)" }}>
                    {it.value_masked}
                  </span>
                </div>
                {it.description && <div className="an-rc-sub">{it.description}</div>}
              </div>
              <DangerButton onClick={() => remove(it.key_id)} disabled={deletingId === it.key_id}>
                {deletingId === it.key_id ? "Deleting..." : "Delete"}
              </DangerButton>
            </div>
          ))
        )}

        <div className="an-row-card" style={{ flexDirection: "column", alignItems: "stretch", gap: 10 }}>
          <div className="an-rc-title">Add new secret</div>
          <Field label="Name">
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g. openai-key"
              className={inputCls}
            />
          </Field>
          <Field label="Secret value">
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
                className="an-over-input-action"
                tabIndex={-1}
              >
                {showValue ? "Hide" : "Show"}
              </button>
            </div>
          </Field>
          <Field label="Description (optional)">
            <input
              type="text"
              value={newDesc}
              onChange={(e) => setNewDesc(e.target.value)}
              className={inputCls}
            />
          </Field>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <PrimaryButton onClick={create} disabled={saving || !newName.trim() || !newValue.trim()}>
              {saving ? "Saving..." : "Save secret"}
            </PrimaryButton>
          </div>
        </div>
      </div>
    </div>
  );
}

/** AccountPane bundles profile editing and logout cards on a single pane.
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
  const [deletingAccount, setDeletingAccount] = useState(false);

  const deleteAccount = async () => {
    if (!currentUser || deletingAccount) return;
    const typed = prompt(
      `Type "${currentUser.username}" to deactivate this account. This removes profile data, friendships, keychain items, and avatar storage.`,
    );
    if (typed !== currentUser.username) return;
    setDeletingAccount(true);
    try {
      const res = await apiFetch("/auth/users/me", {
        method: "DELETE",
        token: authToken,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.status === "error") {
        throw new Error(data?.message || data?.detail || "Account deletion failed");
      }
      toast.success("Account deactivated");
      onLogout();
    } catch (e: unknown) {
      toast.error((e as Error).message || "Account deletion failed");
    } finally {
      setDeletingAccount(false);
    }
  };

  if (!currentUser) {
    return (
      <div className="an-pane">
        <div className="an-pane-head">
          <div>
            <div className="an-pane-title">Account</div>
            <div className="an-pane-sub">Not signed in</div>
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
          <div className="an-rc-title" style={{ color: "var(--red)" }}>Sign out</div>
          <div className="an-rc-sub">Clear the local token and return to sign-in.</div>
        </div>
        <DangerButton onClick={onLogout}>Sign out</DangerButton>
      </div>
      <div
        className="an-row-card"
        style={{ justifyContent: "space-between", marginTop: 12, flexShrink: 0 }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="an-rc-title" style={{ color: "var(--red)" }}>
            Delete account
          </div>
          <div className="an-rc-sub">
            Deactivate this user and remove owned profile, friendship, keychain, and avatar data.
          </div>
        </div>
        <DangerButton onClick={() => void deleteAccount()} disabled={deletingAccount}>
          {deletingAccount ? "Deleting..." : "Delete account"}
        </DangerButton>
      </div>
    </div>
  );
}
