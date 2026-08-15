import { useCallback, useEffect, useState, type FormEvent } from "react";
import toast from "react-hot-toast";
import {
  Check,
  Loader2,
  RefreshCw,
  ShieldBan,
  ShieldCheck,
  Trash2,
  UserPlus,
  X,
} from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { CollectionEmptyItem, CollectionManager } from "@/components/ui/collection-manager";
import { Field } from "@/components/ui/field";
import { IconButton } from "@/components/ui/icon-button";
import { EntityItem } from "@/components/ui/item";
import { Input } from "@/components/ui/input";
import { OverflowText } from "@/components/ui/overflow-text";
import { Select } from "@/components/ui/select";
import { useIsAdmin } from "@/stores/authStore";
import {
  listUsers,
  createUser,
  deleteUser,
  suspendUser,
  unsuspendUser,
  type AdminUser,
} from "@/api/users";

const ROLE_LABELS: Record<string, string> = {
  system_admin: "System admin",
  admin: "Admin",
  owner: "Owner",
  member: "Member",
  readonly: "Read-only",
};

function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role.replace(/_/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

export function AdminUsers() {
  const isAdmin = useIsAdmin();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(
    (query?: string) => {
      if (!isAdmin) return;
      setLoading(true);
      listUsers(query)
        .then(setUsers)
        .catch((error) => toast.error(error instanceof Error ? error.message : "Failed to load users"))
        .finally(() => setLoading(false));
    },
    [isAdmin],
  );

  useEffect(() => {
    const timeout = window.setTimeout(() => load(filter), 250);
    return () => window.clearTimeout(timeout);
  }, [filter, load]);

  if (!isAdmin) return null;

  async function setSuspended(user: AdminUser, suspended: boolean) {
    setBusy(user.user_id);
    try {
      if (suspended) await suspendUser(user.user_id);
      else await unsuspendUser(user.user_id);
      toast.success(suspended ? "Suspended (sessions revoked)" : "Unsuspended");
      load(filter);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Action failed");
    } finally {
      setBusy(null);
    }
  }

  async function remove(user: AdminUser) {
    setBusy(user.user_id);
    try {
      await deleteUser(user.user_id);
      toast.success("User deleted");
      setDeletingId(null);
      load(filter);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Action failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section>
      <CollectionManager
        label="Members"
        count={users.length}
        query={filter}
        onQueryChange={setFilter}
        searchPlaceholder="Search members"
        addLabel="Add member"
        onAdd={() => setAdding(true)}
        addDisabled={adding}
        headerAction={(
          <IconButton
            label="Refresh members"
            controlSize="regular"
            disabled={loading}
            onClick={() => load(filter)}
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </IconButton>
        )}
        presentationLevel="medium"
        controlSize="regular"
        className="space-y-1"
      >
        {adding && (
          <CreateUserItem
            onCancel={() => setAdding(false)}
            onCreated={() => {
              setAdding(false);
              load(filter);
            }}
          />
        )}

        {users.map((user) => {
          const name = user.display_name || user.username;
          const deleting = deletingId === user.user_id;
          return (
            <EntityItem
              key={user.user_id}
              title={<OverflowText fullText={`${name} · @${user.username}`}>{name}</OverflowText>}
              subtitle={[`@${user.username}`, user.email].filter(Boolean).join(" · ")}
              leading={<Avatar name={name} id={user.user_id} size="regular" />}
              status={user.role !== "member" ? <span className="text-content-muted">{roleLabel(user.role)}</span> : undefined}
              criticalStatus={(
                deleting ? (
                  <span className="font-utility text-compact font-semibold uppercase tracking-label text-danger-400">Delete?</span>
                ) : user.is_suspended ? (
                  <span className="font-utility text-compact font-semibold uppercase tracking-label text-danger-400">Suspended</span>
                ) : undefined
              )}
              actions={deleting ? (
                <>
                  <IconButton label={`Cancel deleting ${name}`} controlSize="regular" onClick={() => setDeletingId(null)}>
                    <X className="h-4 w-4" />
                  </IconButton>
                  <IconButton
                    label={`Delete ${name}`}
                    tone="danger"
                    controlSize="regular"
                    disabled={busy === user.user_id}
                    onClick={() => void remove(user)}
                  >
                    {busy === user.user_id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                  </IconButton>
                </>
              ) : (
                <>
                  <IconButton
                    label={user.is_suspended ? `Unsuspend ${name}` : `Suspend ${name}`}
                    tone={user.is_suspended ? "success" : "neutral"}
                    controlSize="regular"
                    disabled={busy === user.user_id}
                    onClick={() => void setSuspended(user, !user.is_suspended)}
                  >
                    {busy === user.user_id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : user.is_suspended ? (
                      <ShieldCheck className="h-4 w-4" />
                    ) : (
                      <ShieldBan className="h-4 w-4" />
                    )}
                  </IconButton>
                  <IconButton
                    label={`Delete ${name}`}
                    tone="danger"
                    controlSize="regular"
                    disabled={busy === user.user_id}
                    onClick={() => setDeletingId(user.user_id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </IconButton>
                </>
              )}
            />
          );
        })}

        {!loading && users.length === 0 && (
          <CollectionEmptyItem query={filter} onClear={() => setFilter("")} />
        )}
      </CollectionManager>
    </section>
  );
}

function CreateUserItem({ onCreated, onCancel }: { onCreated: () => void; onCancel: () => void }) {
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("member");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!username.trim() || password.length < 12) {
      toast.error("Username and a 12+ character password are required");
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
      onCreated();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to create user");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      role="listitem"
      data-collection-mode="add"
      onSubmit={submit}
      className="border-b border-zinc-600/70 px-2 py-3"
    >
      <div className="mb-2 flex h-9 items-center gap-2">
        <UserPlus className="h-4 w-4 text-content-muted" />
        <span className="min-w-0 flex-1 font-utility text-regular font-semibold text-content-primary">New member</span>
        <IconButton label="Cancel adding member" controlSize="regular" disabled={busy} onClick={onCancel}>
          <X className="h-4 w-4" />
        </IconButton>
        <IconButton label="Create member" tone="success" controlSize="regular" type="submit" disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
        </IconButton>
      </div>

      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        <Field label="Username" htmlFor="admin-new-username">
          <Input
            id="admin-new-username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            autoFocus
          />
        </Field>
        <Field label="Display name" htmlFor="admin-new-display-name">
          <Input
            id="admin-new-display-name"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </Field>
        <Field label="Email" htmlFor="admin-new-email">
          <Input
            id="admin-new-email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            type="email"
            autoComplete="email"
          />
        </Field>
        <Field label="Temporary password" hint="At least 12 characters" htmlFor="admin-new-password">
          <Input
            id="admin-new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            type="password"
            autoComplete="new-password"
          />
        </Field>
        <Field label="Role" htmlFor="admin-new-role" className="sm:col-span-2">
          <Select id="admin-new-role" value={role} onChange={(event) => setRole(event.target.value)}>
            <option value="member">{roleLabel("member")}</option>
            <option value="admin">{roleLabel("admin")}</option>
          </Select>
        </Field>
      </div>
    </form>
  );
}
