import { useId, useState } from "react";
import { BotIcon } from "@/components/ui/editorial-icons";
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
  const [username, setUsername] = useState(() => `assistant-${crypto.randomUUID().slice(0, 8)}`);
  const [displayName, setDisplayName] = useState("My assistant");
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
      title={<span className="flex items-center gap-2"><BotIcon contentSize="large" className="text-accent-400" />Create bot</span>}
      onClose={onClose}
      maxWidth="max-w-lg"
    >
      <div className="space-y-4">
        {error && <p className="text-body-error" role="alert">{error}</p>}
        <Field label="Bot name" htmlFor={displayNameId} hint="Choose a name. Next, connect your agent and project on the computer that will run this bot.">
          <Input id={displayNameId} value={displayName} onChange={(event) => setDisplayName(event.target.value)} controlSize="regular" />
        </Field>
        <details>
          <summary className="cursor-pointer text-body-secondary">Customize the @mention username</summary>
        <Field
          label="Username"
          htmlFor={usernameId}
          error={showUsernameProblem ? usernameProblem : undefined}
          hint="Used as @mention and as the connector's account id — letters, digits, hyphen, underscore."
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
        </details>
        <div className="flex justify-end gap-2">
          <Button action="cancel" variant="secondary" onClick={onClose} disabled={busy} />
          <Button action="create" onClick={() => void submit()} disabled={busy || usernameProblem !== null} loading={busy} />
        </div>
      </div>
    </Dialog>
  );
}
