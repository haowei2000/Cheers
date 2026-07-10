import { useState } from "react";
import { Hash, Lock } from "lucide-react";
import { createChannel } from "@/api/channels";
import { useChatStore } from "@/stores/chatStore";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

// Create a channel in the given workspace, then add it to the store and select it
// (it opens in the normal chat view). Mirrors the NewDmDialog pattern.
export function NewChannelDialog({
  workspaceId,
  onClose,
  onPicked,
}: {
  workspaceId: string;
  onClose: () => void;
  /** Notified after the new channel is selected (mobile pushes the chat screen). */
  onPicked?: () => void;
}) {
  const upsertChannel = useChatStore((s) => s.upsertChannel);
  const selectChannel = useChatStore((s) => s.selectChannel);
  const [name, setName] = useState("");
  const [type, setType] = useState<"public" | "private">("public");
  const [busy, setBusy] = useState(false);

  async function submit() {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      const ch = await createChannel({
        workspace_id: workspaceId,
        name: trimmed,
        type,
      });
      upsertChannel(ch);
      selectChannel(ch.channel_id);
      onPicked?.();
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title="New channel" onClose={onClose}>
      <div className="space-y-3">
        <div className="flex items-center gap-2 rounded-lg bg-zinc-950 px-2 focus-within:ring-2 focus-within:ring-indigo-500 transition-shadow">
          <Hash className="w-3.5 h-3.5 text-zinc-500" />
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void submit()}
            placeholder="Channel name…"
            className="flex-1 bg-transparent py-2 text-sm text-zinc-200 outline-none"
          />
        </div>

        <div className="flex gap-2">
          {(["public", "private"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setType(t)}
              className={cn(
                "flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg border text-sm transition-colors",
                type === t
                  ? "border-indigo-500 bg-indigo-500/10 text-zinc-100 hover:bg-indigo-500/15"
                  : "border-zinc-800 text-zinc-400 hover:bg-zinc-800/60"
              )}
            >
              {t === "public" ? (
                <Hash className="w-3.5 h-3.5" />
              ) : (
                <Lock className="w-3.5 h-3.5" />
              )}
              {t === "public" ? "Public" : "Private"}
            </button>
          ))}
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!name.trim() || busy} onClick={() => void submit()}>
            Create
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
