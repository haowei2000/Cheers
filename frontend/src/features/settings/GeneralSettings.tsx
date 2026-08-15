import { useEffect, useState } from "react";
import { Bell, Palette } from "lucide-react";
import toast from "react-hot-toast";
import { ActionButton } from "@/components/ui/action-button";
import { SettingsCard, SettingsSection } from "@/components/ui/settings-card";
import { ThemeSelector } from "@/components/ui/theme-selector";
import { useAuthStore } from "@/stores/authStore";
import { disablePush, enablePush, getPushStatus, type PushStatus } from "@/lib/push";
import { getServerBase, isTauri, setServerBase } from "@/lib/serverConfig";
import {
  getAutostart,
  setAutostart,
  checkAppUpdate,
  installAppUpdate,
  type AppUpdate,
} from "@/lib/desktop";

export function AppearanceCard() {
  return (
    <SettingsSection title="Appearance" icon={Palette}>
      <SettingsCard
        title="Color theme"
        description="Follow your device automatically or keep a fixed appearance on this device."
      >
        <ThemeSelector />
      </SettingsCard>
    </SettingsSection>
  );
}

/** Current API base + switch (Tauri). Web shows the origin when same-origin. */
export function ServerCard() {
  const logout = useAuthStore((s) => s.logout);
  const base = isTauri() ? getServerBase() : window.location.origin;
  return (
    <SettingsCard
      className="mt-4"
      title="Server"
      description={
        <>
          <span className="block truncate">{base ?? "same origin"}</span>
          {!isTauri() && (
            <span className="mt-2 block">
              Web clients use this origin. Switch servers from the desktop app or by
              opening a different gateway URL.
            </span>
          )}
        </>
      }
      actions={
        isTauri() ? (
          <ActionButton action="switch" context="settings"
            accessibleLabel="Switch server"
            controlSize="compact"
            onClick={() => {
              // Order matters: drop the session first (the token belongs to the
              // old server), then clear the base — reload lands on the picker.
              logout();
              setServerBase(null);
              window.location.reload();
            }}
          />
        ) : undefined
      }
    />
  );
}

/** Desktop shell only: register the app as a macOS login item, so the tray and
 * local installation supervisor are available after sign-in. */
export function LaunchAtLoginCard() {
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
    <SettingsCard
      className="mt-4"
      title="Launch at login"
      description="Start Cheers and keep local bot installations available when you sign in to your Mac."
      actions={
        <ActionButton action={enabled ? "disable" : "enable"} context="settings"
          accessibleLabel={`${enabled ? "Turn off" : "Turn on"} launch at login`}
          controlSize="compact"
          disabled={busy || enabled === null}
          onClick={() => void toggle()}
        />
      }
    />
  );
}

/** Desktop shell only: check the signed release feed and install in place.
 * Checks once on mount so a stale build surfaces without the user going
 * looking; the install itself is always an explicit click. */
export function AppUpdateCard() {
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
          <p className="text-regular font-medium text-content-secondary">App updates</p>
          <p className="text-compact text-content-muted mt-1">
            {currentVersion ? `Installed ${currentVersion}. ` : null}
            {update
              ? `Version ${update.version} is available — installing restarts Cheers.`
              : "Check GitHub for a newer signed desktop build."}
          </p>
        </div>
        {update ? (
          <ActionButton
            action="restart"
            context="settings"
            accessibleLabel="Install update and restart Cheers"
            loading={installing}
            onClick={() => void install()}
          />
        ) : (
          <ActionButton
            action="check"
            context="settings"
            accessibleLabel="Check for Cheers updates"
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
export function PushNotificationsCard() {
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
          <p className="text-regular font-medium text-content-secondary flex items-center gap-2">
            <Bell className="w-4 h-4 text-accent-400" /> Push notifications
          </p>
          <p className="text-compact text-content-muted mt-1">
            Approval requests and @mentions reach this device even when Cheers
            isn't open.
            {status === "denied" &&
              " Currently blocked in your browser's site settings."}
          </p>
        </div>
        <ActionButton
          action={enabled ? "disable" : "enable"}
          context="settings"
          accessibleLabel={`${enabled ? "Turn off" : "Turn on"} push notifications`}
          loading={busy || status === "loading"}
          disabled={busy || status === "loading"}
          onClick={() => void toggle()}
        />
      </div>
    </section>
  );
}

