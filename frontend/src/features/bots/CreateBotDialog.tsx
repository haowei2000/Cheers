import { useState } from "react";
import { Bot, Loader2 } from "lucide-react";
import { createBot } from "@/api/bots";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { messageOf } from "@/lib/notify";
import type { BotItem } from "@/types";

export function CreateBotDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (bot: BotItem) => void;
}) {
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const normalized = username.trim();
    if (!normalized) {
      setError("Username is required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const bot = await createBot({
        username: normalized,
        display_name: displayName.trim() || undefined,
      });
      onCreated(bot);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={<span className="flex items-center gap-2"><Bot className="h-5 w-5 text-accent-400" />Create bot</span>}
      onClose={onClose}
      maxWidth="max-w-lg"
    >
      <div className="space-y-4">
        <div className="rounded-sm bg-indigo-950/35 px-3 py-3 text-compact text-accent-100">
          A bot is a durable identity. Creating it does not create an installation or start an agent.
        </div>
        {error && <p className="text-compact text-danger-400 break-words">{error}</p>}
        <div>
          <label className="mb-1 block text-compact font-medium uppercase tracking-label text-content-muted">Username</label>
          <Input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="research-assistant" controlSize="regular" />
        </div>
        <div>
          <label className="mb-1 block text-compact font-medium uppercase tracking-label text-content-muted">Display name</label>
          <Input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Research Assistant" controlSize="regular" />
        </div>
        <div className="flex justify-end gap-2">
          <Button action="cancel" variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button action="create" onClick={() => void submit()} disabled={busy || !username.trim()}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}Create bot
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
