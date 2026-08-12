import { Button as UiButton } from "@/components/ui/button";
import { Input as UiInput } from "@/components/ui/input";
import { useState } from "react";
import { Hash, Lock, Volume2 } from "lucide-react";
import toast from "react-hot-toast";
import { createChannel } from "@/api/channels";
import { useChatStore } from "@/stores/chatStore";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { isComposing } from "@/lib/ime";
import {
  ConversationModePicker,
  type ConversationMode,
} from "./ConversationModePicker";

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
  const [kind, setKind] = useState<"text" | "voice">("text");
  const [conversationMode, setConversationMode] = useState<ConversationMode>("chat");
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
        kind,
        conversation_mode: conversationMode,
      });
      upsertChannel(ch);
      selectChannel(ch.channel_id);
      onPicked?.();
      onClose();
    } catch (e) {
      // Surface the API's human detail (duplicate name, permission, network),
      // not raw JSON — keep the dialog open so the user can fix and retry.
      const raw = e instanceof Error ? e.message : String(e);
      let detail = raw;
      try {
        detail = (JSON.parse(raw) as { detail?: string }).detail ?? raw;
      } catch {
        /* not JSON — use raw */
      }
      toast.error(`Couldn't create channel — ${detail}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title="New channel" onClose={onClose}>
      <div className="space-y-3">
        <div className="flex items-center gap-2 rounded-sm bg-zinc-950 px-2 focus-within:ring-2 focus-within:ring-indigo-500 transition-shadow">
          <Hash className="w-3.5 h-3.5 text-zinc-500" />
          <UiInput
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !isComposing(e) && void submit()}
            placeholder="Channel name…"
            controlSize="regular" className="flex-1 bg-transparent text-sm text-zinc-200 outline-none"
          />
        </div>

        <div className="flex gap-2">
          {/* design-system-exempt: menu-option — native segmented form choice. */}
          {(["public", "private"] as const).map((t) => (
            <UiButton variant="plain"
              key={t}
              onClick={() => setType(t)}
              controlSize="regular" className={cn(
 "flex-1 flex items-center justify-center gap-1.5 rounded-sm border text-sm transition-colors",
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
            </UiButton>
          ))}
        </div>

        <div className="space-y-1.5">
          <p className="text-xs font-medium uppercase tracking-wide text-zinc-400">
            Conversation layout
          </p>
          <ConversationModePicker value={conversationMode} onChange={setConversationMode} />
        </div>

        <div className="flex gap-2">
          {/* design-system-exempt: menu-option — native segmented form choice. */}
          {(["text", "voice"] as const).map((value) => (
            <UiButton variant="plain"
              type="button"
              key={value}
              onClick={() => setKind(value)}
              controlSize="regular" className={cn(
 "flex-1 flex items-center justify-center gap-1.5 rounded-sm border text-sm transition-colors",
 kind === value
 ? "border-indigo-500 bg-indigo-500/10 text-zinc-100 hover:bg-indigo-500/15"
 : "border-zinc-800 text-zinc-400 hover:bg-zinc-800/60"
 )}
            >
              {value === "text" ? (
                <Hash className="w-3.5 h-3.5" />
              ) : (
                <Volume2 className="w-3.5 h-3.5" />
              )}
              {value === "text" ? "Text" : "Voice"}
            </UiButton>
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
