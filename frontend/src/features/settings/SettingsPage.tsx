import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, User, Bot, Blocks, Users, LogOut } from "lucide-react";
import { useAuthStore, useIsAdmin } from "@/stores/authStore";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { BotsManager } from "@/features/bots/BotsManager";
import { WorkbenchManager } from "@/features/workbench/WorkbenchManager";
import { AdminUsers } from "./AdminUsers";

type SectionId = "profile" | "bots" | "workbench" | "members" | "account";

const NAV: { id: SectionId; label: string; icon: typeof User; adminOnly?: boolean }[] = [
  { id: "profile", label: "Profile", icon: User },
  { id: "bots", label: "Bots", icon: Bot },
  { id: "workbench", label: "Workbench", icon: Blocks, adminOnly: true },
  { id: "members", label: "Members", icon: Users, adminOnly: true },
  { id: "account", label: "Account", icon: LogOut },
];

export default function SettingsPage() {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const isAdmin = useIsAdmin();
  const [section, setSection] = useState<SectionId>("profile");

  const items = NAV.filter((n) => !n.adminOnly || isAdmin);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      {/* Header */}
      <div className="border-b border-zinc-800 px-6 py-4 flex items-center gap-4">
        <button
          onClick={() => navigate(-1)}
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
                    <p className="text-sm text-zinc-500">
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

          {section === "account" && (
            <section>
              <h2 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-4">
                Account
              </h2>
              <div className="bg-zinc-900 rounded-2xl border border-zinc-800 p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-zinc-200">Sign out</p>
                    <p className="text-xs text-zinc-500 mt-0.5">
                      You will be redirected to the login page.
                    </p>
                  </div>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => {
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
