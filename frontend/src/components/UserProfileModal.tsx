import { useState, useEffect } from "react";
import toast from "react-hot-toast";

const API = "/api/v1";

// ── User Profile Modal ────────────────────────────────────────────────────────
export function UserProfileModal({
  currentUser,
  userToken,
  onClose,
  onProfileUpdated,
}: {
  currentUser: {
    user_id: string;
    username: string;
    display_name: string;
    role: string;
  };
  userToken: string;
  onClose: () => void;
  onProfileUpdated: (data: { display_name: string; bio?: string }) => void;
}) {
  const [displayName, setDisplayName] = useState(
    currentUser.display_name || "",
  );
  const [bio, setBio] = useState("");
  const [saving, setSaving] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [tab, setTab] = useState<"profile" | "password">("profile");
  const [pwVerifyMode, setPwVerifyMode] = useState<"password" | "email">(
    "password",
  );
  const [emailCode, setEmailCode] = useState("");
  const [emailCodeSent, setEmailCodeSent] = useState(false);
  const [emailCodeLoading, setEmailCodeLoading] = useState(false);
  const [userEmail, setUserEmail] = useState<string>("");

  useEffect(() => {
    fetch(`${API}/auth/users/me`, {
      headers: { Authorization: `Bearer ${userToken}` },
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.display_name !== undefined) setDisplayName(d.display_name || "");
        if (d.bio !== undefined) setBio(d.bio || "");
        if (d.email !== undefined) setUserEmail(d.email || "");
      })
      .catch(() => {});
  }, [userToken]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch(`${API}/auth/users/me`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({ display_name: displayName, bio }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "保存失败");
      onProfileUpdated({
        display_name: data.display_name || displayName,
        bio: data.bio,
      });
      toast.success("个人资料已更新");
      onClose();
    } catch (e: any) {
      toast.error(e.message || "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const handleSendEmailCode = async () => {
    if (!userEmail) {
      toast.error("账号未绑定邮箱");
      return;
    }
    setEmailCodeLoading(true);
    try {
      const res = await fetch(`${API}/auth/send-code`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({ email: userEmail, purpose: "change_password" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "发送失败");
      setEmailCodeSent(true);
      toast.success("验证码已发送至 " + userEmail);
    } catch (e: any) {
      toast.error(e.message || "发送失败");
    } finally {
      setEmailCodeLoading(false);
    }
  };

  const handlePasswordChange = async () => {
    if (!newPassword) return;
    if (newPassword !== confirmPassword) {
      toast.error("两次输入的新密码不一致");
      return;
    }
    if (pwVerifyMode === "password" && !currentPassword) return;
    if (pwVerifyMode === "email" && !emailCode) return;
    setPasswordSaving(true);
    try {
      const body: Record<string, string> = { new_password: newPassword };
      if (pwVerifyMode === "password") body.current_password = currentPassword;
      else body.email_code = emailCode;
      const res = await fetch(`${API}/auth/users/me/password`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "密码修改失败");
      toast.success("密码已更新");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setEmailCode("");
      setEmailCodeSent(false);
    } catch (e: any) {
      toast.error(e.message || "密码修改失败");
    } finally {
      setPasswordSaving(false);
    }
  };

  const inputCls =
    "w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-[#1264A3] focus:ring-1 focus:ring-[#1264A3]";

  return (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm"
      onClick={onClose}
      aria-modal="true"
      role="dialog"
    >
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-md mx-4 flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex justify-between items-center px-6 pt-5 pb-4 border-b border-gray-100 flex-shrink-0">
          <h2 className="text-lg font-bold text-gray-900">个人资料</h2>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 hover:text-gray-600 text-xl leading-none"
          >
            ×
          </button>
        </div>

        {/* Avatar + username */}
        <div className="flex items-center gap-4 px-6 py-4 flex-shrink-0">
          <div className="w-16 h-16 rounded-full bg-[#1264A3] text-white flex items-center justify-center text-2xl font-bold flex-shrink-0">
            {(displayName || currentUser.username).slice(0, 1).toUpperCase()}
          </div>
          <div>
            <p className="font-semibold text-gray-900">
              {displayName || currentUser.username}
            </p>
            <p className="text-xs text-gray-400">@{currentUser.username}</p>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 mt-1 inline-block">
              {currentUser.role}
            </span>
          </div>
        </div>

        {/* UUID */}
        <div className="px-6 pb-3 flex-shrink-0">
          <label className="block text-xs font-medium text-gray-500 mb-1">UUID（可分享给好友添加）</label>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-xs bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-gray-700 select-all break-all">
              {currentUser.user_id}
            </code>
            <button
              type="button"
              onClick={() => {
                navigator.clipboard.writeText(currentUser.user_id);
                toast.success("UUID 已复制");
              }}
              className="px-3 py-2 text-xs bg-gray-100 border border-gray-200 rounded-lg hover:bg-gray-200 text-gray-600 whitespace-nowrap"
            >
              复制
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-gray-100 px-6 flex-shrink-0">
          {(["profile", "password"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`pb-2 mr-4 text-sm font-medium border-b-2 transition-colors ${
                tab === t
                  ? "border-[#1264A3] text-[#1264A3]"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              {t === "profile" ? "基本信息" : "修改密码"}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {tab === "profile" ? (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  显示名称
                </label>
                <input
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="输入你的显示名称"
                  className={inputCls}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  个人简介
                </label>
                <textarea
                  value={bio}
                  onChange={(e) => setBio(e.target.value)}
                  placeholder="介绍一下你自己…"
                  className={`${inputCls} resize-none`}
                  rows={4}
                />
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Verify mode toggle */}
              <div className="flex gap-2 p-1 bg-gray-100 rounded-lg">
                <button
                  type="button"
                  onClick={() => setPwVerifyMode("password")}
                  className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-colors ${pwVerifyMode === "password" ? "bg-white shadow text-gray-800" : "text-gray-500 hover:text-gray-700"}`}
                >
                  密码验证
                </button>
                <button
                  type="button"
                  onClick={() => setPwVerifyMode("email")}
                  className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-colors ${pwVerifyMode === "email" ? "bg-white shadow text-gray-800" : "text-gray-500 hover:text-gray-700"}`}
                >
                  邮箱验证
                </button>
              </div>

              {pwVerifyMode === "password" ? (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    当前密码
                  </label>
                  <input
                    type="password"
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    placeholder="输入当前密码"
                    className={inputCls}
                    autoComplete="current-password"
                  />
                </div>
              ) : (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    邮箱验证码
                  </label>
                  {userEmail ? (
                    <div className="flex gap-2">
                      <input
                        value={emailCode}
                        onChange={(e) => setEmailCode(e.target.value)}
                        placeholder="输入验证码"
                        className={`${inputCls} flex-1`}
                      />
                      <button
                        type="button"
                        disabled={emailCodeLoading}
                        onClick={handleSendEmailCode}
                        className="px-3 py-2 text-xs bg-gray-100 border border-gray-300 rounded-lg hover:bg-gray-200 disabled:opacity-50 whitespace-nowrap"
                      >
                        {emailCodeLoading
                          ? "发送中"
                          : emailCodeSent
                            ? "重新发送"
                            : "获取验证码"}
                      </button>
                    </div>
                  ) : (
                    <p className="text-xs text-red-500">
                      账号未绑定邮箱，无法使用邮箱验证
                    </p>
                  )}
                  {userEmail && (
                    <p className="text-xs text-gray-400 mt-1">
                      验证码将发送至 {userEmail}
                    </p>
                  )}
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  新密码
                </label>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="输入新密码"
                  className={inputCls}
                  autoComplete="new-password"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  确认新密码
                </label>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="再次输入新密码"
                  className={inputCls}
                  autoComplete="new-password"
                />
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-6 py-4 border-t border-gray-100 flex-shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg text-sm font-medium"
          >
            取消
          </button>
          {tab === "profile" ? (
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-2 bg-[#1264A3] text-white rounded-lg text-sm font-medium hover:bg-[#0f5a94] disabled:opacity-50"
            >
              {saving ? "保存中…" : "保存"}
            </button>
          ) : (
            <button
              type="button"
              onClick={handlePasswordChange}
              disabled={
                passwordSaving ||
                !newPassword ||
                !confirmPassword ||
                (pwVerifyMode === "password" && !currentPassword) ||
                (pwVerifyMode === "email" && !emailCode)
              }
              className="px-4 py-2 bg-[#1264A3] text-white rounded-lg text-sm font-medium hover:bg-[#0f5a94] disabled:opacity-50"
            >
              {passwordSaving ? "更新中…" : "更新密码"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
