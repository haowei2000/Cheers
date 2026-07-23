import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { exchangeOAuthHandoff } from "@/api/auth";
import { useAuthStore } from "@/stores/authStore";
import { Spinner } from "@/components/ui/spinner";

export default function OAuthCallbackPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const setAuth = useAuthStore((state) => state.setAuth);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const providerError = params.get("error");
    const code = params.get("code");
    if (providerError || !code) {
      setError(providerError === "access_denied" ? "Sign-in was cancelled." : "The sign-in callback is invalid.");
      return;
    }
    void exchangeOAuthHandoff(code)
      .then((outcome) => {
        if (outcome.status === "factor_required" || outcome.requires_2fa) {
          if (!outcome.transaction_id) throw new Error("Authentication transaction is missing");
          navigate(`/login?factor_transaction=${encodeURIComponent(outcome.transaction_id)}`, { replace: true });
          return;
        }
        if (!outcome.access_token || !outcome.user_id) throw new Error("Login response is incomplete");
        setAuth({
          user_id: outcome.user_id,
          username: outcome.username,
          display_name: outcome.display_name ?? null,
          role: outcome.role,
        }, outcome.access_token);
        const redirect = sessionStorage.getItem("cheers.oauth_redirect") || "/chat";
        sessionStorage.removeItem("cheers.oauth_redirect");
        navigate(redirect.startsWith("/") && !redirect.startsWith("//") ? redirect : "/chat", { replace: true });
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : "Sign-in failed"));
  }, [navigate, params, setAuth]);

  return (
    <div className="h-full bg-zinc-950 flex items-center justify-center p-6 text-zinc-100">
      {error ? (
        <div className="max-w-sm text-center">
          <h1 className="text-lg font-semibold">Couldn&apos;t sign in</h1>
          <p className="mt-2 text-sm text-zinc-400">{error}</p>
          <button className="mt-5 text-sm text-indigo-400 hover:text-indigo-300" onClick={() => navigate("/login", { replace: true })}>
            Back to sign in
          </button>
        </div>
      ) : <Spinner size={24} className="text-zinc-500" />}
    </div>
  );
}
