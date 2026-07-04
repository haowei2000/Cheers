import { create } from "zustand";
import type { Workspace, Channel } from "@/types";

interface ChatState {
  workspaces: Workspace[];
  /** The user's personal workspace (rendered prominently atop the rail). */
  personalWorkspace: Workspace | null;
  channels: Channel[];
  selectedWorkspaceId: string | null;
  selectedChannelId: string | null;

  setWorkspaces: (ws: Workspace[]) => void;
  setPersonalWorkspace: (ws: Workspace | null) => void;
  setChannels: (ch: Channel[]) => void;
  selectWorkspace: (id: string | null) => void;
  selectChannel: (id: string | null) => void;
  patchChannel: (id: string, patch: Partial<Channel>) => void;
  /** Add a channel if absent, else patch it (used when a DM is found-or-created). */
  upsertChannel: (ch: Channel) => void;
}

export const useChatStore = create<ChatState>()((set) => ({
  workspaces: [],
  personalWorkspace: null,
  channels: [],
  selectedWorkspaceId: null,
  selectedChannelId: null,

  setWorkspaces: (ws) => set({ workspaces: ws }),
  setPersonalWorkspace: (ws) => set({ personalWorkspace: ws }),
  setChannels: (ch) => set({ channels: ch }),
  selectWorkspace: (id) =>
    set({ selectedWorkspaceId: id, selectedChannelId: null }),
  selectChannel: (id) => set({ selectedChannelId: id }),
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
}));
