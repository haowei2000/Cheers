import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { useLocation, useNavigate } from "react-router-dom";
import { apiFetch } from "./api/client";
import type { CurrentUser } from "./types";

const STORAGE_KEY = "currentUser";

function safeRedirectPath(value: string | null): string {
  const target = (value || "/").trim() || "/";
  if (!target.startsWith("/") || target.startsWith("//") || target.includes("\\")) return "/";
  if (target.startsWith("/auth/dingtalk/")) return "/";
  return target;
}

export default function AuthCallbackPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams(location.search);
    const errorParam = params.get("error");
    const ticket = params.get("ticket");
    const redirectPath = safeRedirectPath(params.get("redirect_path"));

    if (errorParam) {
      setError(errorParam);
      return;
    }
    if (!ticket) {
      setError("Missing DingTalk login ticket");
      return;
    }

    apiFetch("/auth/dingtalk/exchange", {
      method: "POST",
      auth: false,
      body: { ticket },
    })
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || data.message || "DingTalk sign-in failed");
        return data.data ?? data;
      })
      .then((payload) => {
        if (cancelled) return;
        const userInfo = payload.user;
        const user: Exclude<CurrentUser, null> = {
          user_id: userInfo.user_id,
          username: userInfo.username,
          display_name: userInfo.display_name || userInfo.username,
          email: userInfo.email ?? null,
          role: userInfo.role,
          avatar_url: userInfo.avatar_url ?? null,
          bio: userInfo.bio ?? null,
        };
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({
            user,
            token: payload.access_token || payload.token,
            loginTime: Date.now(),
          }),
        );
        toast.success("Signed in with DingTalk");
        navigate(redirectPath, { replace: true });
      })
      .catch((e: any) => {
        if (!cancelled) setError(e.message || "DingTalk sign-in failed");
      });

    return () => {
      cancelled = true;
    };
  }, [location.search, navigate]);

  return (
    <div
      className="flex items-center justify-center bg-[var(--bg-0)] px-4 text-center text-sm text-[var(--fg-3)]"
      style={{ minHeight: "var(--an-viewport-height, 100dvh)" }}
    >
      <div className="an-token-panel max-w-sm px-5 py-4">
        {error ? (
          <>
            <div className="an-type-title mb-2">DingTalk sign-in failed</div>
            <div className="an-type-meta">{error}</div>
            <button
              type="button"
              onClick={() => navigate("/", { replace: true })}
              className="an-btn an-btn-primary mt-4 w-full py-2.5"
            >
              Back to sign in
            </button>
          </>
        ) : (
          <div className="an-type-body">Signing in...</div>
        )}
      </div>
    </div>
  );
}
