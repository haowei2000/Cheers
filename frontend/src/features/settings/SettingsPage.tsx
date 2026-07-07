import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, User, Bot, Blocks, Users, LogOut, KeyRound, AudioLines } from "lucide-react";
import toast from "react-hot-toast";
import { useAuthStore, useIsAdmin } from "@/stores/authStore";
import { changePassword, logout as logoutApi } from "@/api/auth";
import { getMe, updateMe } from "@/api/users";
import { uploadUserAvatar } from "@/api/avatars";
import { AvatarUpload } from "@/components/ui/AvatarUpload";
import { Button } from "@/components/ui/button";
import { BotsManager } from "@/features/bots/BotsManager";
import { WorkbenchManager } from "@/features/workbench/WorkbenchManager";
import { AdminUsers } from "./AdminUsers";
import { AdminSttSettings } from "./AdminSttSettings";

type SectionId = "profile" | "bots" | "workbench" | "members" | "speech" | "account";

const NAV: { id: SectionId; label: string; icon: typeof User; adminOnly?: boolean }[] = [
  { id: "profile", label: "Profile", icon: User },
  { id: "bots", label: "Bots", icon: Bot },
  { id: "workbench", label: "Workbench", icon: Blocks, adminOnly: true },
  { id: "members", label: "Members", icon: Users, adminOnly: true },
  { id: "speech", label: "Speech-to-text", icon: AudioLines, adminOnly: true },
  { id: "account", label: "Account", icon: LogOut },
];

function ChangePasswordCard({ onRotated }: { onRotated: (token: string) => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (next.length < 8) {
      toast.error("New password must be at least 8 characters");
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
    "w-full rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2 text-base md:text-sm text-zinc-100 outline-none focus:border-indigo-500/60";
  return (
    <div className="bg-zinc-900 rounded-2xl border border-zinc-800 p-6">
      <p className="text-sm font-medium text-zinc-200 flex items-center gap-2 mb-1">
        <KeyRound className="w-4 h-4 text-indigo-400" /> Change password
      </p>
      <p className="text-xs text-zinc-500 mb-4">
        Updating your password signs out every other device.
      </p>
      <div className="grid gap-3 max-w-sm">
        <input
          type="password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          placeholder="Current password"
          autoComplete="current-password"
          className={inputCls}
        />
        <input
          type="password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          placeholder="New password (min 8 characters)"
          autoComplete="new-password"
          className={inputCls}
        />
        <input
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void submit()}
          placeholder="Confirm new password"
          autoComplete="new-password"
          className={inputCls}
        />
        <div>
          <button
            onClick={() => void submit()}
            disabled={busy || !current || !next}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-40 transition-colors"
          >
            {busy ? "Saving…" : "Update password"}
          </button>
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
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
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
      })
      .catch(() => {})
      .finally(() => alive && setLoaded(true));
    // Load once on mount; store writes here must not retrigger it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => {
      alive = false;
    };
  }, []);

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

  const inputCls =
    "w-full rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-indigo-500/60";

  return (
    <div className="bg-zinc-900 rounded-2xl border border-zinc-800 p-6 space-y-4">
      <div className="flex items-center gap-4">
        <AvatarUpload
          name={displayName || user?.username}
          id={user?.user_id}
          src={avatarUrl}
          size="lg"
          onUpload={handleAvatarUpload}
        />
        <div className="min-w-0">
          <p className="font-semibold text-zinc-100 truncate">
            {statusEmoji && <span className="mr-1">{statusEmoji}</span>}
            {displayName || user?.username || "Unknown"}
          </p>
          <p className="text-sm text-zinc-500 truncate">
            {statusText || `@${user?.username ?? user?.user_id?.slice(0, 8)}`}
          </p>
        </div>
      </div>

      <div className="grid gap-3">
        <label className="text-xs font-medium text-zinc-500 uppercase tracking-wide">
          Display name
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Your name"
            className={`${inputCls} mt-1 normal-case font-normal tracking-normal`}
          />
        </label>

        <div>
          <label className="text-xs font-medium text-zinc-500 uppercase tracking-wide">Status</label>
          <div className="flex gap-2 mt-1">
            <input
              value={statusEmoji}
              onChange={(e) => setStatusEmoji(e.target.value)}
              placeholder="🟢"
              maxLength={8}
              className={`${inputCls} w-16 text-center`}
              aria-label="Status emoji"
            />
            <input
              value={statusText}
              onChange={(e) => setStatusText(e.target.value)}
              placeholder="What you're up to (e.g. focusing, on vacation)"
              maxLength={140}
              className={inputCls}
              aria-label="Status text"
            />
          </div>
        </div>

        <label className="text-xs font-medium text-zinc-500 uppercase tracking-wide">
          Bio
          <textarea
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            placeholder="A little about you"
            rows={3}
            className={`${inputCls} mt-1 normal-case font-normal tracking-normal resize-y`}
          />
        </label>
      </div>

      <div>
        <button
          onClick={() => void save()}
          disabled={busy || !loaded}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-40 transition-colors"
        >
          {busy ? "Saving…" : "Save profile"}
        </button>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const setToken = useAuthStore((s) => s.setToken);
  const isAdmin = useIsAdmin();
  const [section, setSection] = useState<SectionId>("profile");

  const items = NAV.filter((n) => !n.adminOnly || isAdmin);

  return (
    // h-full + internal scroll: the app root is overflow-hidden, so the page must own
    // its scrolling (min-h-screen alone would clip anything taller than the viewport,
    // and h-screen=100vh overflows the 100dvh root on mobile browsers).
    <div className="h-full overflow-y-auto overscroll-contain bg-zinc-950 text-zinc-100">
      {/* Header */}
      <div className="border-b border-zinc-800 px-6 max-md:px-4 py-4 flex items-center gap-4">
        <button
          type="button"
          onClick={() => navigate(-1)}
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
                onClick={() => setSection(id)}
                className={`flex items-center gap-2.5 rounded-lg px-3 py-2 max-md:py-2.5 shrink-0 text-sm font-medium whitespace-nowrap transition-colors ${
                  active
                    ? "bg-zinc-800 text-zinc-100"
                    : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
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
              <h2 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-4 flex items-center gap-2">
                <User className="w-3.5 h-3.5" />
                Profile
              </h2>

              <ProfileEditCard />

              <div className="bg-zinc-900 rounded-2xl border border-zinc-800 p-6 mt-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-medium text-zinc-500 uppercase tracking-wide block mb-1">
                      User ID
                    </label>
                    <code className="text-xs text-zinc-400 bg-zinc-800 px-2 py-1 rounded block truncate">
                      {user?.user_id ?? "—"}
                    </code>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-zinc-500 uppercase tracking-wide block mb-1">
                      Role
                    </label>
                    <span className="text-xs text-zinc-400 capitalize">
                      {user?.role ?? "user"}
                    </span>
                  </div>
                </div>
              </div>
            </section>
          )}

          {section === "bots" && <BotsManager />}

          {/* Admin-only; each self-gates (renders null for non-admins). */}
          {section === "workbench" && <WorkbenchManager />}
          {section === "members" && <AdminUsers />}
          {section === "speech" && <AdminSttSettings />}

          {section === "account" && (
            <section>
              <h2 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-4">
                Account
              </h2>

              <ChangePasswordCard onRotated={(token) => setToken(token)} />

              <div className="bg-zinc-900 rounded-2xl border border-zinc-800 p-6 mt-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-zinc-200">Sign out</p>
                    <p className="text-xs text-zinc-500 mt-0.5">
                      Revokes this session on the server and returns you to the login page.
                    </p>
                  </div>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={async () => {
                      // Best-effort server revocation, then clear local state regardless.
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
