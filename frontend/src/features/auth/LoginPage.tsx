import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Apple } from "lucide-react";
import toast from "react-hot-toast";
import {
  exchangeOAuthHandoff,
  getAuthCapabilities,
  login,
  sendTwoFactorEmail,
  startOAuth,
  verifyTwoFactorLogin,
  type AuthCapabilities,
  type LoginResponse,
} from "@/api/auth";
import { useAuthStore } from "@/stores/authStore";
import { onOAuthHandoff } from "@/lib/oauthCallback";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function LoginPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  // Post-login destination (e.g. an invite landing page that bounced here).
  // Same-app paths only — an absolute URL would be an open redirect.
  const rawRedirect = params.get("redirect") ?? "";
  const redirect =
    rawRedirect.startsWith("/") && !rawRedirect.startsWith("//") ? rawRedirect : "/chat";
  const setAuth = useAuthStore((s) => s.setAuth);
  const [form, setForm] = useState({ login: "", password: "" });
  const [loading, setLoading] = useState(false);
  const [transactionId, setTransactionId] = useState<string | null>(
    params.get("factor_transaction")
  );
  const [allowedFactors, setAllowedFactors] = useState<string[]>(() => {
    const raw = params.get("allowed_factors");
    if (raw) return raw.split(",").map((s) => s.trim()).filter(Boolean);
    // Deep-link / OAuth resume without factors: offer the common code factors.
    return params.get("factor_transaction")
      ? ["totp", "recovery_code", "email"]
      : [];
  });
  const [factorCode, setFactorCode] = useState("");
  const [emailHint, setEmailHint] = useState<string | null>(null);
  const [emailSent, setEmailSent] = useState(false);
  const [capabilities, setCapabilities] = useState<AuthCapabilities | null>(null);

  useEffect(() => {
    void getAuthCapabilities().then(setCapabilities).catch(() => setCapabilities(null));
  }, []);

  useEffect(() => onOAuthHandoff((code) => {
    setLoading(true);
    void exchangeOAuthHandoff(code)
      .then(completeOutcome)
      .catch((error) => toast.error(error instanceof Error ? error.message : "OAuth login failed"))
      .finally(() => setLoading(false));
  // completeOutcome only reads stable router/store bindings.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);

  function completeOutcome(res: LoginResponse) {
    if (res.status === "factor_required" || res.requires_2fa) {
      if (!res.transaction_id) throw new Error("Authentication transaction is missing");
      setTransactionId(res.transaction_id);
      setAllowedFactors(res.allowed_factors ?? ["totp", "recovery_code"]);
      setEmailHint(null);
      setEmailSent(false);
      setFactorCode("");
      return;
    }
    if (!res.access_token || !res.user_id) throw new Error("Login response is incomplete");
    setAuth(
      {
        user_id: res.user_id,
        display_name: res.display_name ?? null,
        username: res.username ?? form.login,
        role: res.role,
      },
      res.access_token
    );
    navigate(redirect, { replace: true });
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!form.login || !form.password) return;
    setLoading(true);
    try {
      const res = await login({ ...form, client: "web" });
      completeOutcome(res);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Login failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleFactorSubmit(e: FormEvent) {
    e.preventDefault();
    if (!transactionId || !factorCode) return;
    setLoading(true);
    try {
      const res = await verifyTwoFactorLogin({
        transaction_id: transactionId,
        code: factorCode,
      });
      completeOutcome(res);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Verification failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleSendEmailCode() {
    if (!transactionId) return;
    setLoading(true);
    try {
      const res = await sendTwoFactorEmail(transactionId);
      setEmailHint(res.email_hint ?? null);
      setEmailSent(true);
      toast.success(
        res.email_hint
          ? `Code sent to ${res.email_hint}`
          : "Code sent to your email"
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not send email code");
    } finally {
      setLoading(false);
    }
  }

  const factorHelp = (() => {
    const parts = ["authenticator app", "backup code"];
    if (allowedFactors.includes("email")) parts.push("email code");
    if (parts.length === 2) return `Enter a code from your ${parts[0]} or ${parts[1]}.`;
    return `Enter a code from your ${parts.slice(0, -1).join(", ")}, or ${parts[parts.length - 1]}.`;
  })();

  return (
    // h-full + internal scroll (the app root is overflow-hidden); my-auto centers the
    // card when it fits and lets it scroll when the on-screen keyboard shrinks the
    // viewport, instead of clipping the top.
    <div className="h-full overflow-y-auto bg-zinc-950 flex justify-center p-4">
      <div className="w-full max-w-sm my-auto">
        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <div className="w-12 h-12 rounded-2xl flex items-center justify-center mb-4 shadow-lg shadow-indigo-500/20 overflow-hidden">
            <img
              src="/cheers-icon.svg"
              alt=""
              className="w-12 h-12"
              aria-hidden="true"
            />
          </div>
          <h1 className="text-2xl font-bold text-zinc-50 tracking-tight">
            Cheers
          </h1>
          <p className="text-zinc-400 text-sm mt-1">Sign in to continue</p>
        </div>

        {/* Card */}
        {transactionId ? <form
          onSubmit={handleFactorSubmit}
          className="bg-zinc-900 rounded-2xl p-6 shadow-xl space-y-4"
        >
          <p className="text-sm text-zinc-400">{factorHelp}</p>
          <div className="space-y-1.5">
            <label htmlFor="factor-code" className="text-xs font-medium text-zinc-400 uppercase tracking-wide">
              Verification code
            </label>
            <Input
              id="factor-code"
              autoComplete="one-time-code"
              autoFocus
              value={factorCode}
              onChange={(e) => setFactorCode(e.target.value)}
              placeholder={allowedFactors.includes("email") ? "123456 or email code" : "123456"}
            />
          </div>
          <Button type="submit" className="w-full" loading={loading} disabled={!factorCode}>
            Verify
          </Button>
          {allowedFactors.includes("email") && (
            <Button
              type="button"
              variant="secondary"
              className="w-full"
              disabled={loading}
              onClick={() => void handleSendEmailCode()}
            >
              {emailSent
                ? emailHint
                  ? `Resend code to ${emailHint}`
                  : "Resend email code"
                : emailHint
                  ? `Send code to ${emailHint}`
                  : "Send email code"}
            </Button>
          )}
          <button
            type="button"
            className="w-full text-xs text-zinc-400 hover:text-zinc-200"
            onClick={() => {
              setTransactionId(null);
              setAllowedFactors([]);
              setEmailHint(null);
              setEmailSent(false);
              setFactorCode("");
            }}
          >
            Back to sign in
          </button>
        </form> : <form
          onSubmit={handleSubmit}
          className="bg-zinc-900 rounded-2xl p-6 shadow-xl space-y-4"
        >
          <div className="space-y-1.5">
            <label
              htmlFor="login"
              className="text-xs font-medium text-zinc-400 uppercase tracking-wide"
            >
              Username or Email
            </label>
            <Input
              id="login"
              type="text"
              placeholder="you@example.com"
              autoComplete="username"
              autoFocus
              value={form.login}
              onChange={(e) => setForm((f) => ({ ...f, login: e.target.value }))}
            />
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="password"
              className="text-xs font-medium text-zinc-400 uppercase tracking-wide"
            >
              Password
            </label>
            <Input
              id="password"
              type="password"
              placeholder="••••••••"
              autoComplete="current-password"
              value={form.password}
              onChange={(e) =>
                setForm((f) => ({ ...f, password: e.target.value }))
              }
            />
          </div>

          <Button
            type="submit"
            className="w-full mt-2"
            loading={loading}
            disabled={!form.login || !form.password}
          >
            Sign in
          </Button>

          {(capabilities?.providers.apple || capabilities?.providers.google) && (
            <div className="space-y-3 pt-1">
              <div className="flex items-center gap-3" aria-hidden="true">
                <span className="h-px flex-1 bg-zinc-800" />
                <span className="text-xs text-zinc-500">or</span>
                <span className="h-px flex-1 bg-zinc-800" />
              </div>
              {capabilities.providers.apple && (
                <Button
                  type="button"
                  variant="secondary"
                  className="w-full"
                  disabled={loading}
                  onClick={() => {
                    sessionStorage.setItem("cheers.oauth_redirect", redirect);
                    setLoading(true);
                    void startOAuth("apple").catch((error) => {
                      setLoading(false);
                      toast.error(error instanceof Error ? error.message : "Apple sign-in failed");
                    });
                  }}
                >
                  <Apple className="h-4 w-4" /> Continue with Apple
                </Button>
              )}
              {capabilities.providers.google && (
                <Button
                  type="button"
                  variant="secondary"
                  className="w-full"
                  disabled={loading}
                  onClick={() => {
                    sessionStorage.setItem("cheers.oauth_redirect", redirect);
                    setLoading(true);
                    void startOAuth("google").catch((error) => {
                      setLoading(false);
                      toast.error(error instanceof Error ? error.message : "Google sign-in failed");
                    });
                  }}
                >
                  <span className="font-semibold" aria-hidden="true">G</span> Continue with Google
                </Button>
              )}
            </div>
          )}

          <div className="flex items-center justify-between text-xs text-zinc-400">
            <Link to="/register" className="text-indigo-400 hover:text-indigo-300">
              Create account
            </Link>
            <Link to="/forgot" className="text-indigo-400 hover:text-indigo-300">
              Forgot password?
            </Link>
          </div>
        </form>}
      </div>
    </div>
  );
}
