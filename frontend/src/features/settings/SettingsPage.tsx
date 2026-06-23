import { useNavigate } from "react-router-dom";
import { ArrowLeft, User } from "lucide-react";
import { useAuthStore } from "@/stores/authStore";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { BotsManager } from "@/features/bots/BotsManager";
import { WorkbenchManager } from "@/features/workbench/WorkbenchManager";

export default function SettingsPage() {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);

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

      <div className="max-w-2xl mx-auto p-6 space-y-8">
        {/* Profile */}
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

        {/* Bots */}
        <BotsManager />

        {/* Workbench extensions (admin-only; renders null otherwise) */}
        <WorkbenchManager />

        {/* Danger zone */}
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
      </div>
    </div>
  );
}
