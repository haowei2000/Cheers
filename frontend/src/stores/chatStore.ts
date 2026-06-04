import { create } from "zustand";
import type { Workspace, Channel } from "@/types";

interface ChatState {
  workspaces: Workspace[];
  channels: Channel[];
  selectedWorkspaceId: string | null;
  selectedChannelId: string | null;

  setWorkspaces: (ws: Workspace[]) => void;
  setChannels: (ch: Channel[]) => void;
  selectWorkspace: (id: string | null) => void;
  selectChannel: (id: string | null) => void;
  patchChannel: (id: string, patch: Partial<Channel>) => void;
}

export const useChatStore = create<ChatState>()((set) => ({
  workspaces: [],
  channels: [],
  selectedWorkspaceId: null,
  selectedChannelId: null,

  setWorkspaces: (ws) => set({ workspaces: ws }),
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
}));
