import { InputWithLeadingIcon } from "@/components/ui/input-with-leading-icon";
import { useState } from "react";
import { Hash, Lock, Volume2 } from "lucide-react";
import toast from "react-hot-toast";
import { createChannel } from "@/api/channels";
import { useChatStore } from "@/stores/chatStore";
import { Dialog } from "@/components/ui/dialog";
import { ActionButton } from "@/components/ui/action-button";
import { ChoiceGroup } from "@/components/ui/choice-button";
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
        <InputWithLeadingIcon
          leading={<Hash />}
          aria-label="Channel name"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !isComposing(e) && void submit()}
          placeholder="Channel name…"
          controlSize="regular"
        />

        <ChoiceGroup
          ariaLabel="Channel visibility"
          value={type}
          onChange={setType}
          options={[
            { value: "public", label: "Public", leading: <Hash /> },
            { value: "private", label: "Private", leading: <Lock /> },
          ]}
        />

        <div className="space-y-2">
          <p className="text-compact font-medium uppercase tracking-label text-content-muted">
            Conversation layout
          </p>
          <ConversationModePicker value={conversationMode} onChange={setConversationMode} />
        </div>

        <ChoiceGroup
          ariaLabel="Channel kind"
          value={kind}
          onChange={setKind}
          options={[
            { value: "text", label: "Text", leading: <Hash /> },
            { value: "voice", label: "Voice", leading: <Volume2 /> },
          ]}
        />

        <div className="flex justify-end gap-2 pt-1">
          <ActionButton action="cancel" context="dialog" onClick={onClose} />
          <ActionButton
            action="create"
            context="form"
            disabled={!name.trim() || busy}
            loading={busy}
            onClick={() => void submit()}
          />
        </div>
      </div>
    </Dialog>
  );
}
