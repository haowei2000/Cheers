import { Input as UiInput } from "@/components/ui/input";
import { useState } from "react";
import { createWorkspace } from "@/api/workspaces";
import { useChatStore } from "@/stores/chatStore";
import { Dialog } from "@/components/ui/dialog";
import { isComposing } from "@/lib/ime";
import { Field } from "@/components/ui/field";
import { ActionButton } from "@/components/ui/action-button";

// Create a team workspace, add it to the rail, and switch to it.
export function NewWorkspaceDialog({ onClose }: { onClose: () => void }) {
  const workspaces = useChatStore((s) => s.workspaces);
  const setWorkspaces = useChatStore((s) => s.setWorkspaces);
  const selectWorkspace = useChatStore((s) => s.selectWorkspace);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const ws = await createWorkspace(trimmed);
      setWorkspaces([...workspaces, ws]);
      selectWorkspace(ws.workspace_id);
      onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Couldn't create workspace");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title="New workspace" onClose={onClose} dirty={Boolean(name.trim())} busy={busy}>
      <div className="space-y-3">
        <Field label="Workspace name" htmlFor="workspace-name" error={error}>
        <UiInput id="workspace-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !isComposing(e) && void submit()}
          placeholder="Workspace name…"
          controlSize="regular"
          disabled={busy}
          aria-invalid={Boolean(error)}
        />
        </Field>
        <div className="flex justify-end gap-2 pt-1">
          <ActionButton action="cancel" context="dialog" disabled={busy} onClick={onClose} />
          <ActionButton action="create" context="form" loading={busy} disabled={!name.trim()} onClick={() => void submit()} />
        </div>
      </div>
    </Dialog>
  );
}
