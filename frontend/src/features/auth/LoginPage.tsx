import { Button as UiButton } from "@/components/ui/button";
import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import toast from "react-hot-toast";
import {
  exchangeOAuthHandoff,
  getAuthCapabilities,
  loginFlowPasskeyOptions,
  passkeyFactorOptions,
  passkeyFactorVerify,
  sendTwoFactorEmail,
  sendLoginFlowEmail,
  startOAuth,
  startLoginFlow,
  verifyLoginFlowCode,
  verifyLoginFlowPassword,
  verifyTwoFactorLogin,
  verifyLoginFlowPasskey,
  type AuthCapabilities,
  type LoginResponse,
} from "@/api/auth";
import { useAuthStore } from "@/stores/authStore";
import { onOAuthHandoff } from "@/lib/oauthCallback";
import { getPasskey } from "@/lib/webauthn";
import { errorMessage } from "@/api/client";
import { Button } from "@/components/ui/button";
import { AppleMark, GitHubMark, GoogleMark } from "@/components/ui/provider-marks";
import { Input } from "@/components/ui/input";
import { Fingerprint, Mail } from "lucide-react";
import {
  PublicPageShell,
  publicLabelClass,
  publicLinkClass,
  publicPanelClass,
} from "@/components/public/PublicPageShell";

export default function LoginPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  // Post-login destination (e.g. an invite landing page that bounced here).
  // Same-app paths only — an absolute URL would be an open redirect.
  const rawRedirect = params.get("redirect") ?? "";
  const redirect =
    rawRedirect.startsWith("/") && !rawRedirect.startsWith("//") ? rawRedirect : "/chat";
  const accountLinkProvider = ["apple", "google", "github"].includes(
    params.get("account_link") ?? ""
  )
    ? params.get("account_link")
    : null;
  const accountLinkLabel =
    accountLinkProvider === "github"
      ? "GitHub"
      : accountLinkProvider === "google"
        ? "Google"
        : "Apple";
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
  const [unifiedFlow, setUnifiedFlow] = useState(false);
  const [capabilities, setCapabilities] = useState<AuthCapabilities | null>(null);

  useEffect(() => {
    void getAuthCapabilities().then(setCapabilities).catch(() => setCapabilities(null));
  }, []);

  useEffect(() => onOAuthHandoff((code) => {
    setLoading(true);
    void exchangeOAuthHandoff(code)
      .then(completeOutcome)
      .catch((error) => toast.error(errorMessage(error, "OAuth login failed")))
      .finally(() => setLoading(false));
  // completeOutcome only reads stable router/store bindings.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);

  function completeOutcome(res: LoginResponse) {
    if (res.status === "factor_required" || res.requires_2fa) {
      if (!res.transaction_id) throw new Error("Authentication transaction is missing");
      setTransactionId(res.transaction_id);
      setAllowedFactors(res.methods ?? res.allowed_factors ?? ["totp", "recovery_code"]);
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
      const flow = await startLoginFlow(form.login);
      setUnifiedFlow(true);
      completeOutcome(await verifyLoginFlowPassword(flow.transaction_id, form.password));
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
      const res = unifiedFlow
        ? await verifyLoginFlowCode(
            transactionId,
            allowedFactors.includes("email") ? "email" : "totp",
            factorCode
          )
        : await verifyTwoFactorLogin({
            transaction_id: transactionId,
            code: factorCode,
            remember_device: true,
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
      const res = unifiedFlow
        ? await sendLoginFlowEmail(transactionId)
        : await sendTwoFactorEmail(transactionId);
      setEmailHint(typeof res.email_hint === "string" ? res.email_hint : null);
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

  async function handlePasskey() {
    if (!transactionId) return;
    setLoading(true);
    try {
      const options = unifiedFlow
        ? await loginFlowPasskeyOptions(transactionId)
        : await passkeyFactorOptions(transactionId);
      const credential = await getPasskey(options);
      const res = unifiedFlow
        ? await verifyLoginFlowPasskey(transactionId, credential)
        : await passkeyFactorVerify({
            transaction_id: transactionId,
            credential,
            remember_device: true,
          });
      completeOutcome(res);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Passkey verification failed";
      if (/cancel|abort/i.test(msg)) return;
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }

  async function handlePrimaryPasskey() {
    if (!form.login.trim()) {
      toast.error("Enter your username or email first");
      return;
    }
    setLoading(true);
    try {
      const flow = await startLoginFlow(form.login);
      if (!flow.methods.includes("passkey")) {
        throw new Error("No passkey is registered for this account");
      }
      const options = await loginFlowPasskeyOptions(flow.transaction_id);
      const credential = await getPasskey(options);
      setUnifiedFlow(true);
      completeOutcome(await verifyLoginFlowPasskey(flow.transaction_id, credential));
    } catch (err) {
      const message = errorMessage(err, "Passkey sign-in failed");
      if (!/cancel|abort/i.test(message)) toast.error(message);
    } finally {
      setLoading(false);
    }
  }

  async function handlePrimaryEmail() {
    if (!form.login.trim()) {
      toast.error("Enter your username or email first");
      return;
    }
    setLoading(true);
    try {
      const flow = await startLoginFlow(form.login);
      await sendLoginFlowEmail(flow.transaction_id);
      setUnifiedFlow(true);
      setTransactionId(flow.transaction_id);
      setAllowedFactors(["email"]);
      setEmailHint(null);
      setEmailSent(true);
      setFactorCode("");
    } catch (err) {
      toast.error(errorMessage(err, "Could not send a sign-in code"));
    } finally {
      setLoading(false);
    }
  }

  const factorHelp = (() => {
    const parts: string[] = [];
    if (allowedFactors.includes("totp")) parts.push("authenticator app");
    if (allowedFactors.includes("recovery_code")) parts.push("backup code");
    if (allowedFactors.includes("email")) parts.push("email");
    if (allowedFactors.includes("passkey")) parts.push("Passkey");
    if (parts.length === 0) return "Verify your identity to finish signing in.";
    if (parts.length === 1) return `Continue with your ${parts[0]}.`;
    if (parts.length === 2) return `Continue with your ${parts[0]} or ${parts[1]}.`;
    return `Continue with your ${parts.slice(0, -1).join(", ")}, or ${parts[parts.length - 1]}.`;
  })();

  return (
    // h-full + internal scroll (the app root is overflow-hidden); my-auto centers the
    // card when it fits and lets it scroll when the on-screen keyboard shrinks the
    // viewport, instead of clipping the top.
    <PublicPageShell
      title={transactionId ? "Verify your identity" : "Welcome back"}
      description={transactionId ? factorHelp : "Sign in to continue to your Cheers workspace."}
    >
        {transactionId ? <form
          onSubmit={handleFactorSubmit}
          className={publicPanelClass}
        >
          <div className="space-y-2">
            <label htmlFor="factor-code" className={publicLabelClass}>
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
          <Button action="send" controlWidth="fill" type="submit" loading={loading} disabled={!factorCode}>
            Verify
          </Button>
          {allowedFactors.includes("email") && (
            <Button action="send" controlWidth="fill"
              type="button"
              variant="secondary"
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
          {allowedFactors.includes("passkey") && (
            <Button action="choose" controlWidth="fill"
              type="button"
              variant="secondary"
              disabled={loading}
              onClick={() => void handlePasskey()}
            >
              Use Passkey
            </Button>
          )}
          <UiButton action="signIn" controlWidth="fill" variant="plain"
            type="button"
            className={` ${publicLinkClass}`}
            onClick={() => {
              setTransactionId(null);
              setAllowedFactors([]);
              setEmailHint(null);
              setEmailSent(false);
              setFactorCode("");
              setUnifiedFlow(false);
            }}
          >
            Back to sign in
          </UiButton>
        </form> : <form
          onSubmit={handleSubmit}
          className={publicPanelClass}
        >
          {accountLinkProvider && (
            <div className="rounded-sm bg-indigo-600/15 px-3 py-2 text-regular text-accent-200">
              Sign in with a method already connected to your account. You&apos;ll link {accountLinkLabel} next.
            </div>
          )}
          <div className="space-y-2">
            <label
              htmlFor="login"
              className={publicLabelClass}
            >
              Username or Email
            </label>
            <Input
              id="login"
              type="text"
              placeholder="you@example.com"
              autoComplete="username"
              required
              autoFocus
              value={form.login}
              onChange={(e) => setForm((f) => ({ ...f, login: e.target.value }))}
            />
          </div>

          {capabilities?.passkey && (
            <Button action="usePasskey" content="iconText" controlWidth="fill"
              type="button"
              variant="emphasis"
              disabled={loading || !form.login.trim()}
              onClick={() => void handlePrimaryPasskey()}
            >
              <Fingerprint className="h-4 w-4" />
            </Button>
          )}

          {capabilities?.passkey && (
            <div className="flex items-center gap-3" aria-hidden="true">
              <span className="h-px flex-1 bg-zinc-800" />
              <span className="text-compact text-content-muted">Try another method</span>
              <span className="h-px flex-1 bg-zinc-800" />
            </div>
          )}

          <div className="space-y-2">
            <label
              htmlFor="password"
              className={publicLabelClass}
            >
              Password
            </label>
            <Input
              id="password"
              type="password"
              placeholder="••••••••"
              autoComplete="current-password"
              required
              value={form.password}
              onChange={(e) =>
                setForm((f) => ({ ...f, password: e.target.value }))
              }
            />
          </div>

          <Button action="signIn" controlWidth="fill"
            type="submit"
            className="mt-2"
            loading={loading}
          >
            Sign in
          </Button>

          <Button
            action="emailCode"
            content="iconText"
            controlWidth="fill"
            type="button"
            variant="secondary"
            disabled={loading || !form.login.trim()}
            onClick={() => void handlePrimaryEmail()}
          >
            <Mail className="h-4 w-4" />
          </Button>

          {(capabilities?.providers.apple || capabilities?.providers.google || capabilities?.providers.github) && (
            <div className="space-y-3 pt-1">
              <div className="flex items-center gap-3" aria-hidden="true">
                <span className="h-px flex-1 bg-zinc-800" />
                <span className="text-compact text-content-muted">or</span>
                <span className="h-px flex-1 bg-zinc-800" />
              </div>
              {capabilities.providers.apple && (
                <Button action="continueWithApple" content="iconText" controlWidth="fill"
                  type="button"
                  variant="secondary"
                  disabled={loading || accountLinkProvider === "apple"}
                  title={accountLinkProvider === "apple" ? "Sign in with an existing method before linking Apple" : undefined}
                  onClick={() => {
                    sessionStorage.setItem("cheers.oauth_redirect", redirect);
                    setLoading(true);
                    void startOAuth("apple").catch((error) => {
                      setLoading(false);
                      toast.error(errorMessage(error, "Apple sign-in failed"));
                    });
                  }}
                >
                  <AppleMark className="h-4 w-4" />
                </Button>
              )}
              {capabilities.providers.google && (
                <Button action="continueWithGoogle" content="iconText" controlWidth="fill"
                  type="button"
                  variant="secondary"
                  disabled={loading || accountLinkProvider === "google"}
                  title={accountLinkProvider === "google" ? "Sign in with an existing method before linking Google" : undefined}
                  onClick={() => {
                    sessionStorage.setItem("cheers.oauth_redirect", redirect);
                    setLoading(true);
                    void startOAuth("google").catch((error) => {
                      setLoading(false);
                      toast.error(errorMessage(error, "Google sign-in failed"));
                    });
                  }}
                >
                  <GoogleMark className="h-4 w-4" />
                </Button>
              )}
              {capabilities.providers.github && (
                <Button action="continueWithGitHub" content="iconText" controlWidth="fill"
                  type="button"
                  variant="secondary"
                  disabled={loading || accountLinkProvider === "github"}
                  title={accountLinkProvider === "github" ? "Sign in with an existing method before linking GitHub" : undefined}
                  onClick={() => {
                    sessionStorage.setItem("cheers.oauth_redirect", redirect);
                    setLoading(true);
                    void startOAuth("github").catch((error) => {
                      setLoading(false);
                      toast.error(errorMessage(error, "GitHub sign-in failed"));
                    });
                  }}
                >
                  <GitHubMark className="h-4 w-4" />
                </Button>
              )}
            </div>
          )}

          <div className="flex items-center justify-between text-compact text-content-muted">
            <Link to="/register" className={publicLinkClass}>
              Create account
            </Link>
            <Link to="/forgot" className={publicLinkClass}>
              Forgot password?
            </Link>
          </div>
        </form>}
    </PublicPageShell>
  );
}
