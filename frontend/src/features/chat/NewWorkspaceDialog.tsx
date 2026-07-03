import { useState } from "react";
import { createWorkspace } from "@/api/workspaces";
import { useChatStore } from "@/stores/chatStore";
import { Dialog } from "@/components/ui/dialog";

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
          onKeyDown={(e) => e.key === "Enter" && void submit()}
          placeholder="Workspace name…"
          className="w-full rounded-lg bg-zinc-950 border border-zinc-800 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-indigo-500"
        />
        <div className="flex justify-end gap-2 pt-1">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-lg text-sm text-zinc-400 hover:bg-zinc-800 transition-colors"
          >
            Cancel
          </button>
          <button
            disabled={!name.trim() || busy}
            onClick={() => void submit()}
            className="px-4 py-1.5 rounded-lg bg-indigo-600 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50 transition-colors"
          >
            Create
          </button>
        </div>
      </div>
    </Dialog>
  );
}
