import { Button as UiButton } from "@/components/ui/button";
import { Input as UiInput } from "@/components/ui/input";
import { Select as UiSelect } from "@/components/ui/select";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import toast from "react-hot-toast";
import { ShieldBan, ShieldCheck, UserPlus, Trash2, RefreshCw } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { EntityItem, ItemList } from "@/components/ui/item";
import { useIsAdmin } from "@/stores/authStore";
import {
  listUsers,
  createUser,
  deleteUser,
  suspendUser,
  unsuspendUser,
  type AdminUser,
} from "@/api/users";

// Human-readable role names — never surface the raw enum token (e.g. `system_admin`).
const ROLE_LABELS: Record<string, string> = {
  system_admin: "System admin",
  admin: "Admin",
  owner: "Owner",
  member: "Member",
  readonly: "Read-only",
};
function roleLabel(role: string): string {
  return (
    ROLE_LABELS[role] ??
    role.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

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
      <h2 className="text-compact font-semibold text-zinc-400 uppercase tracking-wider mb-4 flex items-center gap-2">
        <ShieldBan className="w-3.5 h-3.5" />
        User management (admin)
        <UiButton variant="plain"
          type="button"
          onClick={() => load(filter)}
          className="ml-auto text-zinc-500 hover:text-zinc-300"
          title="Refresh"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
        </UiButton>
      </h2>

      <CreateUserForm onCreated={() => load(filter)} />

      <div className="bg-zinc-900 rounded-sm p-6 mt-4 space-y-3">
        <UiInput
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by name / username / email…"
          controlSize="regular" className="rounded-sm bg-zinc-800 text-regular text-zinc-200 focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
        <ItemList presentationLevel="medium" controlSize="regular">
          {users.map((u) => (
            <EntityItem
              key={u.user_id}
              title={<span title={[u.display_name || u.username, `@${u.username}`, u.email].filter(Boolean).join(" · ")}>
                {u.display_name || u.username} · @{u.username}
              </span>}
              leading={<Avatar name={u.display_name || u.username} id={u.user_id} size="regular" />}
              status={u.role !== "member" ? <span className="text-minimal text-zinc-400">{roleLabel(u.role)}</span> : undefined}
              criticalStatus={u.is_suspended ? <span className="rounded-sm bg-red-950/60 px-1 py-1 text-minimal text-red-300">suspended</span> : undefined}
              actions={<>{u.is_suspended ? (
                <Button
                  variant="secondary"
                  controlSize="compact"
                  disabled={busy === u.user_id}
                  onClick={() => void act(u, "unsuspend")}
                >
                  <ShieldCheck className="w-3.5 h-3.5" />
                  Unsuspend
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  controlSize="compact"
                  disabled={busy === u.user_id}
                  onClick={() => void act(u, "suspend")}
                >
                  <ShieldBan className="w-3.5 h-3.5" />
                  Suspend
                </Button>
              )}
              <Button
                variant="danger"
                controlSize="compact"
                disabled={busy === u.user_id}
                onClick={() => void act(u, "delete")}
                title="Delete user"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
              </>}
              className="border-0"
            />
          ))}
          {!loading && users.length === 0 && (
            <p className="text-compact text-zinc-400 py-3 text-center">No users.</p>
          )}
        </ItemList>
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
    if (!username.trim() || password.length < 12) {
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

  return (
    <form onSubmit={submit} className="bg-zinc-900 rounded-sm p-6">
      <p className="text-regular font-medium text-zinc-200 flex items-center gap-2 mb-3">
        <UserPlus className="w-4 h-4 text-indigo-400" /> Add user
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <UiInput
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="Username"
        />
        <UiInput
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="Display name (optional)"
        />
        <UiInput
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Email (optional)"
          type="email"
        />
        <UiInput
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Temporary password (min 12)"
          type="password"
          autoComplete="new-password"
        />
        <UiSelect value={role} onChange={(e) => setRole(e.target.value)}>
          <option value="member">{roleLabel("member")}</option>
          <option value="admin">{roleLabel("admin")}</option>
        </UiSelect>
        <div className="flex items-end">
          <Button type="submit" disabled={busy}>
            {busy ? "Creating…" : "Create user"}
          </Button>
        </div>
      </div>
    </form>
  );
}
