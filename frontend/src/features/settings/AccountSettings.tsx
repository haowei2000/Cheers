import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronRight,
  ExternalLink,
  KeyRound,
  Laptop,
  Link2,
  LogOut,
  Mail,
  Shield,
  Trash2,
} from "lucide-react";
import { useSearchParams } from "react-router-dom";
import toast from "react-hot-toast";
import {
  changePassword,
  deleteAccount,
  getExternalIdentity,
  requestEmailUpdateCode,
  setPassword,
  startExternalIdentityOAuthLink,
  unlinkExternalIdentity,
  updateEmail,
  type ExternalIdentityStatus,
} from "@/api/auth";
import { getMe } from "@/api/users";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input as UiInput } from "@/components/ui/input";
import { ItemList, OperationsItem } from "@/components/ui/item";
import { CollectionConfirmationItem } from "@/components/ui/collection-manager";
import { SettingsCardSection } from "@/components/ui/settings-card";
import { isTauri } from "@/lib/serverConfig";
import { queryKeys } from "@/lib/queryClient";
import { onOAuthLinked } from "@/lib/oauthCallback";

export function EmailAction() {
  const queryClient = useQueryClient();
  const profile = useQuery({ queryKey: queryKeys.currentUser, queryFn: getMe });
  const email = profile.data?.email;

  const [open, setOpen] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [sendingCode, setSendingCode] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setInterval(() => {
      setCooldown((c) => Math.max(0, c - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [cooldown]);

  function closeDialog() {
    if (busy) return;
    setOpen(false);
    setNewEmail("");
    setCode("");
    setCodeSent(false);
  }

  async function handleSendCode() {
    const trimmed = newEmail.trim().toLowerCase();
    if (!trimmed || !trimmed.includes("@")) {
      toast.error("Please enter a valid email address");
      return;
    }
    setSendingCode(true);
    try {
      await requestEmailUpdateCode(trimmed);
      setCodeSent(true);
      setCooldown(60);
      toast.success("Verification code sent");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to send verification code");
    } finally {
      setSendingCode(false);
    }
  }

  async function handleSubmit() {
    const trimmedEmail = newEmail.trim().toLowerCase();
    const trimmedCode = code.trim().toUpperCase();
    if (!trimmedEmail) {
      toast.error("Please enter an email address");
      return;
    }
    if (!trimmedCode) {
      toast.error("Please enter the verification code");
      return;
    }
    setBusy(true);
    try {
      await updateEmail({ email: trimmedEmail, code: trimmedCode });
      toast.success("Email address updated");
      await queryClient.invalidateQueries({ queryKey: queryKeys.currentUser });
      closeDialog();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to update email address");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <OperationsItem
        leading={<Mail className="h-4 w-4 text-content-muted" />}
        title="Email"
        subtitle={email || "No email address linked"}
        trailing={<ChevronRight className="h-4 w-4 text-content-muted" aria-hidden="true" />}
        aria-label="Manage email address"
        onClick={() => {
          setNewEmail(email || "");
          setCode("");
          setCodeSent(false);
          setOpen(true);
        }}
      />
      {open && (
        <Dialog
          title={email ? "Change email address" : "Set email address"}
          onClose={closeDialog}
          maxWidth="max-w-md"
        >
          <p className="text-caption">
            We will send a 6-digit verification code to confirm ownership of the email address.
          </p>
          <div className="space-y-3">
            <Field label="Email address" htmlFor="email-input">
              <div className="flex gap-2">
                <UiInput
                  id="email-input"
                  type="email"
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  placeholder="name@example.com"
                  autoComplete="email"
                  disabled={busy}
                  className="flex-1"
                />
                <Button
                  action="send"
                  variant="secondary"
                  controlWidth="content"
                  controlSize="regular"
                  disabled={sendingCode || cooldown > 0 || !newEmail.trim()}
                  onClick={() => void handleSendCode()}
                >
                  {cooldown > 0 ? `${cooldown}s` : codeSent ? "Resend" : "Send code"}
                </Button>
              </div>
            </Field>
            {codeSent && (
              <Field label="Verification code" htmlFor="email-code-input">
                <UiInput
                  id="email-code-input"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="123456"
                  autoComplete="one-time-code"
                  disabled={busy}
                  onKeyDown={(e) => e.key === "Enter" && void handleSubmit()}
                />
              </Field>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <ActionButton action="cancel" context="dialog" onClick={closeDialog} disabled={busy} />
            <ActionButton
              action="save"
              context="settings"
              accessibleLabel="Save email address"
              loading={busy}
              onClick={() => void handleSubmit()}
              disabled={!newEmail.trim() || !code.trim()}
            />
          </div>
        </Dialog>
      )}
    </>
  );
}

export function ChangePasswordAction({ onRotated }: { onRotated: (token: string) => void }) {
  const queryClient = useQueryClient();
  const profile = useQuery({ queryKey: queryKeys.currentUser, queryFn: getMe });
  const hasPassword = profile.data?.has_password ?? true;

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
      if (hasPassword) {
        const res = await changePassword({
          current_password: current,
          new_password: next,
          two_factor_code: twoFactorCode.trim() || undefined,
        });
        onRotated(res.access_token); // keep this session alive on the fresh token
        toast.success("Password changed — other sessions were signed out");
      } else {
        const res = await setPassword({
          new_password: next,
        });
        onRotated(res.access_token);
        toast.success("Password set successfully");
      }
      setCurrent("");
      setNext("");
      setConfirm("");
      setTwoFactorCode("");
      await queryClient.invalidateQueries({ queryKey: queryKeys.currentUser });
      setOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to update password");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <OperationsItem
        leading={<KeyRound className="h-4 w-4 text-content-muted" />}
        title={hasPassword ? "Password" : "Set password"}
        subtitle={
          hasPassword
            ? "Change your password and sign out other devices"
            : "Add a password to sign in without an external provider"
        }
        trailing={<ChevronRight className="h-4 w-4 text-content-muted" aria-hidden="true" />}
        aria-label={hasPassword ? "Change password" : "Set password"}
        onClick={() => setOpen(true)}
      />
      {open && (
        <Dialog
          title={hasPassword ? "Change password" : "Set password"}
          onClose={closeDialog}
          maxWidth="max-w-lg"
        >
          <p className="text-caption">
            {hasPassword
              ? "Updating your password signs out every other device."
              : "Create a password to sign in to Cheers with your username or email."}
          </p>
          <div className={hasPassword ? "grid grid-cols-2 gap-3 max-md:grid-cols-1" : "space-y-3"}>
            {hasPassword && (
              <Field label="Current password" htmlFor="cp-current">
                <UiInput
                  id="cp-current"
                  type="password"
                  value={current}
                  onChange={(e) => setCurrent(e.target.value)}
                  autoComplete="current-password"
                />
              </Field>
            )}
            <Field label="New password" htmlFor="cp-new">
              <UiInput
                id="cp-new"
                type="password"
                value={next}
                onChange={(e) => setNext(e.target.value)}
                placeholder="At least 12 characters"
                autoComplete="new-password"
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
              />
            </Field>
            {hasPassword && (
              <Field label="Verification code" htmlFor="cp-two-factor">
                <UiInput
                  id="cp-two-factor"
                  value={twoFactorCode}
                  onChange={(e) => setTwoFactorCode(e.target.value)}
                  placeholder="Authenticator or recovery code"
                  autoComplete="one-time-code"
                />
              </Field>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <ActionButton action="cancel" context="dialog" onClick={closeDialog} disabled={busy} />
            <ActionButton
              action="update"
              context="security"
              accessibleLabel={hasPassword ? "Update account password" : "Set account password"}
              loading={busy}
              onClick={() => void submit()}
              disabled={(hasPassword && !current) || !next || !confirm}
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
  const [unlinkTarget, setUnlinkTarget] = useState<ExternalIdentityStatus | null>(null);
  const unlinkIdentity = useMutation({
    mutationFn: unlinkExternalIdentity,
    onSuccess: async (_, provider) => {
      toast.success(`${provider === "apple" ? "Apple" : provider === "github" ? "GitHub" : "Google"} unlinked`);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.externalIdentities }),
        queryClient.invalidateQueries({ queryKey: queryKeys.authSessions }),
      ]);
      setUnlinkTarget(null);
    },
  });
  const busy = linkingProvider ?? (unlinkIdentity.isPending ? unlinkIdentity.variables : unlinkTarget?.provider ?? null);
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
      toast.error(`Confirm your identity, then link ${label}.`);
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
    <SettingsCardSection
      title="Connected sign-in methods"
      description="Use a connected account to sign in. Removing one signs out other sessions."
      icon={Link2}
    >
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
        <ItemList presentationLevel="medium" controlSize="regular">
          <OperationsItem
            title="Couldn't load sign-in methods"
            actions={<ActionButton action="retry" context="settings" accessibleLabel="Retry loading sign-in methods" onClick={() => void identities.refetch()} />}
          />
        </ItemList>
      ) : (
        <ItemList presentationLevel="medium" controlSize="regular">
          {(identities.data ?? []).filter((identity) =>
            identity.linked || identity.provider === "google" || identity.provider === "github"
          ).map((identity) => {
            const label = identity.provider === "apple" ? "Apple" : identity.provider === "github" ? "GitHub" : "Google";
            if (unlinkTarget?.provider === identity.provider) {
              return (
                <CollectionConfirmationItem
                  key={identity.provider}
                  title={label}
                  description="Other devices will be signed out after this method is unlinked."
                  action="unlink"
                  prompt="Unlink?"
                  busy={unlinkIdentity.isPending}
                  onCancel={() => setUnlinkTarget(null)}
                  onConfirm={() => void unlink(identity)}
                />
              );
            }
            return (
              <OperationsItem
                key={identity.provider}
                title={label}
                status={(
                  <Badge tone={identity.linked ? "success" : "neutral"} indicator={identity.linked}>
                    {identity.linked ? identity.email || identity.display_name || "Linked" : "Not linked"}
                  </Badge>
                )}
                subtitle={!identity.recent_authentication ? "Sign in again to make changes" : undefined}
                actions={identity.linked && identity.can_unlink && identity.recent_authentication ? (
                  <ActionButton
                    action="unlink"
                    context="security"
                    accessibleLabel={`Unlink ${label} sign-in method`}
                    loading={busy === identity.provider}
                    disabled={busy !== null}
                    title={`Unlink ${label}`}
                    onClick={() => setUnlinkTarget(identity)}
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
        <Banner severity="warning" className="mt-4">
          Sign in again to change your sign-in methods.
        </Banner>
      )}
    </SettingsCardSection>
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
  const [revokeTarget, setRevokeTarget] = useState<AuthSessionSummary | null>(null);
  const revokeSession = useMutation({
    mutationFn: revokeAuthSession,
    onSuccess: async () => {
      toast.success("Session revoked");
      await queryClient.invalidateQueries({ queryKey: queryKeys.authSessions });
      setRevokeTarget(null);
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
    <SettingsCardSection
      title="Devices and sessions"
      description="Review active sign-ins and revoke devices you no longer use."
      icon={Laptop}
    >
      <ItemList presentationLevel="medium" controlSize="regular">
        {sessions.isPending ? (
          <OperationsItem title="Loading active sessions…" disabled />
        ) : sessions.isError ? (
          <OperationsItem
            title="Couldn't load active sessions"
            actions={<ActionButton action="retry" context="settings" onClick={() => void sessions.refetch()} />}
          />
        ) : (sessions.data ?? []).length === 0 ? (
          <OperationsItem title="No active sessions" />
        ) : (
          (sessions.data ?? []).map((s) => (
            revokeTarget?.session_id === s.session_id ? (
              <CollectionConfirmationItem
                key={s.session_id}
                title={s.device_name || s.client}
                description="This device will be signed out of Cheers."
                action="revoke"
                prompt="Revoke?"
                busy={revokeSession.isPending}
                onCancel={() => setRevokeTarget(null)}
                onConfirm={() => void revoke(s)}
              />
            ) : (
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
                    disabled={revokeTarget !== null}
                    onClick={() => setRevokeTarget(s)}
                  />
                ) : undefined}
              />
            )
          ))
        )}
      </ItemList>
    </SettingsCardSection>
  );
}

export function ExternalAIPermissionsCard() {
  const queryClient = useQueryClient();
  const consents = useQuery({ queryKey: queryKeys.aiConsents, queryFn: listAIConsents });
  const [revokeTarget, setRevokeTarget] = useState<StoredAIConsent | null>(null);
  const revokeConsent = useMutation({
    mutationFn: ({ channelId, botId }: { channelId: string; botId: string }) =>
      revokeAIConsent(channelId, botId),
    onSuccess: async () => {
      toast.success("Permission revoked");
      await queryClient.invalidateQueries({ queryKey: queryKeys.aiConsents });
      setRevokeTarget(null);
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
    <SettingsCardSection
      title="External AI permissions"
      description="Review agreements that allow bots to use external AI processors."
      icon={Shield}
    >
      <ItemList presentationLevel="medium" controlSize="regular">
        {consents.isPending ? (
          <OperationsItem title="Loading external AI permissions…" disabled />
        ) : consents.isError ? (
          <OperationsItem
            title="Couldn't load external AI permissions"
            actions={<ActionButton action="retry" context="settings" onClick={() => void consents.refetch()} />}
          />
        ) : (consents.data ?? []).length === 0 ? (
          <OperationsItem title="No stored consents" subtitle="Agreements appear here when a bot uses an external AI processor." />
        ) : (
          (consents.data ?? []).map((c) => {
            const key = `${c.channel_id}:${c.bot_id}`;
            if (revokeTarget && `${revokeTarget.channel_id}:${revokeTarget.bot_id}` === key) {
              return (
                <CollectionConfirmationItem
                  key={key}
                  title={c.bot_name}
                  description={`Revoke its external AI permission in #${c.channel_name}.`}
                  action="revoke"
                  prompt="Revoke?"
                  busy={revokeConsent.isPending}
                  onCancel={() => setRevokeTarget(null)}
                  onConfirm={() => void revoke(c)}
                />
              );
            }
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
                  disabled={revokeTarget !== null}
                  onClick={() => setRevokeTarget(c)}
                />}
              />
            );
          })
        )}
      </ItemList>
    </SettingsCardSection>
  );
}
