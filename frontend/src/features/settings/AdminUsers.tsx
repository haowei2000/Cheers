import { useCallback, useEffect, useState, type FormEvent } from "react";
import toast from "react-hot-toast";
import { ShieldBan, ShieldCheck, UserPlus, Trash2, RefreshCw } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { useIsAdmin } from "@/stores/authStore";
import {
  listUsers,
  createUser,
  deleteUser,
  suspendUser,
  unsuspendUser,
  type AdminUser,
} from "@/api/users";

// Admin-only: provision + moderate human accounts. Lists the directory (filterable),
// creates new users, and suspends / unsuspends / deletes them. Renders nothing for
// non-admins. Uses the admin `/users` endpoint (not friends/search, which is id-only).
export function AdminUsers() {
  const isAdmin = useIsAdmin();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(
    (q?: string) => {
      if (!isAdmin) return;
      setLoading(true);
      listUsers(q)
        .then(setUsers)
        .catch((e) => toast.error(e instanceof Error ? e.message : "Failed to load users"))
        .finally(() => setLoading(false));
    },
    [isAdmin]
  );

  useEffect(() => {
    const t = setTimeout(() => load(filter), 250);
    return () => clearTimeout(t);
  }, [filter, load]);

  if (!isAdmin) return null;

  async function act(u: AdminUser, action: "suspend" | "unsuspend" | "delete") {
    if (
      action === "delete" &&
      !window.confirm(`Delete ${u.display_name || u.username}? This can't be undone.`)
    )
      return;
    setBusy(u.user_id);
    try {
      if (action === "suspend") await suspendUser(u.user_id);
      else if (action === "unsuspend") await unsuspendUser(u.user_id);
      else await deleteUser(u.user_id);
      toast.success(
        action === "suspend"
          ? "Suspended (sessions revoked)"
          : action === "unsuspend"
            ? "Unsuspended"
            : "User deleted"
      );
      load(filter);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section>
      <h2 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-4 flex items-center gap-2">
        <ShieldBan className="w-3.5 h-3.5" />
        User management (admin)
        <button
          type="button"
          onClick={() => load(filter)}
          className="ml-auto text-zinc-500 hover:text-zinc-300"
          title="Refresh"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
        </button>
      </h2>

      <CreateUserForm onCreated={() => load(filter)} />

      <div className="bg-zinc-900 rounded-2xl p-6 mt-4 space-y-3">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by name / username / email…"
          className="w-full rounded-lg bg-zinc-800 px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
        <div className="divide-y divide-zinc-800/60">
          {users.map((u) => (
            <div key={u.user_id} className="flex items-center gap-3 py-2">
              <Avatar name={u.display_name || u.username} id={u.user_id} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="text-sm text-zinc-200 truncate flex items-center gap-2">
                  {u.display_name || u.username}
                  {u.role !== "member" && (
                    <span className="text-[10px] text-zinc-500">
                      {u.role}
                    </span>
                  )}
                  {u.is_suspended && (
                    <span className="text-[10px] px-1 py-0.5 rounded bg-red-950/60 text-red-300">
                      suspended
                    </span>
                  )}
                </p>
                <p className="text-[11px] text-zinc-500 truncate">
                  @{u.username}
                  {u.email ? ` · ${u.email}` : ""}
                </p>
              </div>
              {u.is_suspended ? (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy === u.user_id}
                  onClick={() => void act(u, "unsuspend")}
                >
                  <ShieldCheck className="w-3.5 h-3.5" />
                  Unsuspend
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy === u.user_id}
                  onClick={() => void act(u, "suspend")}
                >
                  <ShieldBan className="w-3.5 h-3.5" />
                  Suspend
                </Button>
              )}
              <Button
                variant="danger"
                size="sm"
                disabled={busy === u.user_id}
                onClick={() => void act(u, "delete")}
                title="Delete user"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
            </div>
          ))}
          {!loading && users.length === 0 && (
            <p className="text-xs text-zinc-600 py-3 text-center">No users.</p>
          )}
        </div>
      </div>
    </section>
  );
}

function CreateUserForm({ onCreated }: { onCreated: () => void }) {
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("member");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!username.trim() || password.length < 8) {
      toast.error("Username and an 8+ character password are required");
      return;
    }
    setBusy(true);
    try {
      await createUser({
        username: username.trim(),
        password,
        display_name: displayName.trim() || undefined,
        email: email.trim() || undefined,
        role,
      });
      toast.success(`Created @${username.trim()}`);
      setUsername("");
      setDisplayName("");
      setEmail("");
      setPassword("");
      setRole("member");
      onCreated();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to create user");
    } finally {
      setBusy(false);
    }
  }

  const inputCls =
    "rounded-lg bg-zinc-800 px-3 py-2 text-base md:text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-indigo-500";
  return (
    <form onSubmit={submit} className="bg-zinc-900 rounded-2xl p-6">
      <p className="text-sm font-medium text-zinc-200 flex items-center gap-2 mb-3">
        <UserPlus className="w-4 h-4 text-indigo-400" /> Add user
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="Username"
          className={inputCls}
        />
        <input
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="Display name (optional)"
          className={inputCls}
        />
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Email (optional)"
          type="email"
          className={inputCls}
        />
        <input
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Temporary password (min 8)"
          type="password"
          autoComplete="new-password"
          className={inputCls}
        />
        <select value={role} onChange={(e) => setRole(e.target.value)} className={inputCls}>
          <option value="member">member</option>
          <option value="admin">admin</option>
        </select>
        <div className="flex items-end">
          <Button type="submit" disabled={busy}>
            {busy ? "Creating…" : "Create user"}
          </Button>
        </div>
      </div>
    </form>
  );
}
