import { useState } from "react";
import { createWorkspace } from "@/api/workspaces";
import { useChatStore } from "@/stores/chatStore";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { isComposing } from "@/lib/ime";

// Create a team workspace, add it to the rail, and switch to it.
export function NewWorkspaceDialog({ onClose }: { onClose: () => void }) {
  const workspaces = useChatStore((s) => s.workspaces);
  const setWorkspaces = useChatStore((s) => s.setWorkspaces);
  const selectWorkspace = useChatStore((s) => s.selectWorkspace);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      const ws = await createWorkspace(trimmed);
      setWorkspaces([...workspaces, ws]);
      selectWorkspace(ws.workspace_id);
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title="New workspace" onClose={onClose}>
      <div className="space-y-3">
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !isComposing(e) && void submit()}
          placeholder="Workspace name…"
          className="w-full rounded-lg bg-zinc-800 px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
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
