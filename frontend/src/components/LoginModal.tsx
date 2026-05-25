import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { appLanguageHeaders } from "../api/client";
import type { CurrentUser } from "../types";
import { AppIcon } from "./icons/AppIcon";
import { DingTalkIcon } from "./icons/DingTalkIcon";
import { Modal } from "./Modal";

const API = "/api/v1";
const jsonHeaders = () => ({ "Content-Type": "application/json", ...appLanguageHeaders() });

type AuthUser = Exclude<CurrentUser, null>;

const isEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
const normalizeAuthError = (message: string | undefined) => {
  const value = (message || "").trim();
  if (!value) return "Authentication failed. Please try again.";
  if (/用户名|邮箱|密码错误|incorrect|invalid credentials/i.test(value)) {
    return "Username/email or password is incorrect.";
  }
  return value;
};

type AuthProvider = {
  provider: string;
  display_name: string;
  enabled: boolean;
  web_authorize_url: string;
  client_id?: string;
  allowed_corp_ids?: string[];
  default_corp_id?: string;
  in_app_enabled?: boolean;
  rpc_scope?: string;
  field_scope?: string;
};

interface LoginModalProps {
  open: boolean;
  currentUser: CurrentUser;
  onClose: () => void;
  onSuccess: (user: AuthUser, token: string) => void;
}

export function LoginModal({ open, currentUser, onClose, onSuccess }: LoginModalProps) {
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [authMode, setAuthMode] = useState<"login" | "register" | "forgot">("login");
  const [regEmail, setRegEmail] = useState("");
  const [regCode, setRegCode] = useState("");
  const [regCodeSent, setRegCodeSent] = useState(false);
  const [regCodeLoading, setRegCodeLoading] = useState(false);
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotCode, setForgotCode] = useState("");
  const [forgotNewPw, setForgotNewPw] = useState("");
  const [forgotCodeSent, setForgotCodeSent] = useState(false);
  const [forgotCodeLoading, setForgotCodeLoading] = useState(false);
  const [dingtalkProvider, setDingtalkProvider] = useState<AuthProvider | null>(null);
  const [dingtalkLoading, setDingtalkLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch(`${API}/auth/providers`, { headers: appLanguageHeaders() })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled) return;
        const providers = (data?.data ?? data ?? []) as AuthProvider[];
        setDingtalkProvider(
          providers.find((p) => p.provider === "dingtalk" && p.enabled) ?? null,
        );
      })
      .catch(() => {
        if (!cancelled) setDingtalkProvider(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const handleLogin = async (username: string, password: string) => {
    setLoginLoading(true);
    setLoginError("");
    try {
      const res = await fetch(`${API}/auth/login`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || data.message || "Sign-in failed");
      const payload = data.data ?? data;
      const userInfo = payload.user ?? payload;
      const user: AuthUser = {
        user_id: userInfo.user_id,
        username: userInfo.username,
        display_name: userInfo.display_name || userInfo.username,
        email: userInfo.email ?? null,
        role: userInfo.role,
        avatar_url: userInfo.avatar_url ?? null,
        bio: userInfo.bio ?? null,
      };
      const token: string =
        payload.access_token || payload.token || userInfo.user_id;
      onSuccess(user, token);
    } catch (e: any) {
      setLoginError(normalizeAuthError(e.message));
    } finally {
      setLoginLoading(false);
    }
  };

  const redirectPath = () => {
    const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (!current.startsWith("/") || current.startsWith("//") || current.includes("\\")) return "/";
    if (current.startsWith("/auth/dingtalk/")) return "/";
    return current;
  };

  const startDingTalkWebOAuth = () => {
    if (!dingtalkProvider?.web_authorize_url) return;
    const url = `${dingtalkProvider.web_authorize_url}?redirect_path=${encodeURIComponent(redirectPath())}`;
    window.location.assign(url);
  };

  const pickDingTalkCorpId = () => {
    const allowed = dingtalkProvider?.allowed_corp_ids ?? [];
    if (dingtalkProvider?.default_corp_id) return dingtalkProvider.default_corp_id;
    if (allowed.length === 1) return allowed[0];
    return "";
  };

  const handleDingTalkLogin = async () => {
    if (!dingtalkProvider) return;
    const isDingTalkClient = /DingTalk/i.test(navigator.userAgent);
    const corpId = pickDingTalkCorpId();
    if (!isDingTalkClient || !dingtalkProvider.in_app_enabled || !corpId || !dingtalkProvider.client_id) {
      startDingTalkWebOAuth();
      return;
    }

    setDingtalkLoading(true);
    setLoginError("");
    try {
      const mod = await import("dingtalk-design-libs/biz/openAuth");
      const res = await mod.openAuth({
        clientId: dingtalkProvider.client_id,
        corpId,
        rpcScope: dingtalkProvider.rpc_scope || "Contact.User.Read",
        fieldScope: dingtalkProvider.field_scope || "",
        type: 0,
      });
      if (res?.status !== "ok" || !res?.result?.authCode) {
        if (res?.status === "cancel") return;
        throw new Error("DingTalk authorization failed");
      }
      const loginRes = await fetch(`${API}/auth/dingtalk/in-app-login`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ auth_code: res.result.authCode }),
      });
      const data = await loginRes.json();
      if (!loginRes.ok) throw new Error(data.detail || data.message || "DingTalk sign-in failed");
      const payload = data.data ?? data;
      const userInfo = payload.user ?? payload;
      const user: AuthUser = {
        user_id: userInfo.user_id,
        username: userInfo.username,
        display_name: userInfo.display_name || userInfo.username,
        email: userInfo.email ?? null,
        role: userInfo.role,
        avatar_url: userInfo.avatar_url ?? null,
        bio: userInfo.bio ?? null,
      };
      onSuccess(user, payload.access_token || payload.token);
    } catch (e: any) {
      if (/Failed to resolve module|Cannot find module|dingtalk-design-libs/i.test(String(e?.message || e))) {
        startDingTalkWebOAuth();
        return;
      }
      setLoginError(normalizeAuthError(e.message || "DingTalk sign-in failed"));
    } finally {
      setDingtalkLoading(false);
    }
  };

  const handleSendCode = async (
    email: string,
    purpose: string,
    onSent: () => void,
  ) => {
    if (!isEmail(email)) {
      setLoginError("Enter a valid email address");
      return;
    }
    if (purpose === "register") setRegCodeLoading(true);
    else setForgotCodeLoading(true);
    setLoginError("");
    try {
      const res = await fetch(`${API}/auth/send-code`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ email: email.trim(), purpose }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Send failed");
      onSent();
      toast.success("Verification code sent. Check your email.");
    } catch (e: any) {
      setLoginError(normalizeAuthError(e.message));
    } finally {
      if (purpose === "register") setRegCodeLoading(false);
      else setForgotCodeLoading(false);
    }
  };

  const handleRegister = async (
    username: string,
    password: string,
    displayName: string,
  ) => {
    setLoginLoading(true);
    setLoginError("");
    try {
      const res = await fetch(`${API}/auth/register`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({
          username,
          email: regEmail.trim(),
          password,
          display_name: displayName,
          code: regCode,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || data.message || "Registration failed");
      const loginRes = await fetch(`${API}/auth/login`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ username, password }),
      });
      const loginData = await loginRes.json();
      const loginPayload = loginData.data ?? loginData;
      const regPayload = data.data ?? data;
      const userInfo = loginPayload.user ?? regPayload;
      const user: AuthUser = {
        user_id: userInfo.user_id,
        username: userInfo.username,
        display_name: userInfo.display_name || userInfo.username,
        email: userInfo.email ?? null,
        role: userInfo.role,
        avatar_url: userInfo.avatar_url ?? null,
        bio: userInfo.bio ?? null,
      };
      const token: string =
        loginPayload.access_token || loginPayload.token || userInfo.user_id;
      onSuccess(user, token);
      setRegEmail("");
      setRegCode("");
      setRegCodeSent(false);
    } catch (e: any) {
      setLoginError(normalizeAuthError(e.message));
    } finally {
      setLoginLoading(false);
    }
  };

  const handleForgotPassword = async () => {
    if (!forgotCode.trim() || !forgotNewPw.trim()) {
      setLoginError("Enter the verification code and new password");
      return;
    }
    setLoginLoading(true);
    setLoginError("");
    try {
      const res = await fetch(`${API}/auth/forgot-password`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({
          email: forgotEmail.trim(),
          code: forgotCode,
          new_password: forgotNewPw,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Reset failed");
      toast.success("Password reset. Please sign in again.");
      setAuthMode("login");
      setForgotEmail("");
      setForgotCode("");
      setForgotNewPw("");
      setForgotCodeSent(false);
    } catch (e: any) {
      setLoginError(normalizeAuthError(e.message));
    } finally {
      setLoginLoading(false);
    }
  };

  // Login modal blocks closing while no user is authenticated; once a user
  // is logged in, it behaves like a normal modal.
  const handleClose = () => {
    if (currentUser) onClose();
  };

  return (
    <Modal
      open={open}
      onClose={handleClose}
      maxWidth="max-w-sm sm:max-w-md"
      hideCloseButton={!currentUser}
      panelClassName="p-2 an-auth-dialog-panel"
    >
      <div className="an-token-panel an-auth-shell">
        <div className="an-auth-header">
          <div className="an-auth-brand-mark">
            <AppIcon name="users" className="w-7 h-7" />
          </div>
          <h2 className="an-type-title">
            {authMode === "login"
              ? "Sign in to AgentNexus"
              : authMode === "register"
                ? "Create account"
                : "Reset password"}
          </h2>
          <p className="an-type-meta mt-1">
            {authMode === "login"
              ? "Use email, username, or DingTalk to continue."
              : authMode === "register"
                ? "Verify your email before creating an account."
                : "Reset your password with email verification"}
          </p>
        </div>
        {authMode !== "forgot" && (
          <div className="an-auth-switch" role="tablist" aria-label="Authentication mode">
            <button
              type="button"
              role="tab"
              aria-selected={authMode === "login"}
              className={authMode === "login" ? "is-active" : ""}
              onClick={() => {
                setAuthMode("login");
                setLoginError("");
              }}
            >
              Sign in
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={authMode === "register"}
              className={authMode === "register" ? "is-active" : ""}
              onClick={() => {
                setAuthMode("register");
                setLoginError("");
              }}
            >
              Create
            </button>
          </div>
        )}
        {loginError && (
          <div className="an-alert-danger mb-4">
            {loginError}
          </div>
        )}

        {/* ── Login ── */}
        {authMode === "login" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const fd = new FormData(e.currentTarget);
              handleLogin(
                fd.get("username") as string,
                fd.get("password") as string,
              );
            }}
          >
            <label className="an-auth-field">
              <span className="an-auth-label">Email or username</span>
              <span className="an-auth-input-wrap">
                <AppIcon name="mail" className="an-auth-input-icon" />
                <input
                  name="username"
                  placeholder="name@company.com or username"
                  required
                  inputMode="email"
                  autoComplete="username"
                  className="an-input"
                />
              </span>
            </label>
            <label className="an-auth-field">
              <span className="an-auth-label">Password</span>
              <span className="an-auth-input-wrap">
                <AppIcon name="lock" className="an-auth-input-icon" />
                <input
                  name="password"
                  type="password"
                  placeholder="Your password"
                  required
                  autoComplete="current-password"
                  className="an-input"
                />
              </span>
            </label>
            <div className="an-auth-action-row">
              <button
                type="button"
                onClick={() => {
                  setAuthMode("forgot");
                  setLoginError("");
                }}
                className="an-text-link an-type-caption"
              >
                Forgot password?
              </button>
            </div>
            <button
              type="submit"
              disabled={loginLoading}
              className="an-btn an-btn-primary an-auth-submit w-full"
            >
              {loginLoading ? "Processing..." : "Sign in"}
            </button>
            {dingtalkProvider && (
              <>
                <div className="an-auth-divider"><span>or</span></div>
                <button
                  type="button"
                  disabled={dingtalkLoading}
                  onClick={handleDingTalkLogin}
                  className="an-btn an-auth-dingtalk-btn w-full"
                >
                  <DingTalkIcon className="an-auth-dingtalk-icon" />
                  {dingtalkLoading ? "Processing..." : "Continue with DingTalk"}
                </button>
              </>
            )}
          </form>
        )}

        {/* ── Register ── */}
        {authMode === "register" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const fd = new FormData(e.currentTarget);
              handleRegister(
                fd.get("username") as string,
                fd.get("password") as string,
                fd.get("display_name") as string,
              );
            }}
          >
            {/* Step 1: Email verification */}
            <div className="an-auth-field">
              <span className="an-auth-label">Work email</span>
              <div className="an-auth-email-row">
                <span className="an-auth-input-wrap">
                  <AppIcon name="mail" className="an-auth-input-icon" />
                  <input
                    value={regEmail}
                    onChange={(e) => {
                      setRegEmail(e.target.value);
                      setRegCodeSent(false);
                      setRegCode("");
                    }}
                    type="email"
                    placeholder="name@company.com"
                    required
                    inputMode="email"
                    autoComplete="email"
                    className="an-input"
                  />
                </span>
                <button
                  type="button"
                  disabled={regCodeLoading || !isEmail(regEmail)}
                  onClick={() =>
                    handleSendCode(regEmail, "register", () =>
                      setRegCodeSent(true),
                    )
                  }
                  className="an-btn an-btn-ghost an-btn-sm an-auth-code-btn"
                >
                  {regCodeLoading
                    ? "Sending"
                    : regCodeSent
                      ? "Resend"
                      : "Get code"}
                </button>
              </div>
              <p className="an-auth-help">
                Enter a valid work email to request a verification code. The remaining fields unlock after the code is sent.
              </p>
            </div>
            <label className="an-auth-field">
              <span className="an-auth-label">Email verification code</span>
              <span className="an-auth-input-wrap">
                <AppIcon name="key" className="an-auth-input-icon" />
                <input
                  value={regCode}
                  onChange={(e) => setRegCode(e.target.value)}
                  placeholder="6-digit code"
                  required
                  disabled={!regCodeSent}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  className="an-input"
                />
              </span>
            </label>
            {/* Step 2: Account info (shown after code sent) */}
            <label className="an-auth-field">
              <span className="an-auth-label">Display name</span>
              <span className="an-auth-input-wrap">
                <AppIcon name="users" className="an-auth-input-icon" />
                <input
                  name="display_name"
                  placeholder="How teammates see you"
                  required
                  disabled={!regCodeSent}
                  autoComplete="name"
                  className="an-input"
                />
              </span>
            </label>
            <label className="an-auth-field">
              <span className="an-auth-label">Username</span>
              <span className="an-auth-input-wrap">
                <AppIcon name="user" className="an-auth-input-icon" />
                <input
                  name="username"
                  placeholder="For password sign-in"
                  required
                  disabled={!regCodeSent}
                  autoComplete="username"
                  className="an-input"
                />
              </span>
            </label>
            <label className="an-auth-field">
              <span className="an-auth-label">Password</span>
              <span className="an-auth-input-wrap">
                <AppIcon name="lock" className="an-auth-input-icon" />
                <input
                  name="password"
                  type="password"
                  placeholder="8+ chars, letters and numbers"
                  required
                  disabled={!regCodeSent}
                  autoComplete="new-password"
                  className="an-input"
                />
              </span>
            </label>
            <button
              type="submit"
              disabled={loginLoading || !regCodeSent}
              className="an-btn an-btn-primary an-auth-submit w-full"
            >
              {loginLoading ? "Processing..." : "Create account"}
            </button>
          </form>
        )}

        {/* ── Forgot Password ── */}
        {authMode === "forgot" && (
          <div>
            <div className="an-auth-field">
              <span className="an-auth-label">Registered email</span>
              <div className="an-auth-email-row">
                <span className="an-auth-input-wrap">
                  <AppIcon name="mail" className="an-auth-input-icon" />
                  <input
                    value={forgotEmail}
                    onChange={(e) => setForgotEmail(e.target.value)}
                    type="email"
                    placeholder="name@company.com"
                    required
                    inputMode="email"
                    autoComplete="email"
                    className="an-input"
                  />
                </span>
                <button
                  type="button"
                  disabled={forgotCodeLoading || !isEmail(forgotEmail)}
                  onClick={() =>
                    handleSendCode(forgotEmail, "reset_password", () =>
                      setForgotCodeSent(true),
                    )
                  }
                  className="an-btn an-btn-ghost an-btn-sm an-auth-code-btn"
                >
                  {forgotCodeLoading
                    ? "Sending"
                    : forgotCodeSent
                      ? "Resend"
                      : "Get code"}
                </button>
              </div>
              <p className="an-auth-help">
                Enter your registered email to receive a password reset code.
              </p>
            </div>
            <label className="an-auth-field">
              <span className="an-auth-label">Email verification code</span>
              <span className="an-auth-input-wrap">
                <AppIcon name="key" className="an-auth-input-icon" />
                <input
                  value={forgotCode}
                  onChange={(e) => setForgotCode(e.target.value)}
                  placeholder="6-digit code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  className="an-input"
                />
              </span>
            </label>
            <label className="an-auth-field">
              <span className="an-auth-label">New password</span>
              <span className="an-auth-input-wrap">
                <AppIcon name="lock" className="an-auth-input-icon" />
                <input
                  value={forgotNewPw}
                  onChange={(e) => setForgotNewPw(e.target.value)}
                  type="password"
                  placeholder="8+ chars, letters and numbers"
                  autoComplete="new-password"
                  className="an-input"
                />
              </span>
            </label>
            <button
              onClick={handleForgotPassword}
              disabled={loginLoading || !forgotCodeSent}
              className="an-btn an-btn-primary an-auth-submit w-full"
            >
              {loginLoading ? "Processing..." : "Reset password"}
            </button>
          </div>
        )}

        <div className="an-type-meta mt-4 text-center">
          {authMode === "forgot" ? (
            <button
              onClick={() => {
                setAuthMode("login");
                setLoginError("");
              }}
              className="an-text-link"
            >
              Back to sign in
            </button>
          ) : authMode === "register" ? (
            <>
              Already have an account?{" "}
              <button
                onClick={() => {
                  setAuthMode("login");
                  setLoginError("");
                }}
                className="an-text-link"
              >
                Sign in
              </button>
            </>
          ) : (
            <span>Email sign-in uses the same password as username sign-in.</span>
          )}
        </div>
      </div>
    </Modal>
  );
}
