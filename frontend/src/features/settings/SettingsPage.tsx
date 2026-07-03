import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, User, Bot, Blocks, Users, LogOut, KeyRound, AudioLines } from "lucide-react";
import toast from "react-hot-toast";
import { useAuthStore, useIsAdmin } from "@/stores/authStore";
import { changePassword, logout as logoutApi } from "@/api/auth";
import { Avatar } from "@/components/ui/avatar";
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

  const inputCls =
    "w-full rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-indigo-500/60";
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

export default function SettingsPage() {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const setToken = useAuthStore((s) => s.setToken);
  const isAdmin = useIsAdmin();
  const [section, setSection] = useState<SectionId>("profile");

  const items = NAV.filter((n) => !n.adminOnly || isAdmin);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      {/* Header */}
      <div className="border-b border-zinc-800 px-6 py-4 flex items-center gap-4">
        <button
          type="button"
          onClick={() => navigate(-1)}
          title="Back"
          className="text-zinc-500 hover:text-zinc-200 transition-colors"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h1 className="text-lg font-semibold">Settings</h1>
      </div>

      <div className="max-w-5xl mx-auto p-6 flex flex-col sm:flex-row gap-6">
        {/* Nav rail */}
        <nav className="flex sm:flex-col gap-1 sm:w-48 sm:shrink-0 overflow-x-auto">
          {items.map(({ id, label, icon: Icon }) => {
            const active = section === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setSection(id)}
                className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors ${
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

              <div className="bg-zinc-900 rounded-2xl border border-zinc-800 p-6 space-y-4">
                <div className="flex items-center gap-4">
                  <Avatar
                    name={user?.display_name ?? user?.username}
                    id={user?.user_id}
                    size="lg"
                  />
                  <div>
                    <p className="font-semibold text-zinc-100">
                      {user?.display_name ?? user?.username ?? "Unknown"}
                    </p>
                    <p
                      className="text-sm text-zinc-500"
                      title={!user?.username && user?.user_id ? user.user_id : undefined}
                    >
                      @{user?.username ?? user?.user_id?.slice(0, 8)}
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3 pt-2">
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
