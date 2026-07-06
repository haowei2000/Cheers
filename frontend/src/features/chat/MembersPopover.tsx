import { useEffect, useState } from "react";
import { Users, Bot, Settings } from "lucide-react";
import { listChannelMembers } from "@/api/channels";
import { Avatar } from "@/components/ui/avatar";
import { useProfileCard } from "./ProfileHovercard";
import type { MemberItem } from "@/types";

/**
 * Header "Members" dropdown — the quick answer to "who is in this channel?".
 * Read-only list (avatar · name · role · liveness); management stays in
 * ChannelSettingsDialog, reachable via the footer button for non-DM channels.
 */
export function MembersPopover({
  channelId,
  isDm,
  onManage,
  onClose,
}: {
  channelId: string;
  isDm: boolean;
  onManage: () => void;
  onClose: () => void;
}) {
  const [members, setMembers] = useState<MemberItem[] | null>(null);
  const card = useProfileCard();

  useEffect(() => {
    let alive = true;
    listChannelMembers(channelId)
      .then((m) => alive && setMembers(m))
      .catch(() => alive && setMembers([]));
    return () => {
      alive = false;
    };
  }, [channelId]);

  // Close on outside click / Esc. NOT a fixed backdrop: the header's
  // backdrop-blur makes it the containing block for `fixed` descendants, which
  // would clip an overlay to the 48px header strip. Document listeners instead;
  // clicks inside the trigger+panel wrapper ([data-members-root]) are ignored so
  // toggling via the button doesn't close-then-reopen.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest("[data-members-root]")) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <>
      <div className="absolute right-0 top-9 z-50 w-72 rounded-xl border border-zinc-800 bg-zinc-900 shadow-xl overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800 bg-zinc-950/60">
          <Users className="w-3.5 h-3.5 text-zinc-500" />
          <span className="text-xs font-medium text-zinc-300">
            Members{members ? ` · ${members.length}` : ""}
          </span>
        </div>

        <div className="max-h-72 overflow-y-auto py-1">
          {members === null ? (
            <p className="px-3 py-3 text-xs text-zinc-600">Loading…</p>
          ) : members.length === 0 ? (
            <p className="px-3 py-3 text-xs text-zinc-600">No members found</p>
          ) : (
            members.map((m) => {
              const name = m.display_name || m.username || m.member_id.slice(0, 8);
              return (
                <button
                  key={m.member_id}
                  type="button"
                  onClick={(e) => card?.open(e.currentTarget, m)}
                  className="w-full flex items-center gap-2.5 px-3 py-1.5 text-left hover:bg-zinc-800/60 transition-colors"
                >
                  <div className="relative">
                    <Avatar name={name} id={m.member_id} size="sm" />
                    {m.is_online != null && (
                      <span
                        title={m.is_online ? "online" : "offline"}
                        className={`absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full border border-zinc-900 ${
                          m.is_online ? "bg-emerald-500" : "bg-zinc-600"
                        }`}
                      />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs text-zinc-200 truncate flex items-center gap-1.5">
                      {name}
                      {m.member_type === "bot" && (
                        <Bot className="w-3 h-3 text-indigo-400 flex-shrink-0" />
                      )}
                    </p>
                  </div>
                  {m.role && m.role !== "member" && (
                    <span className="text-[10px] text-zinc-500 capitalize">{m.role}</span>
                  )}
                </button>
              );
            })
          )}
        </div>

        {!isDm && (
          <button
            type="button"
            onClick={() => {
              onClose();
              onManage();
            }}
            className="w-full flex items-center gap-2 px-3 py-2 text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 border-t border-zinc-800"
          >
            <Settings className="w-3.5 h-3.5" />
            Manage members…
          </button>
        )}
      </div>
    </>
  );
}
