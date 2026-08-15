import { Button as UiButton } from "@/components/ui/button";
import { Input as UiInput } from "@/components/ui/input";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  User,
  Bot,
  Blocks,
  Users,
  LogOut,
  KeyRound,
  AudioLines,
  Bell,
  ShieldAlert,
  Link2,
  Trash2,
  ExternalLink,
  Info,
  Server,
  Laptop,
  Shield,
  Copy,
  Check,
  CalendarClock,
} from "lucide-react";
import toast from "react-hot-toast";
import { useAuthStore, useIsAdmin } from "@/stores/authStore";
import {
  changePassword,
  deleteAccount,
  getExternalIdentity,
  logout as logoutApi,
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
import { disablePush, enablePush, getPushStatus, type PushStatus } from "@/lib/push";
import { getServerBase, isTauri, setServerBase } from "@/lib/serverConfig";
import {
  getAutostart,
  setAutostart,
  checkAppUpdate,
  installAppUpdate,
  type AppUpdate,
} from "@/lib/desktop";
import { getMe, updateMe } from "@/api/users";
import { uploadUserAvatar } from "@/api/avatars";
import { AvatarUpload } from "@/components/ui/AvatarUpload";
import { Button } from "@/components/ui/button";
import { ItemList, OperationsItem } from "@/components/ui/item";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field, SectionHead } from "@/components/ui/field";
import { WorkbenchManager } from "@/features/workbench/WorkbenchManager";
import { ScheduledMessagesManager } from "@/features/scheduled/ScheduledMessagesManager";
import { AdminUsers } from "./AdminUsers";
import { AdminSttSettings } from "./AdminSttSettings";
import { AdminReports } from "./AdminReports";
import { PasskeyCard, TwoFactorCard } from "./SecurityCards";
import { InlineEditActions } from "@/components/ui/inline-edit-actions";
import { IconButton } from "@/components/ui/icon-button";
import { OverflowText } from "@/components/ui/overflow-text";
import { RouteChromeHeader } from "@/features/desktop/RouteChromeHeader";

type SectionId =
  | "profile"
  | "bots"
  | "server"
  | "about"
  | "workbench"
  | "scheduled"
  | "members"
  | "speech"
  | "reports"
  | "account";

const NAV: {
  id: SectionId;
  label: string;
  icon: typeof User;
  adminOnly?: boolean;
  /** Only meaningful inside the Tauri desktop shell. */
  desktopOnly?: boolean;
}[] = [
  { id: "profile", label: "Profile", icon: User },
  { id: "bots", label: "Bots", icon: Bot },
  { id: "server", label: "Server", icon: Server },
  { id: "about", label: "About", icon: Info, desktopOnly: true },
  { id: "workbench", label: "Workbench", icon: Blocks, adminOnly: true },
  { id: "scheduled", label: "Scheduled tasks", icon: CalendarClock },
  { id: "members", label: "Members", icon: Users, adminOnly: true },
  { id: "speech", label: "Speech-to-text", icon: AudioLines, adminOnly: true },
  { id: "reports", label: "Safety reports", icon: ShieldAlert, adminOnly: true },
  { id: "account", label: "Account", icon: LogOut },
];

/** Current API base + switch (Tauri). Web shows the origin when same-origin. */
function ServerCard() {
  const logout = useAuthStore((s) => s.logout);
  const base = isTauri() ? getServerBase() : window.location.origin;
  return (
    <div className="bg-zinc-900 rounded-sm p-6 mt-4">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="text-regular font-medium text-zinc-200">Server</p>
          <p className="text-compact text-zinc-400 mt-1 truncate">
            {base ?? "same origin"}
          </p>
        </div>
        {isTauri() && (
          <Button action="switch"
            variant="secondary"
            controlSize="compact"
            onClick={() => {
              // Order matters: drop the session first (the token belongs to the
              // old server), then clear the base — reload lands on the picker.
              logout();
              setServerBase(null);
              window.location.reload();
            }}
          >
            Switch server
          </Button>
        )}
      </div>
      {!isTauri() && (
        <p className="text-compact text-zinc-400 mt-3">
          Web clients use this origin. Switch servers from the desktop app or by
          opening a different gateway URL.
        </p>
      )}
    </div>
  );
}

/** Desktop shell only: register the app as a macOS login item, so the tray and
 * local installation supervisor are available after sign-in. */
function LaunchAtLoginCard() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    void getAutostart().then((v) => {
      if (alive) setEnabled(v);
    });
    return () => {
      alive = false;
    };
  }, []);

  if (!isTauri()) return null;

  async function toggle() {
    if (enabled === null) return;
    setBusy(true);
    try {
      await setAutostart(!enabled);
      setEnabled(!enabled);
      toast.success(!enabled ? "Cheers will launch at login" : "Launch at login turned off");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't update launch at login");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-zinc-900 rounded-sm p-6 mt-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-regular font-medium text-zinc-200">Launch at login</p>
          <p className="text-compact text-zinc-400 mt-1">
            Start Cheers and keep local bot installations available when you sign in to your Mac.
          </p>
        </div>
        <Button action="disable"
          variant={enabled ? "secondary" : "primary"}
          controlSize="compact"
          disabled={busy || enabled === null}
          onClick={() => void toggle()}
        >
          {enabled === null ? "…" : enabled ? "Turn off" : "Turn on"}
        </Button>
      </div>
    </div>
  );
}

/** Desktop shell only: check the signed release feed and install in place.
 * Checks once on mount so a stale build surfaces without the user going
 * looking; the install itself is always an explicit click. */
function AppUpdateCard() {
  const [update, setUpdate] = useState<AppUpdate | null>(null);
  const [checking, setChecking] = useState(true);
  const [installing, setInstalling] = useState(false);
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);

  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    void import("@tauri-apps/api/app")
      .then((m) => m.getVersion())
      .then((v) => alive && setCurrentVersion(v))
      .catch(() => {});
    void checkAppUpdate()
      .then((u) => alive && setUpdate(u))
      .catch(() => {
        // Offline or a feed hiccup — the card just shows "up to date"; the
        // manual Check button is the retry.
      })
      .finally(() => alive && setChecking(false));
    return () => {
      alive = false;
    };
  }, []);

  if (!isTauri()) return null;

  async function check() {
    setChecking(true);
    try {
      const u = await checkAppUpdate();
      setUpdate(u);
      if (!u) toast.success("Cheers is up to date");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't check for updates");
    } finally {
      setChecking(false);
    }
  }

  async function install() {
    setInstalling(true);
    try {
      await installAppUpdate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Update failed");
      setInstalling(false);
    }
  }

  return (
    <section className="border-t border-zinc-600/70 py-5">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="text-regular font-medium text-zinc-200">App updates</p>
          <p className="text-compact text-zinc-400 mt-1">
            {currentVersion ? `Installed ${currentVersion}. ` : null}
            {update
              ? `Version ${update.version} is available — installing restarts Cheers.`
              : "Check GitHub for a newer signed desktop build."}
          </p>
        </div>
        {update ? (
          <Button
            variant="primary"
            action="restart"
            aria-label="Install update and restart Cheers"
            loading={installing}
            onClick={() => void install()}
          />
        ) : (
          <Button
            variant="secondary"
            action="check"
            aria-label="Check for Cheers updates"
            loading={checking}
            onClick={() => void check()}
          />
        )}
      </div>
    </section>
  );
}

/** Web Push toggle: approval requests and @mentions as OS notifications, so
 * a pending permission card reaches the user away from the tab. Hidden when
 * the deployment has no VAPID key, and when the browser can't do push. */
function PushNotificationsCard() {
  const [status, setStatus] = useState<PushStatus | "loading">("loading");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void getPushStatus().then((s) => {
      if (alive) setStatus(s);
    });
    return () => {
      alive = false;
    };
  }, []);

  // Nothing to offer: the server has push disabled, or this browser (or a dev
  // build without a service worker) can't subscribe.
  if (status === "unconfigured" || status === "unsupported") return null;

  const enabled = status === "enabled";

  async function toggle() {
    setBusy(true);
    try {
      if (enabled) {
        await disablePush();
        setStatus("disabled");
        toast.success("Push notifications turned off");
      } else {
        const next = await enablePush();
        setStatus(next);
        if (next === "enabled") {
          toast.success("Push notifications turned on");
        } else if (next === "denied") {
          toast.error(
            "Notifications are blocked for this site — allow them in your browser settings first"
          );
        }
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't update push notifications");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="border-t border-zinc-600/70 py-5">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-regular font-medium text-zinc-200 flex items-center gap-2">
            <Bell className="w-4 h-4 text-indigo-400" /> Push notifications
          </p>
          <p className="text-compact text-zinc-400 mt-1">
            Approval requests and @mentions reach this device even when Cheers
            isn't open.
            {status === "denied" &&
              " Currently blocked in your browser's site settings."}
          </p>
        </div>
        <Button
          variant={enabled ? "secondary" : "primary"}
          action={enabled ? "disable" : "enable"}
          aria-label={`${enabled ? "Turn off" : "Turn on"} push notifications`}
          loading={busy || status === "loading"}
          disabled={busy || status === "loading"}
          onClick={() => void toggle()}
        />
      </div>
    </section>
  );
}

function ChangePasswordCard({ onRotated }: { onRotated: (token: string) => void }) {
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
    "bg-zinc-800 text-zinc-100";
  return (
    <section className="py-5 first:pt-0">
      <div className="mb-4 flex min-w-0 items-start gap-3">
        <KeyRound className="h-4 w-4 flex-shrink-0 text-indigo-400" />
        <div className="min-w-0 flex-1">
          <h3 className="font-utility text-regular font-medium text-zinc-200">Change password</h3>
          <p className="mt-1 font-utility text-compact text-zinc-400">
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
          <Button
            content="iconText"
            action="update"
            aria-label="Update account password"
            loading={busy}
            onClick={() => void submit()}
            disabled={!current || !next}
          >
            <KeyRound className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </section>
  );
}

function ExternalIdentitiesCard() {
  const [identities, setIdentities] = useState<ExternalIdentityStatus[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState<"apple" | "google" | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoadError(false);
    void Promise.all([getExternalIdentity("apple"), getExternalIdentity("google")])
      .then((result) => alive && setIdentities(result))
      .catch(() => alive && setLoadError(true));
    return () => {
      alive = false;
    };
  }, [reloadKey]);

  async function unlink(identity: ExternalIdentityStatus) {
    if (
      !window.confirm(
        `Unlink ${identity.provider === "apple" ? "Apple" : "Google"}? Other devices will be signed out.`
      )
    ) {
      return;
    }
    setBusy(identity.provider);
    try {
      await unlinkExternalIdentity(identity.provider);
      toast.success(`${identity.provider === "apple" ? "Apple" : "Google"} unlinked`);
      setReloadKey((value) => value + 1);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't unlink identity");
    } finally {
      setBusy(null);
    }
  }

  async function linkGoogle(identity: ExternalIdentityStatus) {
    if (!identity.recent_authentication) {
      toast.error("Sign in again (within 5 minutes), then link Google.");
      return;
    }
    setBusy("google");
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
      setBusy(null);
    }
  }

  return (
    <section className="border-t border-zinc-600/70 py-5">
      <p className="text-regular font-medium text-zinc-200 flex items-center gap-2">
        <Link2 className="w-4 h-4 text-indigo-400" /> Sign-in methods
      </p>
      <p className="text-compact text-zinc-400 mt-1 mb-4">
        Removing a provider signs out other sessions and removes trusted devices.
      </p>
      {loadError ? (
        <Button variant="secondary" action="retry" aria-label="Retry loading sign-in methods" onClick={() => setReloadKey((value) => value + 1)} />
      ) : (
        <ItemList presentationLevel="medium" controlSize="regular">
          {(identities ?? []).map((identity) => {
            const label = identity.provider === "apple" ? "Apple" : "Google";
            return (
              <OperationsItem
                key={identity.provider}
                title={label}
                status={identity.linked ? identity.email || identity.display_name || "Linked" : "Not linked"}
                actions={identity.linked ? (
                  <Button
                    variant="danger"
                    action="unlink"
                    aria-label={`Unlink ${label} sign-in method`}
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
                  <Button
                    action="link"
                    aria-label="Link Google sign-in method"
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
          {identities === null && <OperationsItem title="Loading sign-in methods…" disabled />}
        </ItemList>
      )}
      {identities?.some((identity) => !identity.recent_authentication) && (
        <p className="text-compact text-amber-400 mt-4">
          Sign in again before linking or unlinking an identity.
        </p>
      )}
    </section>
  );
}

function DeleteAccountCard({ onDeleted }: { onDeleted: () => void }) {
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
      <p className="text-regular font-medium text-red-300 flex items-center gap-2">
        <Trash2 className="w-4 h-4" /> Delete account
      </p>
      <p className="text-compact text-zinc-400 mt-1 mb-4">
        This permanently removes your account. Passwordless accounts must have signed in within the last five minutes.
      </p>
      <div className="grid max-w-2xl grid-cols-2 gap-3 max-md:grid-cols-1">
        <Field label="Current password" hint="Optional for passwordless accounts">
          <Input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
          />
        </Field>
        <Field label="Confirmation" hint="Type DELETE to confirm">
          <Input
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            placeholder="DELETE"
          />
        </Field>
        <div className="col-span-2 flex justify-end max-md:col-span-1">
          <Button
            variant="danger"
            action="delete"
            aria-label="Permanently delete account"
            disabled={busy || confirmation !== "DELETE"}
            loading={busy}
            onClick={() => void remove()}
          />
        </div>
      </div>
    </section>
  );
}

function LegalLinks() {
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
          className="inline-flex items-center gap-1 text-compact text-zinc-400 hover:text-zinc-200"
        >
          {label} <ExternalLink className="w-3.5 h-3.5" />
        </a>
      ))}
    </div>
  );
}

function DevicesSessionsCard() {
  const [sessions, setSessions] = useState<AuthSessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      setSessions(await listAuthSessions());
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't load sessions");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function revoke(session: AuthSessionSummary) {
    setBusyId(session.session_id);
    try {
      await revokeAuthSession(session.session_id);
      toast.success("Session revoked");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't revoke session");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="border-t border-zinc-600/70 py-5">
      <div className="flex items-center gap-2 mb-3">
        <Laptop className="w-4 h-4 text-zinc-400" />
        <p className="text-regular font-medium text-zinc-200">Devices and sessions</p>
      </div>
      {loading ? (
        <p className="text-compact text-zinc-400">Loading…</p>
      ) : sessions.length === 0 ? (
        <p className="text-compact text-zinc-400">No active sessions.</p>
      ) : (
        <ItemList presentationLevel="medium" controlSize="regular">
          {sessions.map((s) => (
            <OperationsItem
              key={s.session_id}
              title={`${s.device_name || s.client}${s.current ? " · this device" : ""}`}
              trailing={<span className="text-compact text-zinc-400" title={`Last seen ${new Date(s.last_seen_at).toLocaleString()}`}>
                {new Date(s.last_seen_at).toLocaleDateString()}
              </span>}
              actions={!s.current ? (
                <Button
                  variant="ghost"
                  action="revoke"
                  aria-label={`Revoke session ${s.device_name || s.client}`}
                  loading={busyId === s.session_id}
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

function ExternalAIPermissionsCard() {
  const [consents, setConsents] = useState<StoredAIConsent[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      setConsents(await listAIConsents());
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't load AI permissions");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function revoke(c: StoredAIConsent) {
    const key = `${c.channel_id}:${c.bot_id}`;
    setBusyKey(key);
    try {
      await revokeAIConsent(c.channel_id, c.bot_id);
      toast.success("Permission revoked");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't revoke");
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <section className="border-t border-zinc-600/70 py-5">
      <div className="flex items-center gap-2 mb-3">
        <Shield className="w-4 h-4 text-zinc-400" />
        <p className="text-regular font-medium text-zinc-200">External AI permissions</p>
      </div>
      {loading ? (
        <p className="text-compact text-zinc-400">Loading…</p>
      ) : consents.length === 0 ? (
        <p className="text-compact text-zinc-400">
          No stored consents. When a bot uses an external AI processor, agreements
          appear here.
        </p>
      ) : (
        <ItemList presentationLevel="medium" controlSize="regular">
          {consents.map((c) => {
            const key = `${c.channel_id}:${c.bot_id}`;
            return (
              <OperationsItem
                key={key}
                title={`${c.bot_name}${c.provider_name ? ` · ${c.provider_name}` : ""}`}
                status={`#${c.channel_name} · policy ${c.policy_version}`}
                actions={<Button
                  controlSize="compact"
                  variant="ghost"
                  action="revoke"
                  aria-label={`Revoke external AI permission for ${c.bot_name}`}
                  loading={busyKey === key}
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

function BotsMovedCard() {
  const navigate = useNavigate();
  return (
    <div className="bg-zinc-900 rounded-sm p-6">
      <div className="flex items-center gap-2 mb-2">
        <Bot className="w-4 h-4 text-indigo-300" />
        <p className="text-regular font-medium text-zinc-200">Bots live in Fleet</p>
      </div>
      <p className="text-compact text-zinc-400 mb-4">
        Create and manage bots from Fleet — the primary home for your agent roster.
      </p>
      <Button action="open" onClick={() => navigate("/fleet")}>Open Fleet</Button>
    </div>
  );
}

/** Self-service editor for display name, status line (emoji + text), and bio. */
function ProfileEditCard() {
  const user = useAuthStore((s) => s.user);
  const setAuth = useAuthStore((s) => s.setAuth);
  const token = useAuthStore((s) => s.token);
  const [displayName, setDisplayName] = useState("");
  const [statusEmoji, setStatusEmoji] = useState("");
  const [statusText, setStatusText] = useState("");
  const [bio, setBio] = useState("");
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [copiedId, setCopiedId] = useState(false);
  const [savedProfile, setSavedProfile] = useState({
    displayName: "",
    statusEmoji: "",
    statusText: "",
    bio: "",
  });

  useEffect(() => {
    let alive = true;
    setLoadError(false);
    void getMe()
      .then((me) => {
        if (!alive) return;
        setDisplayName(me.display_name ?? "");
        setStatusEmoji(me.status_emoji ?? "");
        setStatusText(me.status_text ?? "");
        setBio(me.bio ?? "");
        setSavedProfile({
          displayName: me.display_name ?? "",
          statusEmoji: me.status_emoji ?? "",
          statusText: me.status_text ?? "",
          bio: me.bio ?? "",
        });
        setAvatarUrl(me.avatar_url ?? null);
        // Hydrate the store so the rest of the app sees the full profile.
        if (token) setAuth({ ...(user ?? { user_id: me.user_id, display_name: null }), ...me }, token);
        // Only enable Save once the real profile is in the form — a blank
        // form saved over a failed load would wipe the user's details.
        setLoaded(true);
      })
      .catch(() => {
        if (alive) setLoadError(true);
      });
    return () => {
      alive = false;
    };
    // Re-runs when the user retries; store writes here must not retrigger it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey]);

  async function save() {
    setBusy(true);
    try {
      const me = await updateMe({
        display_name: displayName.trim(),
        status_emoji: statusEmoji.trim(),
        status_text: statusText.trim(),
        bio: bio.trim(),
      });
      if (token) setAuth({ ...(user ?? { user_id: me.user_id, display_name: null }), ...me }, token);
      setSavedProfile({
        displayName: me.display_name ?? "",
        statusEmoji: me.status_emoji ?? "",
        statusText: me.status_text ?? "",
        bio: me.bio ?? "",
      });
      setEditing(false);
      toast.success("Profile saved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save profile");
    } finally {
      setBusy(false);
    }
  }

  async function handleAvatarUpload(file: File) {
    const url = await uploadUserAvatar(file);
    setAvatarUrl(url);
    // Hydrate the store so the avatar updates everywhere it's shown.
    if (token) setAuth({ ...(user ?? { user_id: "", display_name: null }), avatar_url: url }, token);
    return url;
  }

  // Load failed: don't render the editable form. Saving an empty form over a
  // profile that never hydrated would silently wipe the user's real details.
  if (loadError) {
    return (
      <div className="bg-zinc-900 rounded-sm p-6">
        <p className="text-regular font-medium text-zinc-200">Couldn't load your profile</p>
        <p className="text-compact text-zinc-400 mt-1">
          Editing is disabled until it loads so your saved details aren't
          overwritten. Check your connection and try again.
        </p>
        <div className="mt-4">
          <Button action="retry" variant="secondary" onClick={() => setReloadKey((k) => k + 1)}>
            Retry
          </Button>
        </div>
      </div>
    );
  }

  const handle = user?.username ?? user?.user_id?.slice(0, 8);

  function cancelEditing() {
    setDisplayName(savedProfile.displayName);
    setStatusEmoji(savedProfile.statusEmoji);
    setStatusText(savedProfile.statusText);
    setBio(savedProfile.bio);
    setEditing(false);
  }

  async function copyUserId() {
    if (!user?.user_id) return;
    try {
      await navigator.clipboard.writeText(user.user_id);
      setCopiedId(true);
      window.setTimeout(() => setCopiedId(false), 1500);
    } catch {
      toast.error("Clipboard unavailable — select and copy manually");
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex min-w-0 items-center gap-3 border-b border-zinc-600/70 pb-4">
        <AvatarUpload
          name={displayName || user?.username}
          id={user?.user_id}
          src={avatarUrl}
          size="regular"
          onUpload={handleAvatarUpload}
        />
        <div className="min-w-0 flex-1">
          <p className="truncate font-utility text-regular font-semibold text-zinc-100">
            {statusEmoji && <span className="mr-1">{statusEmoji}</span>}
            {displayName || user?.username || "Unknown"}
          </p>
          <p className="truncate font-utility text-compact text-zinc-400">
            @{handle}
            {statusText ? ` · ${statusText}` : ""}
          </p>
        </div>
        <InlineEditActions
          label="profile"
          editing={editing}
          saving={busy}
          disabled={!loaded}
          controlSize="regular"
          onEdit={() => setEditing(true)}
          onSave={() => void save()}
          onCancel={cancelEditing}
        />
      </div>

      {editing ? (
        <div className="space-y-4">
          <Field label="Display name" htmlFor="pf-name">
            <Input
              id="pf-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Your name"
              autoFocus
            />
          </Field>

          <Field label="Status">
            <div className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] gap-2 max-sm:grid-cols-1">
              <Input
                value={statusEmoji}
                onChange={(e) => setStatusEmoji(e.target.value)}
                placeholder="Emoji"
                maxLength={8}
                aria-label="Status emoji"
              />
              <Input
                value={statusText}
                onChange={(e) => setStatusText(e.target.value)}
                placeholder="What you're up to"
                maxLength={140}
                aria-label="Status text"
              />
            </div>
          </Field>

          <Field label="Bio" htmlFor="pf-bio">
            <Textarea
              id="pf-bio"
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              placeholder="A little about you"
              rows={3}
              className="resize-y"
            />
          </Field>
        </div>
      ) : bio ? (
        <p className="max-w-prose font-reading text-regular leading-relaxed text-zinc-200">{bio}</p>
      ) : (
        <p className="font-utility text-compact text-zinc-400">No bio added.</p>
      )}

      <div>
        <SectionHead className="mb-2">Details</SectionHead>
        <ItemList presentationLevel="medium" controlSize="regular">
          <OperationsItem
            title={
              <OverflowText fullText={`User ID: ${user?.user_id ?? "—"}`} className="w-full">
                <span className="block truncate">
                  <span className="text-zinc-400">User ID</span>
                  <code className="ml-3 font-utility text-compact font-normal text-zinc-200">
                    {user?.user_id ?? "—"}
                  </code>
                </span>
              </OverflowText>
            }
            actions={user?.user_id ? (
              <IconButton label="Copy user ID" controlSize="regular" onClick={() => void copyUserId()}>
                {copiedId ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
              </IconButton>
            ) : undefined}
          />
          <OperationsItem
            title={
              <span>
                <span className="text-zinc-400">Role</span>
                <span className="ml-3 capitalize text-zinc-200">{user?.role ?? "user"}</span>
              </span>
            }
          />
        </ItemList>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const navigate = useNavigate();
  const logout = useAuthStore((s) => s.logout);
  const setToken = useAuthStore((s) => s.setToken);
  const isAdmin = useIsAdmin();
  const params = useParams();

  const items = NAV.filter(
    (n) => (!n.adminOnly || isAdmin) && (!n.desktopOnly || isTauri())
  );

  // Section lives in the URL (/settings/:section) so reload restores it, each
  // section is deep-linkable, and Back steps between sections. Fall back to the
  // first section for an unknown or admin-gated path.
  const requested = (params["*"] ?? "").split("/")[0];
  const section: SectionId = items.some((n) => n.id === requested)
    ? (requested as SectionId)
    : "profile";

  return (
    // h-full + internal scroll: the app root is overflow-hidden, so the page must own
    // its scrolling (min-h-screen alone would clip anything taller than the viewport,
    // and h-screen=100vh overflows the 100dvh root on mobile browsers).
    <div className="h-full overflow-y-auto overscroll-contain bg-zinc-950 text-zinc-100">
      <RouteChromeHeader>
        <div className="px-6 max-md:px-4 py-5 flex items-center gap-4">
          <UiButton variant="plain"
            type="button"
            content="icon"
            controlSize="regular"
            onClick={() => navigate("/chat")}
            title="Back to chat"
            aria-label="Back to chat"
            className="text-zinc-100 hover:text-zinc-50 transition-colors rounded-sm"
          >
            <ArrowLeft className="w-5 h-5" aria-hidden="true" />
          </UiButton>
          <h1 className="text-comfortable font-semibold">Settings</h1>
        </div>
      </RouteChromeHeader>

      <div className="max-w-5xl mx-auto p-6 max-md:p-4 max-md:pb-[calc(1.5rem+env(safe-area-inset-bottom))] flex flex-col sm:flex-row gap-6">
        {/* Nav rail */}
        <nav className="flex sm:flex-col gap-1 sm:w-48 sm:shrink-0 overflow-x-auto">
          {items.map(({ id, label, icon: Icon }) => {
            const active = section === id;
            return (
              <UiButton content="iconText" variant="plain" role="tab" aria-selected={active}
                key={id}
                type="button"
                onClick={() => navigate(`/settings/${id}`)}
                aria-current={active ? "page" : undefined}
                controlSize="regular" className={`flex items-center gap-3 rounded-sm shrink-0  font-medium whitespace-nowrap transition-colors ${
 active
 ? "bg-zinc-800 text-zinc-100": "text-zinc-100 hover:bg-zinc-800 hover:text-zinc-50"
 }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                {label}
              </UiButton>
            );
          })}
        </nav>

        {/* Active section */}
        <div className="flex-1 min-w-0">
          {section === "profile" && (
            <section>
              <h2 className="text-compact font-semibold text-zinc-400 uppercase tracking-wider mb-4 flex items-center gap-2">
                <User className="w-3.5 h-3.5" />
                Profile
              </h2>

              <ProfileEditCard />
            </section>
          )}

          {section === "bots" && <BotsMovedCard />}

          {section === "server" && (
            <section>
              <h2 className="text-compact font-semibold text-zinc-400 uppercase tracking-wider mb-4">
                Server
              </h2>
              <ServerCard />
            </section>
          )}

          {section === "about" && (
            <section>
              <h2 className="text-compact font-semibold text-zinc-400 uppercase tracking-wider mb-4">
                About
              </h2>
              <AppUpdateCard />
              <LaunchAtLoginCard />
            </section>
          )}

          {/* Admin-only; each self-gates (renders null for non-admins). */}
          {section === "workbench" && <WorkbenchManager />}
          {section === "scheduled" && <ScheduledMessagesManager />}
          {section === "members" && <AdminUsers />}
          {section === "reports" && <AdminReports />}
          {section === "speech" && <AdminSttSettings />}

          {section === "account" && (
            <section>
              <h2 className="mb-5 text-compact font-semibold uppercase tracking-wider text-zinc-400">
                Account
              </h2>

              <div className="bg-zinc-900 px-6 max-md:px-4">
                <ChangePasswordCard onRotated={(token) => setToken(token)} />

                <TwoFactorCard />

                <PasskeyCard />

                <ExternalIdentitiesCard />

                <DevicesSessionsCard />

                <ExternalAIPermissionsCard />

                {/* Desktop shell: also linked from About — keep a copy here so
                    Account remains a one-stop for signed-in session controls. */}
                <AppUpdateCard />

                <PushNotificationsCard />

                <section className="border-t border-zinc-600/70 py-5">
                  <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-regular font-medium text-zinc-200">Sign out</p>
                    <p className="text-compact text-zinc-400 mt-1">
                      Revokes this session on the server and returns you to the login page.
                    </p>
                  </div>
                  <Button
                    variant="danger"
                    action="signOut"
                    aria-label="Sign out of Cheers"
                    onClick={async () => {
                      // Push first (the DELETE needs the auth token), then
                      // best-effort server revocation, then clear local state
                      // regardless — a signed-out browser must not keep
                      // receiving lock-screen notifications.
                      await disablePush().catch(() => {});
                      await logoutApi().catch(() => {});
                      logout();
                      navigate("/login", { replace: true });
                    }}
                  />
                  </div>
                </section>

                <DeleteAccountCard
                  onDeleted={() => {
                    logout();
                    navigate("/login", { replace: true });
                  }}
                />
                </div>

              <LegalLinks />
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
