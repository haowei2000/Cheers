import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronRight,
  ExternalLink,
  KeyRound,
  Laptop,
  Link2,
  LogOut,
  Shield,
  Trash2,
} from "lucide-react";
import { useSearchParams } from "react-router-dom";
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
import { Banner } from "@/components/ui/banner";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input as UiInput } from "@/components/ui/input";
import { ItemList, OperationsItem } from "@/components/ui/item";
import { isTauri } from "@/lib/serverConfig";
import { queryKeys } from "@/lib/queryClient";
import { onOAuthLinked } from "@/lib/oauthCallback";

export function ChangePasswordAction({ onRotated }: { onRotated: (token: string) => void }) {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [twoFactorCode, setTwoFactorCode] = useState("");
  const [busy, setBusy] = useState(false);

  function closeDialog() {
    if (busy) return;
    setCurrent("");
    setNext("");
    setConfirm("");
    setTwoFactorCode("");
    setOpen(false);
  }

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
      setOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to change password");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <OperationsItem
        leading={<KeyRound className="h-4 w-4 text-content-muted" />}
        title="Password"
        subtitle="Change your password and sign out other devices"
        trailing={<ChevronRight className="h-4 w-4 text-content-muted" aria-hidden="true" />}
        aria-label="Change password"
        onClick={() => setOpen(true)}
      />
      {open && (
        <Dialog title="Change password" onClose={closeDialog} maxWidth="max-w-lg">
          <p className="text-caption">Updating your password signs out every other device.</p>
          <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
            <Field label="Current password" htmlFor="cp-current">
              <UiInput id="cp-current" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
            </Field>
            <Field label="New password" htmlFor="cp-new">
              <UiInput id="cp-new" type="password" value={next} onChange={(e) => setNext(e.target.value)} placeholder="At least 12 characters" autoComplete="new-password" />
            </Field>
            <Field label="Confirm password" htmlFor="cp-confirm">
              <UiInput id="cp-confirm" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void submit()} autoComplete="new-password" />
            </Field>
            <Field label="Verification code" htmlFor="cp-two-factor">
              <UiInput id="cp-two-factor" value={twoFactorCode} onChange={(e) => setTwoFactorCode(e.target.value)} placeholder="Authenticator or recovery code" autoComplete="one-time-code" />
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            <ActionButton action="cancel" context="dialog" onClick={closeDialog} disabled={busy} />
            <ActionButton
              action="update"
              context="security"
              accessibleLabel="Update account password"
              loading={busy}
              onClick={() => void submit()}
              disabled={!current || !next}
            />
          </div>
        </Dialog>
      )}
    </>
  );
}

export function SignOutAction({ onSignOut }: { onSignOut: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function confirm() {
    setBusy(true);
    try {
      await onSignOut();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <OperationsItem
        leading={<LogOut className="h-4 w-4 text-content-muted" />}
        title="Sign out"
        subtitle="End the session on this device"
        trailing={<ChevronRight className="h-4 w-4 text-content-muted" aria-hidden="true" />}
        onClick={() => setOpen(true)}
      />
      {open && (
        <Dialog title="Sign out" onClose={() => !busy && setOpen(false)}>
          <p className="text-caption">This session will be revoked and you will return to the sign-in page.</p>
          <div className="flex justify-end gap-2">
            <ActionButton action="cancel" context="dialog" onClick={() => setOpen(false)} disabled={busy} />
            <ActionButton action="signOut" context="settings" loading={busy} onClick={() => void confirm()} />
          </div>
        </Dialog>
      )}
    </>
  );
}

export function ExternalIdentitiesCard() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedProvider = ["google", "github"].includes(
    searchParams.get("link_provider") ?? ""
  )
    ? (searchParams.get("link_provider") as "google" | "github")
    : null;
  const identities = useQuery({
    queryKey: queryKeys.externalIdentities,
    queryFn: () => Promise.all([
      getExternalIdentity("apple"),
      getExternalIdentity("google"),
      getExternalIdentity("github"),
    ]),
  });
  const [linkingProvider, setLinkingProvider] = useState<"google" | "github" | null>(null);
  const unlinkIdentity = useMutation({
    mutationFn: unlinkExternalIdentity,
    onSuccess: async (_, provider) => {
      toast.success(`${provider === "apple" ? "Apple" : provider === "github" ? "GitHub" : "Google"} unlinked`);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.externalIdentities }),
        queryClient.invalidateQueries({ queryKey: queryKeys.authSessions }),
      ]);
    },
  });
  const busy = linkingProvider ?? (unlinkIdentity.isPending ? unlinkIdentity.variables : null);
  const requestedIdentity = identities.data?.find(
    (identity) => identity.provider === requestedProvider
  );

  useEffect(() => onOAuthLinked((provider) => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.externalIdentities });
    const next = new URLSearchParams(searchParams);
    next.delete("link_provider");
    setSearchParams(next, { replace: true });
    toast.success(`${provider === "github" ? "GitHub" : "Google"} linked`);
  }), [queryClient, searchParams, setSearchParams]);

  function dismissLinkRequest() {
    const next = new URLSearchParams(searchParams);
    next.delete("link_provider");
    setSearchParams(next, { replace: true });
  }

  async function unlink(identity: ExternalIdentityStatus) {
    if (
      !window.confirm(
        `Unlink ${identity.provider === "apple" ? "Apple" : identity.provider === "github" ? "GitHub" : "Google"}? Other devices will be signed out.`
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

  async function linkOAuth(identity: ExternalIdentityStatus) {
    if (identity.provider !== "google" && identity.provider !== "github") return;
    const label = identity.provider === "github" ? "GitHub" : "Google";
    if (!identity.recent_authentication) {
      toast.error(`Sign in again (within 5 minutes), then link ${label}.`);
      return;
    }
    setLinkingProvider(identity.provider);
    try {
      sessionStorage.setItem("cheers.oauth_redirect", "/settings/account");
      const started = await startExternalIdentityOAuthLink(identity.provider);
      if (isTauri()) {
        const { invokeDesktop } = await import("@/lib/desktop");
        await invokeDesktop("desktop_open_oauth_url", { url: started.authorization_url });
      } else {
        window.location.assign(started.authorization_url);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : `Couldn't start ${label} link`);
    } finally {
      // Tauri opens an external browser and returns immediately; clear busy so
      // canceling OAuth doesn't leave the control stuck on “Opening…”.
      setLinkingProvider(null);
    }
  }

  return (
    <section className="border-t border-zinc-600/70 py-5">
      <p className="text-regular font-medium text-content-secondary flex items-center gap-2">
        <Link2 className="w-4 h-4 text-accent-400" /> Connected sign-in methods
      </p>
      <p className="text-compact text-content-muted mt-1 mb-4">
        Use a connected account to sign in. Removing one signs out other sessions.
      </p>
      {requestedProvider && !requestedIdentity?.linked && (
        <Banner
          severity="info"
          icon={Link2}
          className="mb-4"
          action={requestedIdentity?.recent_authentication ? {
            label: `Link ${requestedProvider === "github" ? "GitHub" : "Google"}`,
            onClick: () => void linkOAuth(requestedIdentity),
          } : undefined}
          onDismiss={dismissLinkRequest}
        >
          You&apos;re signed in. Link {requestedProvider === "github" ? "GitHub" : "Google"} to use it next time.
        </Banner>
      )}
      {identities.isError ? (
        <ActionButton action="retry" context="settings" accessibleLabel="Retry loading sign-in methods" onClick={() => void identities.refetch()} />
      ) : (
        <ItemList presentationLevel="medium" controlSize="regular">
          {(identities.data ?? []).filter((identity) =>
            identity.linked || identity.provider === "google" || identity.provider === "github"
          ).map((identity) => {
            const label = identity.provider === "apple" ? "Apple" : identity.provider === "github" ? "GitHub" : "Google";
            return (
              <OperationsItem
                key={identity.provider}
                title={label}
                status={identity.linked ? identity.email || identity.display_name || "Linked" : "Not linked"}
                subtitle={!identity.recent_authentication ? "Sign in again to make changes" : undefined}
                actions={identity.linked && identity.can_unlink && identity.recent_authentication ? (
                  <ActionButton
                    action="unlink"
                    context="security"
                    accessibleLabel={`Unlink ${label} sign-in method`}
                    loading={busy === identity.provider}
                    disabled={busy !== null}
                    title={`Unlink ${label}`}
                    onClick={() => void unlink(identity)}
                  />
                ) : !identity.linked && identity.recent_authentication && (identity.provider === "google" || identity.provider === "github") ? (
                  <ActionButton
                    action="link"
                    context="security"
                    accessibleLabel={`Link ${label} sign-in method`}
                    loading={busy === identity.provider}
                    disabled={busy !== null}
                    title={`Link ${label}`}
                    onClick={() => void linkOAuth(identity)}
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
          Sign in again to change your sign-in methods.
        </p>
      )}
    </section>
  );
}

export function DeleteAccountAction({ onDeleted }: { onDeleted: () => void }) {
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  function closeDialog() {
    if (busy) return;
    setConfirmation("");
    setPassword("");
    setOpen(false);
  }

  async function remove() {
    if (confirmation !== "DELETE") return;
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
    <>
      <OperationsItem
        leading={<Trash2 className="h-4 w-4 text-danger-400" />}
        title={<span className="text-danger-400">Delete account</span>}
        subtitle="Permanently remove your account and personal data"
        trailing={<ChevronRight className="h-4 w-4 text-danger-400" aria-hidden="true" />}
        aria-label="Delete account"
        onClick={() => setOpen(true)}
      />
      {open && (
        <Dialog title="Delete account" onClose={closeDialog}>
          <p className="text-caption text-danger-300">
            This permanently removes your account and personal data. This action cannot be undone.
          </p>
          <Field label="Current password" hint="Optional for passwordless accounts" htmlFor="delete-account-password">
            <UiInput id="delete-account-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" />
          </Field>
          <Field label="Confirmation" hint="Type DELETE to confirm" htmlFor="delete-account-confirmation">
            <UiInput id="delete-account-confirmation" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder="DELETE" />
          </Field>
          <div className="flex justify-end gap-2">
            <ActionButton action="cancel" context="dialog" onClick={closeDialog} disabled={busy} />
            <ActionButton action="delete" context="confirmation" accessibleLabel="Permanently delete account" disabled={busy || confirmation !== "DELETE"} loading={busy} onClick={() => void remove()} />
          </div>
        </Dialog>
      )}
    </>
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
