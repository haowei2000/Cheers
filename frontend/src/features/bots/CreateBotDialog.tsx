import { useId, useState } from "react";
import { Bot } from "lucide-react";
import { createBot } from "@/api/bots";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { messageOf } from "@/lib/notify";
import type { BotItem } from "@/types";
import { botUsernameError } from "./botUsername";

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
  // Only after the field has been left or submitted: complaining about "r" while
  // someone types "research-assistant" is noise, not help.
  const [touched, setTouched] = useState(false);
  const usernameId = useId();
  const displayNameId = useId();

  const usernameProblem = botUsernameError(username);
  const showUsernameProblem = touched && usernameProblem !== null && username.trim() !== "";

  async function submit() {
    const normalized = username.trim();
    if (usernameProblem) {
      setTouched(true);
      setError(usernameProblem);
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
          A bot is a durable identity — an agent only runs once a device is connected to it.
          Next you'll pick that device; you can close that step and connect one later.
        </div>
        {error && <p className="text-compact text-danger-400 break-words">{error}</p>}
        <Field
          label="Username"
          htmlFor={usernameId}
          hint={
            showUsernameProblem ? (
              <span className="text-danger-400">{usernameProblem}</span>
            ) : (
              "Used as @mention and as the connector's account id — letters, digits, hyphen, underscore."
            )
          }
        >
          <Input
            id={usernameId}
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            onBlur={() => setTouched(true)}
            placeholder="research-assistant"
            controlSize="regular"
            error={showUsernameProblem}
            aria-invalid={showUsernameProblem || undefined}
          />
        </Field>
        <Field label="Display name" htmlFor={displayNameId}>
          <Input id={displayNameId} value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Research Assistant" controlSize="regular" />
        </Field>
        <div className="flex justify-end gap-2">
          <Button action="cancel" variant="secondary" onClick={onClose} disabled={busy} />
          <Button action="create" onClick={() => void submit()} disabled={busy || usernameProblem !== null} loading={busy} />
        </div>
      </div>
    </Dialog>
  );
}
