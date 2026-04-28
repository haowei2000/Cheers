import { useState } from "react";
import toast from "react-hot-toast";
import { UsersIcon } from "@heroicons/react/24/solid";
import type { CurrentUser } from "../types";
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
      if (!res.ok) throw new Error(data.detail || data.message || "登录失败");
      const payload = data.data ?? data;
      const userInfo = payload.user ?? payload;
      const user: AuthUser = {
        user_id: userInfo.user_id,
        username: userInfo.username,
        display_name: userInfo.display_name || userInfo.username,
        role: userInfo.role,
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
      setLoginError("请输入有效的邮箱地址");
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
      if (!res.ok) throw new Error(data.detail || "发送失败");
      onSent();
      toast.success("验证码已发送，请查收邮件");
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
      if (!res.ok) throw new Error(data.detail || data.message || "注册失败");
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
        role: userInfo.role,
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
      setLoginError("请填写验证码和新密码");
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
      if (!res.ok) throw new Error(data.detail || "重置失败");
      toast.success("密码已重置，请重新登录");
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
      <div className="px-3 py-3">
        <div className="text-center mb-6">
          <div
            className="w-12 h-12 rounded-lg flex items-center justify-center mx-auto mb-3"
            style={{ background: "var(--accent)" }}
          >
            <UsersIcon className="w-7 h-7 text-white" />
          </div>
          <h2 className="text-2xl font-bold text-gray-900">
            {authMode === "login"
              ? "登录到智枢"
              : authMode === "register"
                ? "创建账号"
                : "重置密码"}
          </h2>
          <p className="text-gray-500 text-sm mt-1">
            {authMode === "login"
              ? "欢迎回来！"
              : authMode === "register"
                ? "填写信息以创建新账号"
                : "通过邮箱验证重置密码"}
          </p>
        </div>
        {loginError && (
          <div className="mb-4 text-sm text-red-600 bg-red-50 border border-red-200 p-3 rounded-lg">
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
              placeholder="用户名或邮箱"
              required
              className="w-full mb-3 px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-[#1264A3] focus:ring-1 focus:ring-[#1264A3]"
            />
            <input
              name="password"
              type="password"
              placeholder="密码"
              required
              className="w-full mb-1 px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-[#1264A3] focus:ring-1 focus:ring-[#1264A3]"
            />
            <div className="text-right mb-4">
              <button
                type="button"
                onClick={() => {
                  setAuthMode("forgot");
                  setLoginError("");
                }}
                className="text-xs text-[#1264A3] hover:underline"
              >
                忘记密码？
              </button>
            </div>
            <button
              type="submit"
              disabled={loginLoading}
              className="w-full bg-[#4A154B] text-white py-2.5 rounded-lg font-semibold hover:bg-[#3d1040] disabled:opacity-50 text-sm"
            >
              {loginLoading ? "处理中..." : "登录"}
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
                placeholder="邮箱地址（必填）"
                required
                className="flex-1 px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-[#1264A3] focus:ring-1 focus:ring-[#1264A3]"
              />
              <button
                type="button"
                disabled={regCodeLoading || !regEmail.includes("@")}
                onClick={() =>
                  handleSendCode(regEmail, "register", () =>
                    setRegCodeSent(true),
                  )
                }
                className="px-3 py-2 text-xs bg-gray-100 border border-gray-300 rounded-lg hover:bg-gray-200 disabled:opacity-50 whitespace-nowrap"
              >
                {regCodeLoading
                  ? "发送中"
                  : regCodeSent
                    ? "重新发送"
                    : "获取验证码"}
              </button>
            </div>
            <input
              value={regCode}
              onChange={(e) => setRegCode(e.target.value)}
              placeholder="邮箱验证码"
              required
              disabled={!regCodeSent}
              className="w-full mb-4 px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-[#1264A3] focus:ring-1 focus:ring-[#1264A3] disabled:bg-gray-50 disabled:text-gray-400"
            />
            {/* Step 2: Account info (shown after code sent) */}
            <input
              name="display_name"
              placeholder="显示名称"
              required
              disabled={!regCodeSent}
              className="w-full mb-3 px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-[#1264A3] focus:ring-1 focus:ring-[#1264A3] disabled:bg-gray-50 disabled:text-gray-400"
            />
            <input
              name="username"
              placeholder="用户名（登录用）"
              required
              disabled={!regCodeSent}
              className="w-full mb-3 px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-[#1264A3] focus:ring-1 focus:ring-[#1264A3] disabled:bg-gray-50 disabled:text-gray-400"
            />
            <input
              name="password"
              type="password"
              placeholder="密码（8位以上，含字母和数字）"
              required
              disabled={!regCodeSent}
              className="w-full mb-4 px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-[#1264A3] focus:ring-1 focus:ring-[#1264A3] disabled:bg-gray-50 disabled:text-gray-400"
            />
            <button
              type="submit"
              disabled={loginLoading || !regCodeSent}
              className="w-full bg-[#4A154B] text-white py-2.5 rounded-lg font-semibold hover:bg-[#3d1040] disabled:opacity-50 text-sm"
            >
              {loginLoading ? "处理中..." : "注册"}
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
                placeholder="注册邮箱"
                required
                className="flex-1 px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-[#1264A3] focus:ring-1 focus:ring-[#1264A3]"
              />
              <button
                type="button"
                disabled={forgotCodeLoading || !forgotEmail.includes("@")}
                onClick={() =>
                  handleSendCode(forgotEmail, "reset_password", () =>
                    setForgotCodeSent(true),
                  )
                }
                className="px-3 py-2 text-xs bg-gray-100 border border-gray-300 rounded-lg hover:bg-gray-200 disabled:opacity-50 whitespace-nowrap"
              >
                {forgotCodeLoading
                  ? "发送中"
                  : forgotCodeSent
                    ? "重新发送"
                    : "获取验证码"}
              </button>
            </div>
            <input
              value={forgotCode}
              onChange={(e) => setForgotCode(e.target.value)}
              placeholder="邮箱验证码"
              className="w-full mb-3 px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-[#1264A3] focus:ring-1 focus:ring-[#1264A3]"
            />
            <input
              value={forgotNewPw}
              onChange={(e) => setForgotNewPw(e.target.value)}
              type="password"
              placeholder="新密码（8位以上，含字母和数字）"
              className="w-full mb-4 px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-[#1264A3] focus:ring-1 focus:ring-[#1264A3]"
            />
            <button
              onClick={handleForgotPassword}
              disabled={loginLoading || !forgotCodeSent}
              className="w-full bg-[#4A154B] text-white py-2.5 rounded-lg font-semibold hover:bg-[#3d1040] disabled:opacity-50 text-sm"
            >
              {loginLoading ? "处理中..." : "重置密码"}
            </button>
          </div>
        )}

        <div className="mt-4 text-center text-sm text-gray-500">
          {authMode === "login" ? (
            <>
              没有账号？{" "}
              <button
                onClick={() => {
                  setAuthMode("register");
                  setLoginError("");
                }}
                className="text-[#1264A3] font-medium hover:underline"
              >
                注册
              </button>
            </>
          ) : (
            <button
              onClick={() => {
                setAuthMode("login");
                setLoginError("");
              }}
              className="text-[#1264A3] font-medium hover:underline"
            >
              返回登录
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
