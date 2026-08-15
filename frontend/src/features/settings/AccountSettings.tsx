import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, KeyRound, Laptop, Link2, Shield, Trash2 } from "lucide-react";
import toast from "react-hot-toast";
import {
  changePassword,
  deleteAccount,
  getExternalIdentity,
  unlinkExternalIdentity,
  startExternalIdentityOAuthLink,
  type ExternalIdentityStatus,
} from "@/api/auth";
import {
  listAuthSessions,
  revokeAuthSession,
  listAIConsents,
  revokeAIConsent,
  type AuthSessionSummary,
  type StoredAIConsent,
} from "@/api/accountSecurity";
import { ActionButton } from "@/components/ui/action-button";
import { Field } from "@/components/ui/field";
import { Input as UiInput } from "@/components/ui/input";
import { ItemList, OperationsItem } from "@/components/ui/item";
import { isTauri } from "@/lib/serverConfig";
import { queryKeys } from "@/lib/queryClient";

export function ChangePasswordCard({ onRotated }: { onRotated: (token: string) => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [twoFactorCode, setTwoFactorCode] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (next.length < 12) {
      toast.error("New password must be at least 12 characters");
      return;
    }
    if (next !== confirm) {
      toast.error("Passwords don't match");
      return;
    }
    setBusy(true);
    try {
      const res = await changePassword({
        current_password: current,
        new_password: next,
        two_factor_code: twoFactorCode.trim() || undefined,
      });
      onRotated(res.access_token); // keep this session alive on the fresh token
      setCurrent("");
      setNext("");
      setConfirm("");
      setTwoFactorCode("");
      toast.success("Password changed — other sessions were signed out");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to change password");
    } finally {
      setBusy(false);
    }
  }

  // text-comfortable (16px) below md prevents iOS Safari's auto-zoom on focus.
  const inputCls =
    "bg-zinc-800 text-content-primary";
  return (
    <section className="py-5 first:pt-0">
      <div className="mb-4 flex min-w-0 items-start gap-3">
        <KeyRound className="h-4 w-4 flex-shrink-0 text-accent-400" />
        <div className="min-w-0 flex-1">
          <h3 className="font-utility text-regular font-medium text-content-secondary">Change password</h3>
          <p className="mt-1 font-utility text-compact text-content-muted">
            Updating your password signs out every other device.
          </p>
        </div>
      </div>
      <div className="grid max-w-2xl grid-cols-2 gap-3 max-md:grid-cols-1">
        <Field label="Current password" htmlFor="cp-current">
          <UiInput
            id="cp-current"
            type="password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            autoComplete="current-password"
            className={inputCls}
          />
        </Field>
        <Field label="New password" htmlFor="cp-new">
          <UiInput
            id="cp-new"
            type="password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            placeholder="At least 12 characters"
            autoComplete="new-password"
            className={inputCls}
          />
        </Field>
        <Field label="Confirm password" htmlFor="cp-confirm">
          <UiInput
            id="cp-confirm"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void submit()}
            autoComplete="new-password"
            className={inputCls}
          />
        </Field>
        <Field label="2FA code" htmlFor="cp-two-factor">
          <UiInput
            id="cp-two-factor"
            type="text"
            value={twoFactorCode}
            onChange={(e) => setTwoFactorCode(e.target.value)}
            placeholder="Authenticator or backup code"
            autoComplete="one-time-code"
            className={inputCls}
          />
        </Field>
        <div className="col-span-2 flex justify-end max-md:col-span-1">
          <ActionButton
            action="update"
            context="security"
            accessibleLabel="Update account password"
            loading={busy}
            onClick={() => void submit()}
            disabled={!current || !next}
          />
        </div>
      </div>
    </section>
  );
}

export function ExternalIdentitiesCard() {
  const queryClient = useQueryClient();
  const identities = useQuery({
    queryKey: queryKeys.externalIdentities,
    queryFn: () => Promise.all([getExternalIdentity("apple"), getExternalIdentity("google")]),
  });
  const [linkingProvider, setLinkingProvider] = useState<"google" | null>(null);
  const unlinkIdentity = useMutation({
    mutationFn: unlinkExternalIdentity,
    onSuccess: async (_, provider) => {
      toast.success(`${provider === "apple" ? "Apple" : "Google"} unlinked`);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.externalIdentities }),
        queryClient.invalidateQueries({ queryKey: queryKeys.authSessions }),
      ]);
    },
  });
  const busy = linkingProvider ?? (unlinkIdentity.isPending ? unlinkIdentity.variables : null);

  async function unlink(identity: ExternalIdentityStatus) {
    if (
      !window.confirm(
        `Unlink ${identity.provider === "apple" ? "Apple" : "Google"}? Other devices will be signed out.`
      )
    ) {
      return;
    }
    try {
      await unlinkIdentity.mutateAsync(identity.provider);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't unlink identity");
    }
  }

  async function linkGoogle(identity: ExternalIdentityStatus) {
    if (!identity.recent_authentication) {
      toast.error("Sign in again (within 5 minutes), then link Google.");
      return;
    }
    setLinkingProvider("google");
    try {
      sessionStorage.setItem("cheers.oauth_redirect", "/settings/account");
      const started = await startExternalIdentityOAuthLink("google");
      if (isTauri()) {
        const { invokeDesktop } = await import("@/lib/desktop");
        await invokeDesktop("desktop_open_oauth_url", { url: started.authorization_url });
      } else {
        window.location.assign(started.authorization_url);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't start Google link");
    } finally {
      // Tauri opens an external browser and returns immediately; clear busy so
      // canceling OAuth doesn't leave the control stuck on “Opening…”.
      setLinkingProvider(null);
    }
  }

  return (
    <section className="border-t border-zinc-600/70 py-5">
      <p className="text-regular font-medium text-content-secondary flex items-center gap-2">
        <Link2 className="w-4 h-4 text-accent-400" /> Sign-in methods
      </p>
      <p className="text-compact text-content-muted mt-1 mb-4">
        Removing a provider signs out other sessions and removes trusted devices.
      </p>
      {identities.isError ? (
        <ActionButton action="retry" context="settings" accessibleLabel="Retry loading sign-in methods" onClick={() => void identities.refetch()} />
      ) : (
        <ItemList presentationLevel="medium" controlSize="regular">
          {(identities.data ?? []).map((identity) => {
            const label = identity.provider === "apple" ? "Apple" : "Google";
            return (
              <OperationsItem
                key={identity.provider}
                title={label}
                status={identity.linked ? identity.email || identity.display_name || "Linked" : "Not linked"}
                actions={identity.linked ? (
                  <ActionButton
                    action="unlink"
                    context="security"
                    accessibleLabel={`Unlink ${label} sign-in method`}
                    loading={busy === identity.provider}
                    disabled={
                      busy !== null ||
                      !identity.can_unlink ||
                      !identity.recent_authentication
                    }
                    title={
                      !identity.can_unlink
                        ? "Add another sign-in method first"
                        : !identity.recent_authentication
                          ? "Sign in again to make this change"
                          : `Unlink ${label}`
                    }
                    onClick={() => void unlink(identity)}
                  />
                ) : identity.provider === "google" ? (
                  <ActionButton
                    action="link"
                    context="security"
                    accessibleLabel="Link Google sign-in method"
                    loading={busy === "google"}
                    disabled={busy !== null || !identity.recent_authentication}
                    title={
                      !identity.recent_authentication
                        ? "Sign in again to make this change"
                        : "Link Google"
                    }
                    onClick={() => void linkGoogle(identity)}
                  />
                ) : undefined}
              />
            );
          })}
          {identities.isPending && <OperationsItem title="Loading sign-in methods…" disabled />}
        </ItemList>
      )}
      {identities.data?.some((identity) => !identity.recent_authentication) && (
        <p className="text-compact text-warning-400 mt-4">
          Sign in again before linking or unlinking an identity.
        </p>
      )}
    </section>
  );
}

export function DeleteAccountCard({ onDeleted }: { onDeleted: () => void }) {
  const [confirmation, setConfirmation] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  async function remove() {
    if (confirmation !== "DELETE") return;
    if (!window.confirm("Permanently delete your Cheers account and its personal data?")) {
      return;
    }
    setBusy(true);
    try {
      await deleteAccount({
        confirmation,
        current_password: password || undefined,
      });
      onDeleted();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't delete account");
      setBusy(false);
    }
  }

  return (
    <section className="border-t border-red-950/70 py-5">
      <p className="text-regular font-medium text-danger-300 flex items-center gap-2">
        <Trash2 className="w-4 h-4" /> Delete account
      </p>
      <p className="text-compact text-content-muted mt-1 mb-4">
        This permanently removes your account. Passwordless accounts must have signed in within the last five minutes.
      </p>
      <div className="grid max-w-2xl grid-cols-2 gap-3 max-md:grid-cols-1">
        <Field label="Current password" hint="Optional for passwordless accounts">
          <UiInput
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
          />
        </Field>
        <Field label="Confirmation" hint="Type DELETE to confirm">
          <UiInput
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            placeholder="DELETE"
          />
        </Field>
        <div className="col-span-2 flex justify-end max-md:col-span-1">
          <ActionButton
            action="delete"
            context="confirmation"
            accessibleLabel="Permanently delete account"
            disabled={busy || confirmation !== "DELETE"}
            loading={busy}
            onClick={() => void remove()}
          />
        </div>
      </div>
    </section>
  );
}

export function LegalLinks() {
  const links = [
    ["Privacy", "https://www.tocheers.com/privacy.html"],
    ["Terms", "https://www.tocheers.com/terms.html"],
    ["Support", "https://www.tocheers.com/support.html"],
    ["Account deletion", "https://www.tocheers.com/account-deletion.html"],
    ["Remote Operation Safety", "https://www.tocheers.com/remote-operations.html"],
  ] as const;
  return (
    <div className="flex flex-wrap gap-x-5 gap-y-2 px-1 mt-5">
      {links.map(([label, href]) => (
        <a
          key={href}
          href={href}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-compact text-content-muted hover:text-content-secondary"
        >
          {label} <ExternalLink className="w-3.5 h-3.5" />
        </a>
      ))}
    </div>
  );
}

export function DevicesSessionsCard() {
  const queryClient = useQueryClient();
  const sessions = useQuery({ queryKey: queryKeys.authSessions, queryFn: listAuthSessions });
  const revokeSession = useMutation({
    mutationFn: revokeAuthSession,
    onSuccess: async () => {
      toast.success("Session revoked");
      await queryClient.invalidateQueries({ queryKey: queryKeys.authSessions });
    },
  });

  async function revoke(session: AuthSessionSummary) {
    try {
      await revokeSession.mutateAsync(session.session_id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't revoke session");
    }
  }

  return (
    <section className="border-t border-zinc-600/70 py-5">
      <div className="flex items-center gap-2 mb-3">
        <Laptop className="w-4 h-4 text-content-muted" />
        <p className="text-regular font-medium text-content-secondary">Devices and sessions</p>
      </div>
      {sessions.isPending ? (
        <p className="text-compact text-content-muted">Loading…</p>
      ) : sessions.isError ? (
        <ActionButton action="retry" context="settings" onClick={() => void sessions.refetch()} />
      ) : (sessions.data ?? []).length === 0 ? (
        <p className="text-compact text-content-muted">No active sessions.</p>
      ) : (
        <ItemList presentationLevel="medium" controlSize="regular">
          {(sessions.data ?? []).map((s) => (
            <OperationsItem
              key={s.session_id}
              title={`${s.device_name || s.client}${s.current ? " · this device" : ""}`}
              trailing={<span className="text-compact text-content-muted" title={`Last seen ${new Date(s.last_seen_at).toLocaleString()}`}>
                {new Date(s.last_seen_at).toLocaleDateString()}
              </span>}
              actions={!s.current ? (
                <ActionButton
                  action="revoke"
                  context="security"
                  accessibleLabel={`Revoke session ${s.device_name || s.client}`}
                  loading={revokeSession.isPending && revokeSession.variables === s.session_id}
                  onClick={() => void revoke(s)}
                />
              ) : undefined}
            />
          ))}
        </ItemList>
      )}
    </section>
  );
}

export function ExternalAIPermissionsCard() {
  const queryClient = useQueryClient();
  const consents = useQuery({ queryKey: queryKeys.aiConsents, queryFn: listAIConsents });
  const revokeConsent = useMutation({
    mutationFn: ({ channelId, botId }: { channelId: string; botId: string }) =>
      revokeAIConsent(channelId, botId),
    onSuccess: async () => {
      toast.success("Permission revoked");
      await queryClient.invalidateQueries({ queryKey: queryKeys.aiConsents });
    },
  });

  async function revoke(c: StoredAIConsent) {
    try {
      await revokeConsent.mutateAsync({ channelId: c.channel_id, botId: c.bot_id });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't revoke");
    }
  }

  return (
    <section className="border-t border-zinc-600/70 py-5">
      <div className="flex items-center gap-2 mb-3">
        <Shield className="w-4 h-4 text-content-muted" />
        <p className="text-regular font-medium text-content-secondary">External AI permissions</p>
      </div>
      {consents.isPending ? (
        <p className="text-compact text-content-muted">Loading…</p>
      ) : consents.isError ? (
        <ActionButton action="retry" context="settings" onClick={() => void consents.refetch()} />
      ) : (consents.data ?? []).length === 0 ? (
        <p className="text-compact text-content-muted">
          No stored consents. When a bot uses an external AI processor, agreements
          appear here.
        </p>
      ) : (
        <ItemList presentationLevel="medium" controlSize="regular">
          {(consents.data ?? []).map((c) => {
            const key = `${c.channel_id}:${c.bot_id}`;
            return (
              <OperationsItem
                key={key}
                title={`${c.bot_name}${c.provider_name ? ` · ${c.provider_name}` : ""}`}
                status={`#${c.channel_name} · policy ${c.policy_version}`}
                actions={<ActionButton
                  controlSize="compact"
                  action="revoke"
                  context="security"
                  accessibleLabel={`Revoke external AI permission for ${c.bot_name}`}
                  loading={
                    revokeConsent.isPending &&
                    `${revokeConsent.variables.channelId}:${revokeConsent.variables.botId}` === key
                  }
                  onClick={() => void revoke(c)}
                />}
              />
            );
          })}
        </ItemList>
      )}
    </section>
  );
}
