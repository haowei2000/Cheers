import { useEffect, useState } from "react";
import { Bot, Search, User } from "lucide-react";
import { createDm } from "@/api/channels";
import { searchUsers, type UserSearchResult } from "@/api/users";
import { listBots } from "@/api/bots";
import { useChatStore } from "@/stores/chatStore";
import { Dialog } from "@/components/ui/dialog";
import type { BotItem } from "@/types";

// Start a DM: pick a user (search) or a bot. find-or-create on the backend → the dm
// channel is upserted into the store and selected (it opens in the normal chat view,
// since a DM is just a type='dm' channel).
export function NewDmDialog({ onClose }: { onClose: () => void }) {
  const upsertChannel = useChatStore((s) => s.upsertChannel);
  const selectChannel = useChatStore((s) => s.selectChannel);
  const [q, setQ] = useState("");
  const [users, setUsers] = useState<UserSearchResult[]>([]);
  const [bots, setBots] = useState<BotItem[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    listBots().then(setBots).catch(() => {});
  }, []);

  useEffect(() => {
    if (!q.trim()) {
      setUsers([]);
      return;
    }
    let alive = true;
    searchUsers(q.trim())
      .then((u) => alive && setUsers(u))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [q]);

  const open = async (
    target: { target_user_id?: string; target_bot_id?: string },
    name: string
  ) => {
    setBusy(true);
    try {
      const dm = await createDm(target);
      upsertChannel({ ...dm, peer_name: name }); // label the nameless dm channel
      selectChannel(dm.channel_id);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title="发起私信" onClose={onClose}>
      <>
        <div className="flex items-center gap-2 rounded-lg bg-zinc-950 border border-zinc-800 px-2">
          <Search className="w-3.5 h-3.5 text-zinc-500" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索用户…"
            className="flex-1 bg-transparent py-2 text-sm text-zinc-200 outline-none"
          />
        </div>
        <div className="max-h-72 overflow-auto space-y-0.5">
          {users.map((u) => (
            <button
              key={u.user_id}
              disabled={busy}
              onClick={() => void open({ target_user_id: u.user_id }, u.display_name || u.username)}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-zinc-800 text-left text-sm text-zinc-200 disabled:opacity-50"
            >
              <User className="w-3.5 h-3.5 text-zinc-500 flex-shrink-0" />
              <span className="truncate">{u.display_name || u.username}</span>
            </button>
          ))}
          {bots.length > 0 && (
            <div className="px-2 pt-2 text-[10px] uppercase tracking-wider text-zinc-600">Bots</div>
          )}
          {bots.map((b) => (
            <button
              key={b.bot_id}
              disabled={busy}
              onClick={() => void open({ target_bot_id: b.bot_id }, b.display_name || b.username)}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-zinc-800 text-left text-sm text-zinc-200 disabled:opacity-50"
            >
              <Bot className="w-3.5 h-3.5 text-indigo-400 flex-shrink-0" />
              <span className="truncate">{b.display_name || b.username}</span>
            </button>
          ))}
        </div>
      </>
    </Dialog>
  );
}
