import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Workspace, Channel } from "@/types";

interface ChatState {
  workspaces: Workspace[];
  /** The user's personal workspace (rendered prominently atop the rail). */
  personalWorkspace: Workspace | null;
  channels: Channel[];
  selectedWorkspaceId: string | null;
  selectedChannelId: string | null;
  /**
   * Last channel opened per workspace, persisted across reloads. Lets switching
   * workspace A→B→A restore A's open channel instead of dumping the user on the
   * empty state, and — because ChatLayout lands on the personal workspace after a
   * reload — restores that workspace's last channel on page load.
   */
  lastChannelByWorkspace: Record<string, string>;

  setWorkspaces: (ws: Workspace[]) => void;
  setPersonalWorkspace: (ws: Workspace | null) => void;
  setChannels: (ch: Channel[]) => void;
  selectWorkspace: (id: string | null) => void;
  selectChannel: (id: string | null) => void;
  patchChannel: (id: string, patch: Partial<Channel>) => void;
  /** Add a channel if absent, else patch it (used when a DM is found-or-created). */
  upsertChannel: (ch: Channel) => void;
}

export const useChatStore = create<ChatState>()(
  persist(
    (set) => ({
      workspaces: [],
      personalWorkspace: null,
      channels: [],
      selectedWorkspaceId: null,
      selectedChannelId: null,
      lastChannelByWorkspace: {},

      setWorkspaces: (ws) => set({ workspaces: ws }),
      setPersonalWorkspace: (ws) => set({ personalWorkspace: ws }),
      setChannels: (ch) => set({ channels: ch }),
      // Restore the workspace's last-opened channel (or the empty state if it has
      // none / was cleared) rather than hard-resetting to null on every switch.
      selectWorkspace: (id) =>
        set((s) => ({
          selectedWorkspaceId: id,
          selectedChannelId: id ? (s.lastChannelByWorkspace[id] ?? null) : null,
        })),
      // Remember the open channel per workspace so it survives a switch or reload;
      // clearing the channel (e.g. after one is deleted/left) forgets that memory so
      // we never restore a channel that no longer exists.
      selectChannel: (id) =>
        set((s) => {
          const wsId = s.selectedWorkspaceId;
          if (!wsId) return { selectedChannelId: id };
          const map = { ...s.lastChannelByWorkspace };
          if (id) map[wsId] = id;
          else delete map[wsId];
          return { selectedChannelId: id, lastChannelByWorkspace: map };
        }),
      patchChannel: (id, patch) =>
        set((s) => ({
          channels: s.channels.map((c) =>
            c.channel_id === id ? { ...c, ...patch } : c
          ),
        })),
      upsertChannel: (ch) =>
        set((s) =>
          s.channels.some((c) => c.channel_id === ch.channel_id)
            ? { channels: s.channels.map((c) => (c.channel_id === ch.channel_id ? { ...c, ...ch } : c)) }
            : { channels: [...s.channels, ch] }
        ),
    }),
    {
      name: "cheers.chat.selection",
      // Only the cross-session channel memory is persisted. Workspaces/channels are
      // server data refetched on mount, and the live selection is derived on load
      // (ChatLayout selects the personal workspace, which restores its last channel).
      partialize: (s) => ({ lastChannelByWorkspace: s.lastChannelByWorkspace }),
    }
  )
);
