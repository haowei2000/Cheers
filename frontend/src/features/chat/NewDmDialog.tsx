import { Button as UiButton } from "@/components/ui/button";
import { SearchInput } from "@/components/ui/search-input";
import { useEffect, useRef, useState } from "react";
import { Bot, User, X } from "lucide-react";
import toast from "react-hot-toast";
import { createDm } from "@/api/channels";
import { searchUsers, type UserSearchResult } from "@/api/users";
import { listBots } from "@/api/bots";
import { useChatStore } from "@/stores/chatStore";
import { Dialog } from "@/components/ui/dialog";
import { ItemList, NavigationItem } from "@/components/ui/item";
import type { BotItem } from "@/types";

// Start a DM: pick a user (search) or a bot. find-or-create on the backend → the dm
// channel is upserted into the store and selected (it opens in the normal chat view,
// since a DM is just a type='dm' channel).
export function NewDmDialog({
  onClose,
  onPicked,
}: {
  onClose: () => void;
  /** Notified after the dm channel is selected (mobile pushes the chat screen). */
  onPicked?: () => void;
}) {
  const upsertChannel = useChatStore((s) => s.upsertChannel);
  const selectChannel = useChatStore((s) => s.selectChannel);
  const [q, setQ] = useState("");
  const [users, setUsers] = useState<UserSearchResult[]>([]);
  const [bots, setBots] = useState<BotItem[]>([]);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

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
      onPicked?.();
      onClose();
    } catch (e) {
      // Surface the API's human detail (permission, network), not raw JSON —
      // keep the dialog open so the user knows the DM didn't open.
      const raw = e instanceof Error ? e.message : String(e);
      let detail = raw;
      try {
        detail = (JSON.parse(raw) as { detail?: string }).detail ?? raw;
      } catch {
        /* not JSON — use raw */
      }
      toast.error(`Couldn't start direct message — ${detail}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title="New direct message" onClose={onClose}>
      <>
        <div className="flex items-center gap-2">
          <SearchInput
            ref={inputRef}
            containerClassName="flex-1"
            aria-label="Search users"
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search users…"
            controlSize="regular"
          />
          {q && (
            <UiButton variant="plain"
              type="button"
              content="icon"
              controlSize="compact"
              aria-label="Clear search"
              onClick={() => {
                setQ("");
                inputRef.current?.focus();
              }}
              className="rounded-sm text-content-primary hover:text-content-strong hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 transition-colors"
            >
              <X className="w-4 h-4" />
            </UiButton>
          )}
        </div>
        <ItemList presentationLevel="medium" controlSize="regular" className="max-h-72 overflow-auto">
          {users.map((u) => (
            <NavigationItem
              key={u.user_id}
              disabled={busy}
              onClick={() => void open({ target_user_id: u.user_id }, u.display_name || u.username)}
              title={u.display_name || u.username}
              leading={<User className="w-3.5 h-3.5 text-content-muted flex-shrink-0" />}
              className="border-0"
            />
          ))}
          {bots.length > 0 && (
            <div className="px-2 pt-2 text-minimal uppercase tracking-label text-content-muted">Bots</div>
          )}
          {bots.map((b) => (
            <NavigationItem
              key={b.bot_id}
              disabled={busy}
              onClick={() => void open({ target_bot_id: b.bot_id }, b.display_name || b.username)}
              title={b.display_name || b.username}
              leading={<Bot className="w-3.5 h-3.5 text-accent-400 flex-shrink-0" />}
              status={<span className="text-minimal text-accent-300">BOT</span>}
              className="border-0"
            />
          ))}
        </ItemList>
      </>
    </Dialog>
  );
}
