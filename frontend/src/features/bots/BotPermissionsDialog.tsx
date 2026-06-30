import { useCallback, useEffect, useState } from "react";
import toast from "react-hot-toast";
import { ShieldCheck } from "lucide-react";
import { getBotPermissions, setBotPosture, type Posture } from "@/api/bots";
import { Dialog } from "@/components/ui/dialog";
import { BotPermissionGrantsSection } from "./BotPermissionGrantsSection";
import { BotActivitySection } from "./BotActivitySection";
import type { BotItem, Channel } from "@/types";

/**
 * Bot permissions (docs/arch/ACP_EVENT_TAXONOMY.md), permission-FIRST: the agent's
 * posture (session mode), then a permission list — pick a permission to see/edit
 * every authorization domain (user / role / group) that holds it — plus the live
 * ACP activity timeline. Scope is chosen per-grant, not page-wide.
 */
export function BotPermissionsDialog({
  bot,
  onClose,
}: {
  bot: BotItem;
  channels: Channel[];
  onClose: () => void;
}) {
  const [posture, setPosture] = useState<Posture | null>(null);
  const [busy, setBusy] = useState(false);

  const loadPosture = useCallback(async () => {
    const p = await getBotPermissions(bot.bot_id);
    setPosture(p.posture);
  }, [bot.bot_id]);

  useEffect(() => {
    loadPosture().catch((e) => toast.error(String(e)));
  }, [loadPosture]);

  const changePosture = (mode: string) => {
    setBusy(true);
    setBotPosture(bot.bot_id, mode)
      .then(loadPosture)
      .catch((e) => toast.error(String(e)))
      .finally(() => setBusy(false));
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
        {/* Posture: the agent's session mode (when does it ask?). */}
        {posture && (
          <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-3">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-medium text-zinc-300">Agent posture</span>
              {posture.allowed_modes.length > 0 ? (
                <select
                  value={posture.permission_mode ?? ""}
                  disabled={busy}
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

        {/* Permission-first authorization: permission → its grants (domains). */}
        <BotPermissionGrantsSection botId={bot.bot_id} />

        {/* Recent ACP activity — the complete event timeline (read-only). */}
        <BotActivitySection botId={bot.bot_id} />
      </div>
    </Dialog>
  );
}
