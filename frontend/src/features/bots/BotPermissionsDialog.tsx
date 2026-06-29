import { useCallback, useEffect, useState } from "react";
import toast from "react-hot-toast";
import { ShieldCheck } from "lucide-react";
import { getBotPermissions, setBotPosture, type Posture } from "@/api/bots";
import { listChannelMembers } from "@/api/channels";
import { Dialog } from "@/components/ui/dialog";
import { BotEventAccessSection } from "./BotEventAccessSection";
import type { BotItem, Channel, MemberItem } from "@/types";

const BOT_WIDE = "";

/**
 * Bot permissions (docs/arch/ACP_EVENT_TAXONOMY.md): the agent's **posture**
 * (session mode) + the **event-access matrix** (who can INITIATE/SEE/RESPOND per
 * ACP event, by channel role with per-user overrides). The agent decides *when*
 * it asks; Cheers decides *who* can act — there is no per-tool-kind auto-answer.
 */
export function BotPermissionsDialog({
  bot,
  channels,
  onClose,
}: {
  bot: BotItem;
  channels: Channel[];
  onClose: () => void;
}) {
  const [scope, setScope] = useState<string>(BOT_WIDE); // "" = bot-wide default
  const [posture, setPosture] = useState<Posture | null>(null);
  const [members, setMembers] = useState<MemberItem[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const loadPosture = useCallback(async () => {
    const p = await getBotPermissions(bot.bot_id);
    setPosture(p.posture);
  }, [bot.bot_id]);

  const loadMembers = useCallback(async () => {
    if (!scope) {
      setMembers([]);
      return;
    }
    const m = await listChannelMembers(scope);
    setMembers(m.filter((x) => x.member_type === "user"));
  }, [scope]);

  useEffect(() => {
    Promise.all([loadPosture(), loadMembers()]).catch((e) => toast.error(String(e)));
  }, [loadPosture, loadMembers]);

  const changePosture = (mode: string) => {
    setBusy("posture");
    setBotPosture(bot.bot_id, mode)
      .then(loadPosture)
      .catch((e) => toast.error(String(e)))
      .finally(() => setBusy(null));
  };

  return (
    <Dialog
      title={
        <span className="flex items-center gap-2">
          <ShieldCheck className="w-5 h-5 text-indigo-400" />
          Permissions · {bot.display_name || bot.username}
        </span>
      }
      onClose={onClose}
      maxWidth="max-w-2xl"
    >
      <div className="space-y-4">
        {/* Scope selector */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-zinc-500">Scope</span>
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            className="rounded-lg bg-zinc-800 border border-zinc-700 px-2 py-1.5 text-xs text-zinc-200 outline-none focus:border-indigo-500/60"
          >
            <option value={BOT_WIDE}>Bot-wide default (all channels)</option>
            {channels.map((c) => (
              <option key={c.channel_id} value={c.channel_id}>
                #{c.name}
              </option>
            ))}
          </select>
          <span className="text-[11px] text-zinc-600">
            {scope
              ? "Channel-specific rules override the bot-wide default."
              : "Applies to every channel unless a channel overrides it."}
          </span>
        </div>

        {/* Posture: the agent's session mode (when does it ask?). */}
        {posture && (
          <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-3">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-medium text-zinc-300">Agent posture</span>
              {posture.allowed_modes.length > 0 ? (
                <select
                  value={posture.permission_mode ?? ""}
                  disabled={busy === "posture"}
                  onChange={(e) => changePosture(e.target.value)}
                  className="rounded-md bg-zinc-800 border border-zinc-700 px-2 py-1 text-xs text-zinc-200 outline-none focus:border-indigo-500/60 disabled:opacity-40"
                >
                  {posture.permission_mode == null && <option value="">(unset)</option>}
                  {posture.allowed_modes.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="text-[11px] text-zinc-600">
                  {posture.agent_type} advertises its own modes — no preset envelope
                </span>
              )}
              <span className="ml-auto text-[11px] text-zinc-600">
                agent: <code className="text-zinc-500">{posture.agent_type}</code>
              </span>
            </div>
            <p className="text-[11px] text-zinc-600 mt-2 leading-relaxed">
              The session mode controls <em>when the agent asks</em> (e.g.{" "}
              <code className="text-zinc-500">default</code> = prompt per tool,{" "}
              <code className="text-zinc-500">plan</code> = no execution). Pushed to the live
              connector via <code className="text-zinc-500">set_mode</code>, clamped by the host’s
              L0 allow-list.
            </p>
          </div>
        )}

        {/* Event-access matrix — the per-user authorization (the primary control). */}
        <BotEventAccessSection botId={bot.bot_id} scope={scope} members={members} />
      </div>
    </Dialog>
  );
}
