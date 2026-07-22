import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, User, Bot, Blocks, Users, LogOut, KeyRound, AudioLines, Bell, Plug, ShieldAlert } from "lucide-react";
import toast from "react-hot-toast";
import { useAuthStore, useIsAdmin } from "@/stores/authStore";
import { changePassword, logout as logoutApi } from "@/api/auth";
import { disablePush, enablePush, getPushStatus, type PushStatus } from "@/lib/push";
import { getServerBase, isTauri, setServerBase } from "@/lib/serverConfig";
import {
  getAutostart,
  setAutostart,
  checkAppUpdate,
  installAppUpdate,
  type AppUpdate,
} from "@/lib/desktop";
import { ConnectorManager } from "@/features/desktop/ConnectorManager";
import { getMe, updateMe } from "@/api/users";
import { uploadUserAvatar } from "@/api/avatars";
import { AvatarUpload } from "@/components/ui/AvatarUpload";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field, SectionHead, MetaRow } from "@/components/ui/field";
import { BotsManager } from "@/features/bots/BotsManager";
import { CopyButton } from "@/features/bots/BotDetailPanel";
import { WorkbenchManager } from "@/features/workbench/WorkbenchManager";
import { AdminUsers } from "./AdminUsers";
import { AdminSttSettings } from "./AdminSttSettings";
import { AdminReports } from "./AdminReports";

type SectionId =
  | "profile"
  | "bots"
  | "connector"
  | "workbench"
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
  { id: "connector", label: "Connector", icon: Plug, desktopOnly: true },
  { id: "workbench", label: "Workbench", icon: Blocks, adminOnly: true },
  { id: "members", label: "Members", icon: Users, adminOnly: true },
  { id: "speech", label: "Speech-to-text", icon: AudioLines, adminOnly: true },
  { id: "reports", label: "Safety reports", icon: ShieldAlert, adminOnly: true },
  { id: "account", label: "Account", icon: LogOut },
];

/** Desktop shell only: which Cheers server this app talks to. Switching
 * clears the session (tokens are per-server) and reboots into the picker. */
function ServerCard() {
  const logout = useAuthStore((s) => s.logout);
  if (!isTauri()) return null;
  const base = getServerBase();
  return (
    <div className="bg-zinc-900 rounded-2xl p-6 mt-4">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-zinc-200">Server</p>
          <p className="text-xs text-zinc-400 mt-0.5 truncate">
            {base ?? "same origin"}
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
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
      </div>
    </div>
  );
}

/** Desktop shell only: register the app as a macOS login item, so the tray
 * resident (and its connector supervisor) is there from boot. */
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
    <div className="bg-zinc-900 rounded-2xl p-6 mt-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-zinc-200">Launch at login</p>
          <p className="text-xs text-zinc-400 mt-0.5">
            Start Cheers (tray + connector supervisor) when you sign in to your Mac.
          </p>
        </div>
        <Button
          variant={enabled ? "secondary" : "primary"}
          size="sm"
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

  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
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
    <div className="bg-zinc-900 rounded-2xl p-6 mt-4">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-zinc-200">App updates</p>
          <p className="text-xs text-zinc-400 mt-0.5">
            {update
              ? `Version ${update.version} is available — installing restarts Cheers.`
              : "Cheers checks for a new version each time you open Settings."}
          </p>
        </div>
        {update ? (
          <Button
            variant="primary"
            size="sm"
            disabled={installing}
            onClick={() => void install()}
          >
            {installing ? "Installing…" : "Update & restart"}
          </Button>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            disabled={checking}
            onClick={() => void check()}
          >
            {checking ? "Checking…" : "Check now"}
          </Button>
        )}
      </div>
    </div>
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
    <div className="bg-zinc-900 rounded-2xl p-6 mt-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-zinc-200 flex items-center gap-2">
            <Bell className="w-4 h-4 text-indigo-400" /> Push notifications
          </p>
          <p className="text-xs text-zinc-400 mt-0.5">
            Approval requests and @mentions reach this device even when Cheers
            isn't open.
            {status === "denied" &&
              " Currently blocked in your browser's site settings."}
          </p>
        </div>
        <Button
          variant={enabled ? "secondary" : "primary"}
          size="sm"
          disabled={busy || status === "loading"}
          onClick={() => void toggle()}
        >
          {status === "loading" ? "…" : enabled ? "Turn off" : "Turn on"}
        </Button>
      </div>
    </div>
  );
}

function ChangePasswordCard({ onRotated }: { onRotated: (token: string) => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
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
      const res = await changePassword({ current_password: current, new_password: next });
      onRotated(res.access_token); // keep this session alive on the fresh token
      setCurrent("");
      setNext("");
      setConfirm("");
      toast.success("Password changed — other sessions were signed out");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to change password");
    } finally {
      setBusy(false);
    }
  }

  // text-base (16px) below md prevents iOS Safari's auto-zoom on focus.
  const inputCls =
    "w-full rounded-lg bg-zinc-800 px-3 py-2 text-base md:text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-indigo-500";
  return (
    <div className="bg-zinc-900 rounded-2xl p-6">
      <p className="text-sm font-medium text-zinc-200 flex items-center gap-2 mb-1">
        <KeyRound className="w-4 h-4 text-indigo-400" /> Change password
      </p>
      <p className="text-xs text-zinc-400 mb-4">
        Updating your password signs out every other device.
      </p>
      <div className="grid gap-3 max-w-sm">
        <div className="space-y-1.5">
          <label
            htmlFor="cp-current"
            className="block text-xs font-medium text-zinc-400 uppercase tracking-wide"
          >
            Current password
          </label>
          <input
            id="cp-current"
            type="password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            autoComplete="current-password"
            className={inputCls}
          />
        </div>
        <div className="space-y-1.5">
          <label
            htmlFor="cp-new"
            className="block text-xs font-medium text-zinc-400 uppercase tracking-wide"
          >
            New password
          </label>
          <input
            id="cp-new"
            type="password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            placeholder="At least 8 characters"
            autoComplete="new-password"
            className={inputCls}
          />
        </div>
        <div className="space-y-1.5">
          <label
            htmlFor="cp-confirm"
            className="block text-xs font-medium text-zinc-400 uppercase tracking-wide"
          >
            Confirm new password
          </label>
          <input
            id="cp-confirm"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void submit()}
            autoComplete="new-password"
            className={inputCls}
          />
        </div>
        <div>
          <Button onClick={() => void submit()} disabled={busy || !current || !next}>
            {busy ? "Saving…" : "Update password"}
          </Button>
        </div>
      </div>
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
      <div className="bg-zinc-900 rounded-xl p-6">
        <p className="text-sm font-medium text-zinc-200">Couldn't load your profile</p>
        <p className="text-xs text-zinc-400 mt-1">
          Editing is disabled until it loads so your saved details aren't
          overwritten. Check your connection and try again.
        </p>
        <div className="mt-4">
          <Button variant="secondary" onClick={() => setReloadKey((k) => k + 1)}>
            Retry
          </Button>
        </div>
      </div>
    );
  }

  const handle = user?.username ?? user?.user_id?.slice(0, 8);

  return (
    // One card with three clearly spaced regions: identity header, form, and details.
    <div className="bg-zinc-900 rounded-xl p-5 space-y-7">
      {/* Identity header — the avatar is the upload entry; this doubles as a
          live preview, so no separate preview block above the form. */}
      <div className="flex items-center gap-4">
        <AvatarUpload
          name={displayName || user?.username}
          id={user?.user_id}
          src={avatarUrl}
          size="lg"
          onUpload={handleAvatarUpload}
        />
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-zinc-100 truncate">
            {statusEmoji && <span className="mr-1">{statusEmoji}</span>}
            {displayName || user?.username || "Unknown"}
          </p>
          <p className="text-sm text-zinc-400 truncate">
            @{handle}
            {statusText ? ` · ${statusText}` : ""}
          </p>
        </div>
      </div>

      <div className="space-y-4">
        <Field label="Display name" htmlFor="pf-name">
          <Input
            id="pf-name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Your name"
          />
        </Field>

        <Field label="Status">
          <div className="flex gap-2">
            <Input
              value={statusEmoji}
              onChange={(e) => setStatusEmoji(e.target.value)}
              placeholder="🟢"
              maxLength={8}
              className="w-16 text-center"
              aria-label="Status emoji"
            />
            <Input
              value={statusText}
              onChange={(e) => setStatusText(e.target.value)}
              placeholder="What you're up to (e.g. focusing, on vacation)"
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

        <Button onClick={() => void save()} disabled={busy || !loaded}>
          {busy ? "Saving…" : "Save profile"}
        </Button>
      </div>

      <div className="space-y-3">
        <SectionHead>Details</SectionHead>
        <MetaRow label="User ID">
          <code className="flex-1 truncate rounded bg-zinc-800 px-2 py-1 text-zinc-400">
            {user?.user_id ?? "—"}
          </code>
          {user?.user_id && <CopyButton value={user.user_id} label="" />}
        </MetaRow>
        <MetaRow label="Role">
          <span className="capitalize text-zinc-300">{user?.role ?? "user"}</span>
        </MetaRow>
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
      {/* Header */}
      <div className="px-6 max-md:px-4 py-5 flex items-center gap-4">
        <button
          type="button"
          // Always return to the chat home, not the previous history entry — the
          // in-page section nav pushes /settings/:section entries, so navigate(-1)
          // would step through those (or leave the app on a fresh load) instead of
          // leaving Settings. Matches FriendsPage's back button.
          onClick={() => navigate("/chat")}
          title="Back"
          className="text-zinc-500 hover:text-zinc-200 transition-colors p-2 -m-2 rounded-lg"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h1 className="text-lg font-semibold">Settings</h1>
      </div>

      <div className="max-w-5xl mx-auto p-6 max-md:p-4 max-md:pb-[calc(1.5rem+env(safe-area-inset-bottom))] flex flex-col sm:flex-row gap-6">
        {/* Nav rail */}
        <nav className="flex sm:flex-col gap-1 sm:w-48 sm:shrink-0 overflow-x-auto">
          {items.map(({ id, label, icon: Icon }) => {
            const active = section === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => navigate(`/settings/${id}`)}
                aria-current={active ? "page" : undefined}
                className={`flex items-center gap-2.5 rounded-lg px-3 py-2 max-md:py-2.5 shrink-0 text-sm font-medium whitespace-nowrap transition-colors ${
                  active
                    ? "bg-zinc-800 text-zinc-100"
                    : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                {label}
              </button>
            );
          })}
        </nav>

        {/* Active section */}
        <div className="flex-1 min-w-0">
          {section === "profile" && (
            <section>
              <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-4 flex items-center gap-2">
                <User className="w-3.5 h-3.5" />
                Profile
              </h2>

              <ProfileEditCard />
            </section>
          )}

          {section === "bots" && <BotsManager />}

          {section === "connector" && <ConnectorManager />}

          {/* Admin-only; each self-gates (renders null for non-admins). */}
          {section === "workbench" && <WorkbenchManager />}
          {section === "members" && <AdminUsers />}
          {section === "reports" && <AdminReports />}
          {section === "speech" && <AdminSttSettings />}

          {section === "account" && (
            <section>
              <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-4">
                Account
              </h2>

              <ChangePasswordCard onRotated={(token) => setToken(token)} />

              <ServerCard />

              <LaunchAtLoginCard />

              <AppUpdateCard />

              <PushNotificationsCard />

              <div className="bg-zinc-900 rounded-2xl p-6 mt-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-zinc-200">Sign out</p>
                    <p className="text-xs text-zinc-400 mt-0.5">
                      Revokes this session on the server and returns you to the login page.
                    </p>
                  </div>
                  <Button
                    variant="danger"
                    size="sm"
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
                  >
                    Sign out
                  </Button>
                </div>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
