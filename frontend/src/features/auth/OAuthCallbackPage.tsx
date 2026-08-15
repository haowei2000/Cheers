import { Button as UiButton } from "@/components/ui/button";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { exchangeOAuthHandoff } from "@/api/auth";
import { errorMessage } from "@/api/client";
import { useAuthStore } from "@/stores/authStore";
import { Spinner } from "@/components/ui/spinner";
import {
  PublicPageShell,
  publicLinkClass,
  publicPanelClass,
} from "@/components/public/PublicPageShell";

export default function OAuthCallbackPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const setAuth = useAuthStore((state) => state.setAuth);
  const [error, setError] = useState<string | null>(null);
  const [linkedMessage, setLinkedMessage] = useState<string | null>(null);
  // One-shot: setAuth updates the store while `code` is still in the URL, which
  // would re-fire this effect and burn the already-consumed handoff.
  const handledRef = useRef(false);

  useEffect(() => {
    if (handledRef.current) return;

    const providerError = params.get("error");
    const linked = params.get("linked");
    const code = params.get("code");

    // In-session provider link (Settings → Google) returns `linked=google`
    // instead of a login handoff code.
    if (linked) {
      handledRef.current = true;
      const label = linked === "google" ? "Google" : linked;
      setLinkedMessage(`${label} linked to your account.`);
      const redirect =
        sessionStorage.getItem("cheers.oauth_redirect") || "/settings/account";
      sessionStorage.removeItem("cheers.oauth_redirect");
      window.setTimeout(() => {
        navigate(
          redirect.startsWith("/") && !redirect.startsWith("//")
            ? redirect
            : "/settings/account",
          { replace: true }
        );
      }, 600);
      return;
    }

    if (providerError || !code) {
      handledRef.current = true;
      setError(
        providerError === "access_denied"
          ? "Sign-in was cancelled."
          : "The sign-in callback is invalid."
      );
      return;
    }

    handledRef.current = true;
    void exchangeOAuthHandoff(code)
      .then((outcome) => {
        if (outcome.status === "factor_required" || outcome.requires_2fa) {
          if (!outcome.transaction_id) throw new Error("Authentication transaction is missing");
          const factors = (outcome.allowed_factors ?? []).join(",");
          const qs = new URLSearchParams({
            factor_transaction: outcome.transaction_id,
          });
          if (factors) qs.set("allowed_factors", factors);
          navigate(`/login?${qs.toString()}`, { replace: true });
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
      .catch((reason) => setError(errorMessage(reason, "Sign-in failed")));
  }, [navigate, params, setAuth]);

  return (
    <PublicPageShell
      title={error ? "Couldn't sign in" : linkedMessage ? "Account linked" : "Completing sign-in"}
      description={error ?? linkedMessage ?? "Please keep this page open while we verify the handoff."}
    >
      <div className={`${publicPanelClass} text-center`}>
        {error ? (
        <div>
          <h2 className="font-masthead text-comfortable">Couldn&apos;t sign in</h2>
          <p className="mt-2 text-regular text-content-muted">{error}</p>
          <UiButton action="signIn" variant="plain" className={`mt-5 ${publicLinkClass}`} onClick={() => navigate("/login", { replace: true })}>
            Back to sign in
          </UiButton>
        </div>
      ) : linkedMessage ? (
        <div>
          <h2 className="font-masthead text-comfortable">Linked</h2>
          <p className="mt-2 text-regular text-content-muted">{linkedMessage}</p>
        </div>
      ) : (
        <Spinner contentSize="large" className="text-content-muted" />
      )}
      </div>
    </PublicPageShell>
  );
}
