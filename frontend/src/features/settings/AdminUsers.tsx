import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { ShieldBan, ShieldCheck } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { useIsAdmin } from "@/stores/authStore";
import { searchUsers, suspendUser, unsuspendUser, type UserSearchResult } from "@/api/users";

// Admin-only: find a user and suspend/unsuspend them (W6 session revocation +
// account suspension). Renders nothing for non-admins. Search has no suspension
// status in its payload, so both actions are offered and confirmed by toast.
export function AdminUsers() {
  const isAdmin = useIsAdmin();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<UserSearchResult[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!isAdmin) return;
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      return;
    }
    const t = setTimeout(() => {
      searchUsers(q)
        .then(setResults)
        .catch(() => setResults([]));
    }, 250);
    return () => clearTimeout(t);
  }, [query, isAdmin]);

  if (!isAdmin) return null;

  async function act(u: UserSearchResult, suspend: boolean) {
    setBusy(u.user_id);
    try {
      if (suspend) await suspendUser(u.user_id);
      else await unsuspendUser(u.user_id);
      toast.success(
        suspend
          ? `已封禁 ${u.display_name || u.username}（会话已吊销）`
          : `已解封 ${u.display_name || u.username}`
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "操作失败");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section>
      <h2 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-4 flex items-center gap-2">
        <ShieldBan className="w-3.5 h-3.5" />
        用户管理（管理员）
      </h2>
      <div className="bg-zinc-900 rounded-2xl border border-zinc-800 p-6 space-y-3">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索用户名 / 显示名…"
          className="w-full rounded-lg bg-zinc-950 border border-zinc-800 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-indigo-500"
        />
        <div className="divide-y divide-zinc-800/60">
          {results.map((u) => (
            <div key={u.user_id} className="flex items-center gap-3 py-2">
              <Avatar name={u.display_name || u.username} id={u.user_id} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="text-sm text-zinc-200 truncate">
                  {u.display_name || u.username}
                </p>
                <p className="text-[11px] text-zinc-500">@{u.username}</p>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={busy === u.user_id}
                onClick={() => void act(u, false)}
              >
                <ShieldCheck className="w-3.5 h-3.5" />
                解封
              </Button>
              <Button
                variant="danger"
                size="sm"
                disabled={busy === u.user_id}
                onClick={() => void act(u, true)}
              >
                <ShieldBan className="w-3.5 h-3.5" />
                封禁
              </Button>
            </div>
          ))}
          {query.trim().length >= 2 && results.length === 0 && (
            <p className="text-xs text-zinc-600 py-3 text-center">无匹配用户</p>
          )}
        </div>
      </div>
    </section>
  );
}
