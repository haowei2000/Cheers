import { useState } from "react";
import toast from "react-hot-toast";
import type { CurrentUser } from "../types";
import { AppIcon } from "./icons/AppIcon";
import { Modal } from "./Modal";

const API = "/api/v1";

type AuthUser = Exclude<CurrentUser, null>;

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

  const handleLogin = async (username: string, password: string) => {
    setLoginLoading(true);
    setLoginError("");
    try {
      const res = await fetch(`${API}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
      setLoginError(e.message);
    } finally {
      setLoginLoading(false);
    }
  };

  const handleSendCode = async (
    email: string,
    purpose: string,
    onSent: () => void,
  ) => {
    if (!email.trim() || !email.includes("@")) {
      setLoginError("Enter a valid email address");
      return;
    }
    if (purpose === "register") setRegCodeLoading(true);
    else setForgotCodeLoading(true);
    setLoginError("");
    try {
      const res = await fetch(`${API}/auth/send-code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), purpose }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Send failed");
      onSent();
      toast.success("Verification code sent. Check your email.");
    } catch (e: any) {
      setLoginError(e.message);
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
        headers: { "Content-Type": "application/json" },
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
        headers: { "Content-Type": "application/json" },
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
      setLoginError(e.message);
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
        headers: { "Content-Type": "application/json" },
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
      setLoginError(e.message);
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
      maxWidth="max-w-sm"
      hideCloseButton={!currentUser}
      panelClassName="p-2"
    >
      <div className="an-token-panel px-3 py-3">
        <div className="text-center mb-6">
          <div
            className="w-12 h-12 rounded-lg flex items-center justify-center mx-auto mb-3"
            style={{ background: "var(--accent)" }}
          >
            <AppIcon name="users" className="w-7 h-7 text-white" />
          </div>
          <h2 className="an-type-title">
            {authMode === "login"
              ? "Sign in to AgentNEXUS"
              : authMode === "register"
                ? "Create account"
                : "Reset password"}
          </h2>
          <p className="an-type-meta mt-1">
            {authMode === "login"
              ? "Welcome back."
              : authMode === "register"
                ? "Fill in details to create an account"
                : "Reset your password with email verification"}
          </p>
        </div>
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
            <input
              name="username"
              placeholder="Username or email"
              required
              className="an-input mb-3"
            />
            <input
              name="password"
              type="password"
              placeholder="Password"
              required
              className="an-input mb-1"
            />
            <div className="text-right mb-4">
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
              className="an-btn an-btn-primary w-full py-2.5"
            >
              {loginLoading ? "Processing..." : "Sign in"}
            </button>
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
            <div className="flex gap-2 mb-3">
              <input
                value={regEmail}
                onChange={(e) => {
                  setRegEmail(e.target.value);
                  setRegCodeSent(false);
                  setRegCode("");
                }}
                type="email"
                placeholder="Email address (required)"
                required
                className="an-input flex-1"
              />
              <button
                type="button"
                disabled={regCodeLoading || !regEmail.includes("@")}
                onClick={() =>
                  handleSendCode(regEmail, "register", () =>
                    setRegCodeSent(true),
                  )
                }
                className="an-btn an-btn-ghost an-btn-sm"
              >
                {regCodeLoading
                  ? "Sending"
                  : regCodeSent
                    ? "Resend"
                    : "Get code"}
              </button>
            </div>
            <input
              value={regCode}
              onChange={(e) => setRegCode(e.target.value)}
              placeholder="Email verification code"
              required
              disabled={!regCodeSent}
              className="an-input mb-4"
            />
            {/* Step 2: Account info (shown after code sent) */}
            <input
              name="display_name"
              placeholder="Display name"
              required
              disabled={!regCodeSent}
              className="an-input mb-3"
            />
            <input
              name="username"
              placeholder="Username (for sign-in)"
              required
              disabled={!regCodeSent}
              className="an-input mb-3"
            />
            <input
              name="password"
              type="password"
              placeholder="Password (8+ chars, letters and numbers)"
              required
              disabled={!regCodeSent}
              className="an-input mb-4"
            />
            <button
              type="submit"
              disabled={loginLoading || !regCodeSent}
              className="an-btn an-btn-primary w-full py-2.5"
            >
              {loginLoading ? "Processing..." : "Create account"}
            </button>
          </form>
        )}

        {/* ── Forgot Password ── */}
        {authMode === "forgot" && (
          <div>
            <div className="flex gap-2 mb-3">
              <input
                value={forgotEmail}
                onChange={(e) => setForgotEmail(e.target.value)}
                type="email"
                placeholder="Registered email"
                required
                className="an-input flex-1"
              />
              <button
                type="button"
                disabled={forgotCodeLoading || !forgotEmail.includes("@")}
                onClick={() =>
                  handleSendCode(forgotEmail, "reset_password", () =>
                    setForgotCodeSent(true),
                  )
                }
                className="an-btn an-btn-ghost an-btn-sm"
              >
                {forgotCodeLoading
                  ? "Sending"
                  : forgotCodeSent
                    ? "Resend"
                    : "Get code"}
              </button>
            </div>
            <input
              value={forgotCode}
              onChange={(e) => setForgotCode(e.target.value)}
              placeholder="Email verification code"
              className="an-input mb-3"
            />
            <input
              value={forgotNewPw}
              onChange={(e) => setForgotNewPw(e.target.value)}
              type="password"
              placeholder="New password (8+ chars, letters and numbers)"
              className="an-input mb-4"
            />
            <button
              onClick={handleForgotPassword}
              disabled={loginLoading || !forgotCodeSent}
              className="an-btn an-btn-primary w-full py-2.5"
            >
              {loginLoading ? "Processing..." : "Reset password"}
            </button>
          </div>
        )}

        <div className="an-type-meta mt-4 text-center">
          {authMode === "login" ? (
            <>
              No account?{" "}
              <button
                onClick={() => {
                  setAuthMode("register");
                  setLoginError("");
                }}
                className="an-text-link"
              >
                created account
              </button>
            </>
          ) : (
            <button
              onClick={() => {
                setAuthMode("login");
                setLoginError("");
              }}
              className="an-text-link"
            >
              Back to sign in
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
